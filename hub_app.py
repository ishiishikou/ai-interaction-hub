"""Local-only web reader and explicit CLI ingestion; no unauthenticated HTTP writes."""
from __future__ import annotations
import argparse
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
from hub_store import Store

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        super().end_headers()

    def json(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            return self.json(200, {"ok": True, "name": "ai-interaction-hub"})
        if parsed.path == "/api/sessions":
            return self.json(200, {"sessions": Store().sessions()})
        if parsed.path == "/api/delegations":
            try:
                q = parse_qs(parsed.query)
                limit = int(q.get("limit", ["50"])[0])
                before = q.get("before", [None])[0]
                before = int(before) if before is not None else None
                session_id = q.get("session", [None])[0]
                return self.json(200, Store().delegations(limit=limit, before=before, session_id=session_id))
            except (ValueError, TypeError, OverflowError) as exc:
                return self.json(400, {"error": str(exc)})
        if parsed.path.startswith("/api/delegations/"):
            fragment = parsed.path[len("/api/delegations/"):]
            try:
                seq = int(fragment)
                result = Store().delegation(seq)
            except (ValueError, TypeError, OverflowError) as exc:
                return self.json(400, {"error": str(exc)})
            return self.json(200, result) if result else self.json(404, {"error": "not found"})
        if parsed.path.startswith("/api/sessions/") and parsed.path.endswith("/events"):
            sid = unquote(parsed.path[len("/api/sessions/"):-len("/events")]).strip("/")
            try:
                q = parse_qs(parsed.query)
                after = int(q.get("after", ["0"])[0])
                limit = int(q.get("limit", ["200"])[0])
                result = Store().events(sid, after=after, limit=limit)
            except (ValueError, TypeError, OverflowError) as exc:
                return self.json(400, {"error": str(exc)})
            return self.json(200, {"events": result})
        if parsed.path.startswith("/api/"):
            return self.json(404, {"error": "not found"})
        if parsed.path == "/":
            self.path = "/index.html"
        else:
            self.path = parsed.path
        return super().do_GET()

    def do_POST(self):
        return self.json(405, {"error": "web access is read-only"})

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), file=sys.stderr, flush=True)

def run_cli():
    parser = argparse.ArgumentParser(description="AI Interaction Hub - explicit local ingestion")
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("session", help="Create or reference a session")
    c.add_argument("--title", required=True)
    c.add_argument("--id")
    a = sub.add_parser("add", help="Append exact UTF-8 text; no automatic truncation")
    a.add_argument("--session", required=True)
    a.add_argument("--author", choices=("user","chatgpt","codex"), required=True)
    a.add_argument("--kind", choices=("message","delegation","result","raw_log","status"), default="message")
    a.add_argument("--event-id")
    a.add_argument("--source", default="explicit")
    a.add_argument("--format", choices=("markdown","text","json"), default="markdown")
    a.add_argument("--file", required=True, help="UTF-8 text path, or '-' for stdin")
    a.add_argument("--rich-file", help="optional structured JSON from ChatGPT host")
    a.add_argument("--metadata-file", help="optional JSON metadata")
    r = sub.add_parser("read")
    r.add_argument("--session", required=True)
    r.add_argument("--after", type=int, default=0)
    r.add_argument("--limit", type=int, default=200)
    sub.add_parser("sessions")
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=18777)
    args = parser.parse_args()
    if args.cmd == "serve":
        if args.host not in ("127.0.0.1", "::1", "localhost") and os.environ.get("AI_HUB_ALLOW_NONLOOPBACK") != "YES":
            parser.error("non-loopback binding disabled; use a protected Tailscale proxy")
        httpd = ThreadingHTTPServer((args.host, args.port), Handler)
        print("AI Interaction Hub listening at http://%s:%d" % (args.host, args.port), flush=True)
        httpd.serve_forever()
        return
    store = Store()
    if args.cmd == "session":
        print(store.create_session(args.title, args.id))
    elif args.cmd == "add":
        if args.file == "-":
            # TextIOWrapper translates CRLF/CR by default; stdin bytes do not.
            content = sys.stdin.buffer.read().decode("utf-8")
        else:
            with open(args.file, "r", encoding="utf-8", newline="") as f:
                content = f.read()
        def load_json(path):
            return json.loads(Path(path).read_text(encoding="utf-8")) if path else None
        seq = store.append(args.session,args.author,content,event_id=args.event_id,kind=args.kind,
                           source=args.source,content_format=args.format,
                           rich=load_json(args.rich_file),metadata=load_json(args.metadata_file))
        print(json.dumps({"ok": True, "seq": seq}, ensure_ascii=False))
    elif args.cmd == "read":
        print(json.dumps(store.events(args.session,args.after,args.limit),ensure_ascii=False,indent=2))
    elif args.cmd == "sessions":
        print(json.dumps(store.sessions(),ensure_ascii=False,indent=2))

if __name__ == "__main__":
    run_cli()
