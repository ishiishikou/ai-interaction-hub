import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

from hub_store import Store
from hub_app import Handler

class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(self.tmp.name)
        self.sid = self.store.create_session("実際の会話", "s1")
    def tearDown(self):
        self.tmp.cleanup()
    def test_full_multiline_roundtrip(self):
        text = "# 見出し\n\n|A|B|\n|-|-|\n|1|2|\n\n```python\nprint('✓')\n```\n数学 $x^2$\n" * 1000
        n = self.store.append(self.sid,"chatgpt",text,event_id="full",kind="delegation")
        self.assertEqual(self.store.events(self.sid)[0]["content"],text)
        self.assertEqual(n,1)
    def test_cli_stdin_preserves_all_original_newlines(self):
        payload = '日本語\r\nWindows改行\rMac改行\nUnix改行\n'.encode('utf-8')
        proc = subprocess.run([sys.executable, 'hub_app.py', 'add', '--session', self.sid,
                               '--author', 'chatgpt', '--kind', 'delegation', '--file', '-'],
                              input=payload, capture_output=True, cwd=Path(__file__).resolve().parents[1],
                              env={**os.environ, 'AI_HUB_DATA_DIR': self.tmp.name}, check=True)
        self.assertIn(b'"ok": true', proc.stdout)
        self.assertEqual(self.store.events(self.sid)[0]['content'].encode('utf-8'), payload)

    def test_three_authors_and_order(self):
        for author in ("user","chatgpt","codex"):
            self.store.append(self.sid,author,author)
        self.assertEqual([e["author"] for e in self.store.events(self.sid)],["user","chatgpt","codex"])
    def test_idempotent_append(self):
        a = self.store.append(self.sid,"chatgpt","prompt",event_id="same")
        b = self.store.append(self.sid,"chatgpt","prompt",event_id="same")
        self.assertEqual(a,b)
        self.assertEqual(len(self.store.events(self.sid)),1)
    def test_conflict_is_rejected(self):
        self.store.append(self.sid,"chatgpt","A",event_id="same")
        with self.assertRaisesRegex(ValueError,"conflict"):
            self.store.append(self.sid,"codex","B",event_id="same")
    def test_unknown_session_fails(self):
        with self.assertRaisesRegex(ValueError,"unknown session"):
            self.store.append("bad","user","Hi")
    def test_structure_preserved(self):
        meta={"model":"gpt-6.1-sol","effort":"high"}
        rich=[{"type":"code","language":"python","text":"print(1)"}]
        self.store.append(self.sid,"codex","ok",metadata=meta,rich=rich)
        e=self.store.events(self.sid)[0]
        self.assertEqual(e["metadata"],meta)
        self.assertEqual(e["rich"],rich)
    def test_reopen_persistence(self):
        self.store.append(self.sid,"user","abc")
        second = Store(self.tmp.name)
        self.assertEqual(second.events(self.sid)[0]["content"],"abc")
    def test_sessions_and_cursor(self):
        self.store.create_session("another","s2")
        for n in range(4): self.store.append(self.sid,"chatgpt",str(n))
        a=self.store.events(self.sid,limit=2)
        b=self.store.events(self.sid,after=a[-1]["seq"],limit=2)
        self.assertEqual([x["content"] for x in a+b],["0","1","2","3"])
        self.assertEqual(len(self.store.sessions()),2)
    def test_validation(self):
        for author in ("intruder",""):
            with self.assertRaises(ValueError): self.store.append(self.sid,author,"x")
        with self.assertRaises(ValueError): self.store.append(self.sid,"user","X"*(16*1024*1024+1))
        with self.assertRaises(ValueError): self.store.events(self.sid,-1)
    def test_escaped_malicious_text_unchanged(self):
        payload='<img src=x onerror=alert(1)>\n<script>alert(1)</script>'
        self.store.append(self.sid,"user",payload)
        self.assertEqual(self.store.events(self.sid)[0]["content"],payload)
    def test_delegation_listing_and_exact_detail(self):
        other=self.store.create_session("別のチャット","s2")
        initial="初回の依頼\r\nそのまま保持 <script>alert(1)</script>"
        seq1=self.store.append(self.sid,"chatgpt",initial,kind="delegation",
            source="chatgpt-to-codex-cli",metadata={"task_id":"task-1","revision_type":"initial"})
        self.store.append(self.sid,"codex","回答",kind="result")
        seq2=self.store.append(self.sid,"chatgpt","追記の依頼",kind="delegation",
            source="chatgpt-to-codex-cli",metadata={"task_id":"task-1","revision_type":"followup"})
        seq3=self.store.append(other,"chatgpt","Museへの依頼",kind="delegation",
            source="chatgpt-to-muse-sdk",metadata={"task_id":"task-1","target_ai":"Muse"})
        listing=self.store.delegations(limit=2)
        self.assertEqual([x["seq"] for x in listing["delegations"]],[seq3,seq2])
        self.assertEqual(listing["next_before"],seq2)
        next_page=self.store.delegations(limit=2,before=seq2)
        self.assertEqual([x["seq"] for x in next_page["delegations"]],[seq1])
        self.assertEqual(self.store.delegations(session_id=self.sid)["delegations"][0]["seq"],seq2)
        detail=self.store.delegation(seq1)
        self.assertEqual(detail["delegation"]["content"],initial)
        self.assertEqual([r["seq"] for r in detail["related"]],[seq1,seq2])
        self.assertEqual([r["seq"] for r in self.store.delegation(seq3)["related"]],[seq3])
        self.assertIsNone(self.store.delegation(999999))

    def test_delegation_input_validation(self):
        for kwargs in ({"limit":0},{"limit":101},{"before":0},{"session_id":""},
                       {"before":2**63}):
            with self.assertRaises(ValueError): self.store.delegations(**kwargs)
        for seq in (0,-2,2**63):
            with self.assertRaises(ValueError): self.store.delegation(seq)

    def test_revision_links_do_not_mix_recipient_ai(self):
        codex=self.store.append(self.sid,"chatgpt","Codexへ初回",kind="delegation",
            source="chatgpt-to-codex-cli",metadata={"task_id":"shared","revision_type":"initial"})
        muse=self.store.append(self.sid,"chatgpt","Museへ依頼",kind="delegation",
            source="chatgpt-to-muse-sdk",metadata={"task_id":"shared","revision_type":"initial"})
        retry=self.store.append(self.sid,"chatgpt","Codexへ再試行",kind="delegation",
            source="chatgpt-to-codex-cli",metadata={"task_id":"shared","revision_type":"retry"})
        self.assertEqual([r["seq"] for r in self.store.delegation(codex)["related"]],[codex,retry])
        self.assertEqual([r["seq"] for r in self.store.delegation(muse)["related"]],[muse])
        with_target=self.store.append(self.sid,"chatgpt","別AI",kind="delegation",
            source="explicit",metadata={"task_id":"shared","target_ai":"Muse"})
        without_target=self.store.append(self.sid,"chatgpt","宛先なし",kind="delegation",
            source="explicit",metadata={"task_id":"shared"})
        self.assertEqual([r["seq"] for r in self.store.delegation(with_target)["related"]],[with_target])
        self.assertEqual([r["seq"] for r in self.store.delegation(without_target)["related"]],[without_target])

    def test_concurrent_unique_events(self):
        errors=[]
        def writer(i):
            try: self.store.append(self.sid,"codex",f"thread-{i}",event_id=f"t{i}")
            except Exception as exc: errors.append(str(exc))
        jobs=[threading.Thread(target=writer,args=(n,)) for n in range(12)]
        for t in jobs:t.start()
        for t in jobs:t.join()
        self.assertFalse(errors,errors)
        self.assertEqual(len(self.store.events(self.sid)),12)

