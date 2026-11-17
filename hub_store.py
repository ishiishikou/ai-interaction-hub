"""Durable SQLite event ledger for user/ChatGPT/Codex conversations."""
from __future__ import annotations
import json
import os
import sqlite3
from contextlib import contextmanager
import uuid
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(os.environ.get("AI_HUB_DATA_DIR", "/workspace/ai-interaction-hub-data"))
ROLES = {"user", "chatgpt", "codex"}
KINDS = {"message", "delegation", "result", "raw_log", "status"}
MAX_TEXT = 16 * 1024 * 1024
MAX_SQLITE_INT = (1 << 63) - 1

def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")

class Store:
    def __init__(self, data_dir=None):
        self.path = Path(data_dir or DATA_DIR) / "hub.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.initialize()

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA busy_timeout=10000")
            db.execute("PRAGMA journal_mode=WAL")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def initialize(self):
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL UNIQUE,
                    session_id TEXT NOT NULL REFERENCES sessions(id),
                    author TEXT NOT NULL CHECK(author IN ('user','chatgpt','codex')),
                    kind TEXT NOT NULL CHECK(kind IN ('message','delegation','result','raw_log','status')),
                    source TEXT NOT NULL DEFAULT 'explicit',
                    content TEXT NOT NULL,
                    content_format TEXT NOT NULL DEFAULT 'markdown',
                    rich_json TEXT,
                    metadata_json TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
            """)

    def create_session(self, title, session_id=None):
        sid = session_id or str(uuid.uuid4())
        if not isinstance(title, str) or not title.strip() or len(title) > 300:
            raise ValueError("title must be 1..300 characters")
        if not isinstance(sid, str) or not sid or len(sid) > 180:
            raise ValueError("invalid session ID")
        now = utc_now()
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO sessions VALUES(?,?,?,?)", (sid, title, now, now))
        return sid

    def append(self, session_id, author, content, *, event_id=None,
               kind="message", source="explicit", content_format="markdown",
               rich=None, metadata=None):
        if author not in ROLES or kind not in KINDS:
            raise ValueError("unsupported author or kind")
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_TEXT:
            raise ValueError("content must be text of at most 16 MiB")
        if not isinstance(session_id, str) or len(session_id) > 180:
            raise ValueError("invalid session ID")
        if content_format not in ("markdown", "text", "json"):
            raise ValueError("unsupported content format")
        if not isinstance(source, str) or not source or len(source) > 120:
            raise ValueError("invalid source")
        eid = event_id or str(uuid.uuid4())
        if not isinstance(eid, str) or len(eid) > 200 or not eid:
            raise ValueError("invalid event id")
        rich_json = json.dumps(rich, ensure_ascii=False) if rich is not None else None
        meta_json = json.dumps(metadata, ensure_ascii=False) if metadata is not None else None
        if any(x and len(x.encode("utf-8")) > 262144 for x in (rich_json, meta_json)):
            raise ValueError("structured data exceeds 256 KiB")
        now = utc_now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
            if row:
                payload = (session_id, author, kind, source, content, content_format, rich_json, meta_json)
                original = tuple(row[x] for x in ("session_id","author","kind","source","content","content_format","rich_json","metadata_json"))
                if payload != original:
                    raise ValueError("event id conflict: different payload")
                return int(row["seq"])
            if not db.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone():
                raise ValueError("unknown session")
            cur = db.execute("""
                INSERT INTO events(id,session_id,author,kind,source,content,content_format,rich_json,metadata_json,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)
            """, (eid,session_id,author,kind,source,content,content_format,rich_json,meta_json,now))
            db.execute("UPDATE sessions SET updated_at=? WHERE id=?", (now,session_id))
            return int(cur.lastrowid)

    def delegations(self, *, limit=50, before=None, session_id=None):
        """Newest first, listing metadata and short previews without sending full prompts."""
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("invalid limit")
        if before is not None and (type(before) is not int or not 1 <= before <= MAX_SQLITE_INT):
            raise ValueError("invalid cursor")
        if session_id is not None and (not isinstance(session_id, str) or not session_id or len(session_id) > 180):
            raise ValueError("invalid session")
        where = ["e.kind='delegation'", "e.author='chatgpt'"]
        params = []
        if before is not None:
            where.append("e.seq < ?")
            params.append(before)
        if session_id is not None:
            where.append("e.session_id = ?")
            params.append(session_id)
        sql = """SELECT e.seq, e.id, e.session_id, s.title AS session_title,
                        e.source, e.created_at, e.metadata_json,
                        substr(e.content, 1, 181) AS excerpt,
                        length(e.content) AS characters
                 FROM events e JOIN sessions s ON s.id=e.session_id
                 WHERE """ + " AND ".join(where) + " ORDER BY e.seq DESC LIMIT ?"
        with self.connect() as db:
            rows = [dict(r) for r in db.execute(sql, (*params, limit + 1))]
        has_more = len(rows) > limit
        rows = rows[:limit]
        for row in rows:
            row["metadata"] = json.loads(row.pop("metadata_json")) if row["metadata_json"] else None
            row["excerpt"] = row["excerpt"][:160] + ("…" if row["characters"] > 160 else "")
        return {"delegations": rows, "next_before": rows[-1]["seq"] if has_more and rows else None}

    def delegation(self, seq):
        """Return an exact immutable event and other revisions with an explicit shared task id."""
        if type(seq) is not int or not 1 <= seq <= MAX_SQLITE_INT:
            raise ValueError("invalid delegation id")
        with self.connect() as db:
            row = db.execute("""SELECT e.*, s.title AS session_title
                FROM events e JOIN sessions s ON s.id=e.session_id
                WHERE e.seq=? AND e.kind='delegation' AND e.author='chatgpt'""", (seq,)).fetchone()
            if row is None:
                return None
            record = dict(row)
            record["rich"] = json.loads(record.pop("rich_json")) if record["rich_json"] else None
            record["metadata"] = json.loads(record.pop("metadata_json")) if record["metadata_json"] else None
            metadata = record["metadata"] if isinstance(record["metadata"], dict) else {}
            group = metadata.get("delegation_group") or metadata.get("task_id")
            recipient = metadata.get("recipient") or metadata.get("target_ai") or metadata.get("agent")
            related = []
            if isinstance(group, str) and group.strip():
                candidates = db.execute("""SELECT seq, metadata_json, created_at, source FROM events
                    WHERE session_id=? AND author='chatgpt' AND kind='delegation'
                    ORDER BY seq ASC""", (record["session_id"],))
                for candidate in candidates:
                    data = json.loads(candidate["metadata_json"]) if candidate["metadata_json"] else {}
                    if not isinstance(data, dict):
                        continue
                    candidate_group = data.get("delegation_group") or data.get("task_id")
                    candidate_recipient = data.get("recipient") or data.get("target_ai") or data.get("agent")
                    # A parent task can involve multiple AIs. Revision history is per destination.
                    if (candidate_group == group and candidate["source"] == record["source"]
                            and candidate_recipient == recipient):
                        related.append({"seq": candidate["seq"], "created_at": candidate["created_at"],
                                        "source": candidate["source"],
                                        "revision_type": data.get("revision_type")})
            return {"delegation": record, "related": related}

    def sessions(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute("""
                SELECT s.*, COUNT(e.seq) AS message_count FROM sessions s
                LEFT JOIN events e ON e.session_id=s.id
                GROUP BY s.id ORDER BY s.updated_at DESC, s.created_at DESC
            """)]

    def events(self, session_id, after=0, limit=200):
        if not (0 <= after and 1 <= limit <= 500):
            raise ValueError("invalid pagination")
        with self.connect() as db:
            rows = [dict(r) for r in db.execute("""
                SELECT * FROM events WHERE session_id=? AND seq>?
                ORDER BY seq ASC LIMIT ?
            """, (session_id,after,limit))]
        for r in rows:
            r["rich"] = json.loads(r.pop("rich_json")) if r["rich_json"] is not None else None
            r["metadata"] = json.loads(r.pop("metadata_json")) if r["metadata_json"] is not None else None
        return rows
