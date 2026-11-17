# AI Interaction Hub

**ChatGPT → AIR → Codex** のやり取りを、iPhoneで閲覧するためのローカルファーストなリッチ会話ビューアです。初期版はCloudflare・OpenAI API・ChatGPT履歴の自動同期を使用しません。入力は引き続きChatGPTアプリで行います。

## 現在できること

- **AI Task Monitor「依頼原文」タブ**：登録済みの全チャットからAIへの委任依頼（`chatgpt` / `delegation`）を一覧表示し、**1タップで保存した原文全文**を表示。Codex・Museを既存`source`または`metadata.target_ai`等から区別し、チャット別フィルタ、直接リンク（`/#request/<seq>`）、原文コピー、Markdown表示切替、初回・追記・再試行の関連記録を提供。記録されていない送信は表示できず、AIへの到達を証明するものではありません。
- 元の「会話履歴」タブはそのまま維持。
- ChatGPTが明示的に登録したユーザー発言、ChatGPT本文、Codexへの**送信プロンプト全文**、Codexの**可視返答全文**を、発言者別の時系列で表示
- Markdown、表、コードのシンタックスハイライト、KaTeX数式、コピー、原文全文の展開。HTTPSではClipboard API、Tailnet内HTTPではコピーイベントに原文を渡すフォールバックを利用。コピーできないブラウザでは手動選択ダイアログと改行コードを厳密に保持するTXT保存を提供（手動テキスト選択は改行が正規化される場合があります）
- 独立したSQLite（WAL）に保存。重複イベントIDは冪等、異なる内容のID衝突は拒否
- 一覧・全文の読み取りだけをWeb APIに提供。HTTP POSTでの書き込みは拒否
- スマートフォン対応画面。4.5秒おきに表示を更新（ChatGPTの記録操作そのものは自動ではない）

**制約**：ChatGPT公式iPhoneアプリの内部表示コンポーネント、画像の非公開バイナリや全チャット履歴を直接自動取得できるという意味ではありません。ChatGPTから実際に登録した情報だけが表示されます。UI独自のリッチコンポーネントは、取得できた構造化データだけ別カラムに保存します。Codexの内部推論は収集・表示しません。

## セットアップ（AIRコンテナ）

Python 3.12以上、Node.js 20以上が必要です。

```sh
cd /workspace/ai-interaction-hub
npm ci
npm run vendor
python3 -m unittest discover -s tests -v
python3 hub_app.py serve --host 127.0.0.1 --port 18777
```

初期データディレクトリは `/workspace/ai-interaction-hub-data`（作成時モード700）。`AI_HUB_DATA_DIR` で変更できます。ここにあるDBと実会話データは**このPublicリポジトリに入れない**でください。データのバックアップは停止時にSQLiteファイルを退避するかSQLite Online Backup APIを使用してください。

## ChatGPTが実際の発言・Codexプロンプトを保存する手順

GitHubのPublicリポジトリではなく、既存の**ChatGPT → Secure MCP Tunnel → AIR Desktop Commander MCP**のファイル操作で文章をAIR内の一時ファイルに正確に書き込み、同じ環境のCLIから取り込みます。

```sh
cd /workspace/ai-interaction-hub
python3 hub_app.py session --id project-001 --title '実際の開発セッション'
python3 hub_app.py add --session project-001 --author user --event-id user-001 --file /workspace/ai-interaction-hub-data/user-input.txt
python3 hub_app.py add --session project-001 --author chatgpt --kind delegation --source chatgpt-to-codex-cli --event-id prompt-001 --file /workspace/ai-interaction-hub-data/full-codex-prompt.txt
python3 hub_app.py add --session project-001 --author codex --kind result --source codex-cli --event-id result-001 --file /workspace/ai-interaction-hub-data/codex-return.txt
python3 hub_app.py add --session project-001 --author chatgpt --event-id chatgpt-001 --file /workspace/ai-interaction-hub-data/chatgpt-output.md
```

`--file -` とするとUTF-8標準入力を受け取ります。文章をシェル文字列へ直接埋め込まず、必ずファイルを経由してください。テキストは16MiB/イベント上限で、超えた場合は黙って省略せずエラーにします。

必要なら `--rich-file /path/to/blocks.json` と `--metadata-file /path/to/metadata.json` で構造化要素・モデルや推論強度などを添付します。ChatGPT側で取得できない構造要素は架空に作りません。モデルの内部推論やAPI非公開コンテンツは記録しません。

## 記録メタデータの推奨例

依頼を追加する際の `--metadata-file` には、必要に応じて `{"target_ai":"Muse","task_id":"project-X","delegation_group":"project-X-muse-1","revision_type":"followup"}` のように記録します。後から推定した値を実送信の証拠として扱わないでください。初回と追記・再試行を同じグループにする場合は `delegation_group`、または共通 `task_id` を使用します。グループ情報がない過去の依頼は独立した1件として表示されます。