class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True)
        cls.thread.start()
        cls.base="http://127.0.0.1:"+str(cls.http.server_port)
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
    def test_health_and_headers(self):
        with urlopen(self.base+"/healthz") as r:
            self.assertTrue(json.load(r)["ok"])
            self.assertIn("default-src 'self'",r.headers["Content-Security-Policy"])
            self.assertEqual(r.headers["Access-Control-Allow-Origin"],None)
    def test_serve_static_ui(self):
        with urlopen(self.base+"/") as r:
            page=r.read().decode("utf-8")
            self.assertIn("Interaction Hub",page)
    def test_delegation_api_and_missing(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            store=Store(tmp)
            sid=store.create_session("API確認","for-api")
            seq=store.append(sid,"chatgpt","これは原文\n2行目",kind="delegation",source="chatgpt-to-muse-sdk")
            with patch("hub_app.Store",return_value=store):
                with urlopen(self.base+"/api/delegations?limit=1") as response:
                    data=json.load(response)
                self.assertEqual(data["delegations"][0]["seq"],seq)
                self.assertEqual(data["delegations"][0]["session_title"],"API確認")
                self.assertNotIn("content",data["delegations"][0])
                with urlopen(self.base+"/api/delegations/"+str(seq)) as response:
                    self.assertEqual(json.load(response)["delegation"]["content"],"これは原文\n2行目")
                for path,code in (("/api/delegations?limit=101",400),("/api/delegations/1x",400),
                                  ("/api/delegations?before=9223372036854775808",400),
                                  ("/api/delegations/9223372036854775808",400),
                                  ("/api/delegations/999999",404)):
                    with self.assertRaises(HTTPError) as err:
                        urlopen(self.base+path)
                    self.assertEqual(err.exception.code,code)

    def test_http_no_write(self):
        with self.assertRaises(HTTPError) as e:
            urlopen(Request(self.base+"/api/sessions",data=b'{}',method="POST"))
        self.assertEqual(e.exception.code,405)

if __name__=="__main__":
    unittest.main()
