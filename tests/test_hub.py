import json
import os
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
    def test_http_no_write(self):
        with self.assertRaises(HTTPError) as e:
            urlopen(Request(self.base+"/api/sessions",data=b'{}',method="POST"))
        self.assertEqual(e.exception.code,405)

if __name__=="__main__":
    unittest.main()