## Web API

- `GET /api/delegations?limit=40&before=<seq>&session=<session_id>`：チャット横断の依頼一覧。本文はプレビューのみで全文を返さない
- `GET /api/delegations/<seq>`：記録した依頼原文全文と関連依頼
- `GET /healthz`
- `GET /api/sessions`
- `GET /api/sessions/{id}/events?after=0&limit=200` （`limit` 最大500、続きは最後の`seq`を`after`に指定）
- `POST` は不可。外部認証のない書き込みAPIは用意していません。

## iPhoneからのアクセス（2026-11-18更新）

- Tailnetに参加済みのiPhoneでTailscaleを有効にして、**https://<your-hub-node>.<your-tailnet>.ts.net/**（実際のURLはTailscale Serveで確認） を開きます。AI Task Monitorの「依頼原文」から登録済みの依頼を選び、全文を閲覧できます。
- 実装環境は **独立Docker bridge** `ai-interaction-hub-private` 上の `ai-interaction-hub-web` / `ai-interaction-hub-tailscale` です。Webはbridge内の `0.0.0.0:18777` に待受しますが、ホストへのポート公開はありません。Tailscale ServeのHTTPS (443) が `http://ai-interaction-hub-web:18777` に転送し、Funnelは無効です。AIR本体の再作成に依存しません。
- Tailscaleの同一ノードID・既存HTTPS FQDN・SQLiteを維持し、**HTTPSトップ画面と依頼APIのHTTP 200、Web単独／Tailscale単独再起動後の復帰**を確認しています。iPhoneのTailscale端末とのpingも成功しました。ただし**物理iPhoneのSafari画面は未検証**です。
- 独立bridgeは外部インターネット公開を防ぎますが、同じDocker bridgeに接続したプロセスやDocker Engine側からWebへ直接アクセスできる範囲は残ります。無制限にコンテナを追加せず、既存2コンテナに限定します。
- Docker Desktopの自動起動はWindowsサインイン時に有効でした。**Windows未サインイン時の復旧までは保証しません。**

### 復旧と構成の再現

`deploy/compose.yaml` と `deploy/serve.example.json` は**再現用のコードのみ**です。稼働中の2コンテナは現在Docker CLIで作成済みで、まだCompose管理に移行していません。**既存コンテナを残したまま `docker compose up` しないでください**（同じコンテナ名の衝突が起きます）。

既存の認証済みTailscale状態は named volume `ai-interaction-hub-tailscale-state` に、会話原文・SQLite・実際のServe設定はGitHubの外の `/workspace/ai-interaction-hub-data` にあります。これらは公開リポジトリに含めません。現在の構成を再現する場合は、まず同じデータ・ボリューム・権限を確保し、`ai-interaction-hub-private` ネットワークを作成してから、サービスを停止・移行してください。新規ノードで既存認証を無断複製して同時起動しないこと。

2026-11-18の移行バックアップは `/workspace/ai-interaction-hub-data/backups/tailnet-recovery-20261118` に配置。旧コンテナは停止・再起動無効で残してあります。

## テスト

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
# Playwright が導入済みの場合のブラウザ回帰テスト
AI_HUB_PLAYWRIGHT_PATH=/opt/runtime/node_modules/playwright node tests/browser_regression.cjs
AI_HUB_PLAYWRIGHT_PATH=/opt/runtime/node_modules/playwright node tests/browser_requests.cjs
AI_HUB_PLAYWRIGHT_PATH=/opt/runtime/node_modules/playwright node tests/browser_review_cases.cjs
```

2026-11-18の実測：Python 18テスト成功、393px Chromium／WebKitで依頼全文、コピー、複数チャット、80件更新、XSS、戻る操作を確認。物理iPhoneでは未確認。

Playwrightのテストでは通信障害からの回復、通信中のセッション切り替えを検証します。AIRでは393px幅の画面・実データ・数式レンダリング・XSSの無害化・Consoleエラーも検証済みです。Playwrightが別の場所にある場合は`AI_HUB_PLAYWRIGHT_PATH`を変更してください。

## セキュリティ

- コードとOSSライブラリのみPublicに公開。会話、DB、スクリーンショット、セッションログ、認証情報は公開禁止
- HTTPリーダーは既定でループバックに限定。本番は `AI_HUB_ALLOW_NONLOOPBACK=YES` を専用bridge内のWebにだけ設定する。Webアプリ自身はユーザー認証を行わないため、**インターネットへのポート公開やFunnelを行わない**
- Markdown-it はHTML埋め込み禁止、KaTeXは`trust:false`、CSP／nosniff／frame拒否
- Webからシェル実行やCodexへの依頼送信は不可。入力はChatGPTアプリのみ
- 既存AIR・RDC・Muse台帳・MCP Bridgeの停止や改変は行わない

詳細な進捗・作業承認は [Issue #1](https://github.com/ishiishikou/ai-interaction-hub/issues/1) を参照。
