# AI Interaction Hub

**ChatGPT → AIR → Codex** のやり取りを、iPhoneで閲覧するためのローカルファーストなリッチ会話ビューアです。初期版はCloudflare・OpenAI API・ChatGPT履歴の自動同期を使用しません。入力は引き続きChatGPTアプリで行います。

## 現在できること

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

## Web API

- `GET /healthz`
- `GET /api/sessions`
- `GET /api/sessions/{id}/events?after=0&limit=200` （`limit` 最大500、続きは最後の`seq`を`after`に指定）
- `POST` は不可。外部認証のない書き込みAPIは用意していません。

## iPhoneからのアクセス

現在のサーバーはセキュリティ上、AIRコンテナ内 `127.0.0.1:18777` にのみ待ち受けます。iPhoneがこのアドレスへ直接アクセスすることはできません。

Tailnet内だけで閲覧可能にするには、Tailscale Serve等の認証済みリバースプロキシが**到達可能な形**でWebアプリへ接続される必要があります。DockerコンテナのlocalhostとWindowsのlocalhostは異なります。必要なら、独立したTailscaleサイドカー／Docker内部ネットワーク経路を追加しますが、外部インターネット公開（Funnel、Cloudflare Tunnel）は利用しません。ユーザー操作によるTailscaleのサインインが必要な場合があります。**Tailscale経路を検証するまではiPhone実機対応完了とはしません。**

## テスト

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
# Playwright が導入済みの場合のブラウザ回帰テスト
AI_HUB_PLAYWRIGHT_PATH=/opt/runtime/node_modules/playwright node tests/browser_regression.cjs
```

Playwrightのテストでは通信障害からの回復、通信中のセッション切り替えを検証します。AIRでは393px幅の画面・実データ・数式レンダリング・XSSの無害化・Consoleエラーも検証済みです。Playwrightが別の場所にある場合は`AI_HUB_PLAYWRIGHT_PATH`を変更してください。

## セキュリティ

- コードとOSSライブラリのみPublicに公開。会話、DB、スクリーンショット、セッションログ、認証情報は公開禁止
- HTTPリーダーは既定でループバックに限定。Webアプリ自身はユーザー認証を行わないため、**Tailscale以外の経路から公開しない**
- Markdown-it はHTML埋め込み禁止、KaTeXは`trust:false`、CSP／nosniff／frame拒否
- Webからシェル実行やCodexへの依頼送信は不可。入力はChatGPTアプリのみ
- 既存AIR・RDC・Muse台帳・MCP Bridgeの停止や改変は行わない

詳細な進捗・作業承認は [Issue #1](https://github.com/ishiishikou/ai-interaction-hub/issues/1) を参照。
