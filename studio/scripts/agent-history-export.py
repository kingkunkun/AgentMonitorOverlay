#!/usr/bin/env python3
"""Export explicitly selected local agent history without touching a running Host.

This is an offline, opt-in archive utility, not a native-history enumeration API.
Only an exact task ID or thread ID is accepted. SQLite is opened mode=ro in a
read transaction; no database, configuration, runtime or source file is changed.
Archives may contain private original tool output and must stay outside Git.

Examples (all paths/IDs are supplied by the operator):
  python scripts/agent-history-export.py workstudio --database <studio.db> \
    --task-id <task-id> --output <private-directory> --id <archive-id> --title <title>
  python scripts/agent-history-export.py codex --codex-home <home> \
    --thread-id <thread-id> --output <private-directory> --id <archive-id> --title <title>
  python scripts/agent-history-export.py --self-test
"""

import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import unittest


VERSION = 1
ATTACHMENT_ID = re.compile(r"att-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
IMAGE_PATH = re.compile(r'<image\b[^>]*\bpath="([^"]+)"', re.I)
IDENTITY_KEYS = {"id", "taskId", "task_id", "sessionId", "session_id", "parentId", "parent_id", "toSession", "toTask", "to_session", "to_task"}
SAFE_KV_PREFIXES = ("role-stamp:", "annotation-seq:", "report-turn:", "subsession-setup:", "session-continuation:", "claude-handoff-seen:")


def now():
    return datetime.now(timezone.utc).isoformat()


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def readonly_database(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    connection.execute("BEGIN")
    return connection


def rows(connection, query, params=()):
    return [dict(row) for row in connection.execute(query, params)]


def table_columns(connection, table):
    return {row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')}


def has_identity(value, ids):
    if isinstance(value, dict):
        return any((key in IDENTITY_KEYS and isinstance(child, str) and child in ids) or has_identity(child, ids) for key, child in value.items())
    if isinstance(value, list):
        return any(has_identity(child, ids) for child in value)
    return False


def walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def clean_source_path(value):
    # Windows extended paths must work both in file links and SQLite metadata.
    return Path(value[4:] if value.startswith("\\\\?\\") else value)


class Archive:
    def __init__(self, output, archive_id, title, source):
        self.output = Path(output).resolve()
        if self.output.exists() and any(self.output.iterdir()):
            raise ValueError("Output directory must be empty; archives are never silently overwritten")
        self.output.mkdir(parents=True, exist_ok=True)
        self.manifest = {"version": VERSION, "kind": "agent-history-archive", "id": archive_id, "title": title, "source": source, "snapshotAt": now(), "localOnly": True, "sources": [], "counts": {}, "attachments": [], "missing": [], "warnings": []}
        self.messages = []
        self.tools = []
        self.seen_attachments = {}
        self.native_seen = set()

    def copy_snapshot(self, source, relative):
        source = clean_source_path(str(source)).resolve()
        target = self.output / relative
        if not source.is_file():
            self.manifest["missing"].append({"path": str(source), "reason": "file-not-found"})
            return None
        stat = source.stat()
        target.parent.mkdir(parents=True, exist_ok=True)
        remaining = stat.st_size
        digest = hashlib.sha256()
        with source.open("rb") as reader, target.open("xb") as writer:
            while remaining:
                block = reader.read(min(1024 * 1024, remaining))
                if not block:
                    raise RuntimeError("Source shrank during snapshot: " + str(source))
                writer.write(block)
                digest.update(block)
                remaining -= len(block)
        after = source.stat()
        result = {"path": str(source), "archivePath": relative.replace("\\", "/"), "bytes": stat.st_size, "sha256": digest.hexdigest(), "capturedAt": now(), "sourceBytesAfterCopy": after.st_size}
        if after.st_size != stat.st_size or after.st_mtime_ns != stat.st_mtime_ns:
            result["activeAtSnapshot"] = True
        self.manifest["sources"].append(result)
        return target

    def attachment(self, value, context):
        if not isinstance(value, str) or not value:
            return None
        if value.startswith("data:"):
            match = re.match(r"data:([^;,]+);base64,(.*)", value, re.S)
            if not match:
                return None
            mime, encoded = match.groups()
            try:
                data = base64.b64decode(encoded, validate=True)
            except ValueError:
                self.manifest["warnings"].append({"context": context, "reason": "invalid-embedded-attachment"})
                return None
            digest = hashlib.sha256(data).hexdigest()
            key = "embedded:" + digest
            if key in self.seen_attachments:
                return self.seen_attachments[key]
            extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg"}.get(mime, ".bin")
            relative = "attachments/" + digest + extension
            target = self.output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            entry = {"source": key, "archivePath": relative, "bytes": len(data), "sha256": digest, "mimeType": mime, "context": context}
        elif re.match(r"https?://", value, re.I):
            key = value
            if key in self.seen_attachments:
                return self.seen_attachments[key]
            # Never fetch a URL found inside historical text. Keep its reference.
            entry = {"source": value, "context": context, "availability": "remote-reference-only"}
        else:
            source = clean_source_path(value)
            if not source.is_absolute():
                return None
            key = str(source.resolve()).lower()
            if key in self.seen_attachments:
                return self.seen_attachments[key]
            if not source.is_file():
                entry = {"source": str(source), "context": context, "availability": "missing"}
                self.manifest["missing"].append({"path": str(source), "context": context, "reason": "attachment-not-found"})
            else:
                digest = sha256(source)
                relative = "attachments/" + digest + source.suffix.lower()
                target = self.output / relative
                if not target.exists():
                    self.copy_snapshot(source, relative)
                entry = {"source": str(source), "archivePath": relative, "bytes": target.stat().st_size, "sha256": sha256(target), "context": context}
        self.seen_attachments[key] = entry
        self.manifest["attachments"].append(entry)
        return entry

    def referenced_attachments(self, value, context, attachment_root=None):
        found = []
        for node in walk(value):
            if isinstance(node, dict):
                node_type = node.get("type", "")
                if node_type in ("input_image", "image", "localImage", "local_image", "image_url", "input_audio", "audio", "localAudio") or ("path" in node and "id" in node and ATTACHMENT_ID.fullmatch(str(node["id"]))):
                    candidate = node.get("image_url") or node.get("url") or node.get("path") or node.get("data")
                    if isinstance(candidate, dict):
                        candidate = candidate.get("url")
                    entry = self.attachment(candidate, context)
                    if entry and entry not in found:
                        found.append(entry)
            elif isinstance(node, str) and not node.startswith("data:"):
                for path in IMAGE_PATH.findall(node):
                    entry = self.attachment(path, context)
                    if entry and entry not in found:
                        found.append(entry)
                if attachment_root:
                    for attachment_id in set(ATTACHMENT_ID.findall(node)):
                        matches = list(Path(attachment_root).glob(attachment_id + ".*"))
                        for path in matches:
                            entry = self.attachment(str(path.resolve()), context)
                            if entry and entry not in found:
                                found.append(entry)
        return found

    def jsonl(self, relative, values):
        target = self.output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8", newline="\n") as writer:
            for value in values:
                writer.write(json_text(value) + "\n")

    def finish(self):
        self.jsonl("messages.jsonl", self.messages)
        self.jsonl("tools.jsonl", self.tools)
        text = [self.manifest["title"], "Snapshot: " + self.manifest["snapshotAt"], ""]
        cards = []
        for message in self.messages:
            label = " / ".join(str(message.get(key, "")) for key in ("sessionId", "timestamp", "role"))
            text.extend([label, message["text"], ""])
            images = []
            for attachment in message.get("attachments", []):
                path = attachment.get("archivePath")
                if path:
                    images.append('<a href="' + html.escape(path, quote=True) + '"><img loading="lazy" src="' + html.escape(path, quote=True) + '"></a>')
            cards.append('<article><h2>' + html.escape(label) + '</h2><pre>' + html.escape(message["text"]) + '</pre>' + "".join(images) + '</article>')
        (self.output / "transcript.txt").write_text("\n".join(text), encoding="utf-8")
        document = '<!doctype html><meta charset="utf-8"><title>' + html.escape(self.manifest["title"]) + '</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:15px/1.65 system-ui;max-width:1050px;margin:30px auto;padding:0 18px;color:#202124}article{border-top:1px solid #ddd;padding:18px 0}h2{font-size:12px;color:#666;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}img{max-width:100%;max-height:600px;border-radius:8px}a{display:block;margin-top:12px}</style><h1>' + html.escape(self.manifest["title"]) + '</h1><p>Local archive · ' + html.escape(self.manifest["snapshotAt"]) + '</p>' + "".join(cards)
        (self.output / "transcript.html").write_text(document, encoding="utf-8")
        self.manifest["counts"].update({"messages": len(self.messages), "roles": dict(Counter(message["role"] for message in self.messages)), "tools": len(self.tools), "attachments": len(self.manifest["attachments"]), "missing": len(self.manifest["missing"])})
        self.manifest["files"] = [{"path": str(path.relative_to(self.output)).replace("\\", "/"), "bytes": path.stat().st_size, "sha256": sha256(path)} for path in sorted(self.output.rglob("*")) if path.is_file()]
        write_json(self.output / "manifest.json", self.manifest)
        company = {"version": 1, "kind": "workstudio-company-archive", "id": self.manifest["id"], "title": self.manifest["title"], "source": self.manifest["source"], "transcriptPath": str(self.output / "transcript.txt"), "messageCount": len(self.messages), "sha256": sha256(self.output / "transcript.txt"), "localOnly": True}
        write_json(self.output / "company-archive.json", company)
        index = {**company, "manifestPath": str(self.output / "company-archive.json"), "fullManifestPath": str(self.output / "manifest.json"), "snapshotAt": self.manifest["snapshotAt"], "counts": self.manifest["counts"], "manifestSha256": sha256(self.output / "manifest.json")}
        if "binding" in self.manifest:
            index["binding"] = self.manifest["binding"]
        write_json(self.output / "import-index.json", index)
        return index


def export_workstudio(archive, database, task_id, codex_home=None):
    connection = readonly_database(database)
    try:
        task = rows(connection, "SELECT * FROM tasks WHERE id=?", (task_id,))
        if len(task) != 1:
            raise ValueError("Exact WorkStudio task ID was not found")
        # Recursive descendants can have a task_id of their own or NULL. Keep the
        # complete tree, but never include an unrelated task merely sharing a project.
        sessions = rows(connection, "WITH RECURSIVE selected(id) AS (SELECT id FROM sessions WHERE task_id=? UNION SELECT s.id FROM sessions s JOIN selected p ON s.parent_id=p.id) SELECT * FROM sessions WHERE id IN (SELECT id FROM selected) ORDER BY created_at,id", (task_id,))
        ids = [session["id"] for session in sessions]
        selected_ids = set(ids + [task_id])
        tables = {"tasks": task, "sessions": sessions}
        table_names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in ("items", "annotations", "task_notes", "mail", "decisions", "checklist_items", "task_plans", "chat_marks", "review_comments", "file_marks", "relays"):
            if table not in table_names:
                continue
            columns = table_columns(connection, table)
            clauses, parameters = [], []
            for column in ("session_id", "to_session"):
                if column in columns and ids:
                    clauses.append(column + " IN (" + ",".join("?" for _ in ids) + ")")
                    parameters.extend(ids)
            for column in ("task_id", "to_task"):
                if column in columns:
                    clauses.append(column + "=?")
                    parameters.append(task_id)
            if clauses:
                order = " ORDER BY session_id,seq" if table == "items" else ""
                tables[table] = rows(connection, 'SELECT * FROM "' + table + '" WHERE ' + " OR ".join(clauses) + order, parameters)
        tables["workspaces"] = rows(connection, "SELECT * FROM workspaces WHERE id=?", (task[0]["workspace_id"],))
        tables["kv"] = []
        if ids:
            allowed_keys = [prefix + sid for sid in ids for prefix in SAFE_KV_PREFIXES]
            tables["kv"] = rows(connection, "SELECT * FROM kv WHERE key IN (" + ",".join("?" for _ in allowed_keys) + ")", allowed_keys)
        native_import_ids = {row[0] for row in connection.execute("SELECT value FROM kv WHERE key LIKE 'claude-adopted:%'")}
        parent_map = {session["id"]: session.get("parent_id") for session in sessions}
        lineage = []
        for sid in ids:
            current, seen, imported = sid, set(), False
            while current and current not in seen:
                seen.add(current)
                if current in native_import_ids:
                    imported = True
                    break
                current = parent_map.get(current)
            lineage.append({"sessionId": sid, "importedNativeLineage": imported})
        tables["events"] = []
        # Filtering happens inside SQLite, then the JSON identities are checked.
        # A reference to a task ID inside another task's prose is not its history.
        clauses = " OR ".join("payload LIKE ?" for _ in selected_ids)
        for row in connection.execute("SELECT * FROM events WHERE " + clauses + " ORDER BY seq", ["%" + value + "%" for value in sorted(selected_ids)]):
            value = dict(row)
            if has_identity(json.loads(value["payload"]), selected_ids):
                tables["events"].append(value)
        archive.manifest["databaseSnapshot"] = {"path": str(Path(database).resolve()), "capturedAt": now(), "schemaVersion": connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] if "schema_migrations" in table_names else None, "maxEventSeq": connection.execute("SELECT MAX(seq) FROM events").fetchone()[0], "tableCounts": {table: len(values) for table, values in tables.items()}}
        archive.manifest["lineage"] = lineage
        main = next((session for session in sessions if not session.get("parent_id")), sessions[0] if sessions else None)
        if main:
            archive.manifest["binding"] = {"taskId": task_id, "sessionId": main["id"], "runtimeRef": main.get("runtime_ref"), "runtime": main["runtime"], "profileId": main["profile_id"], "workspaceId": main["workspace_id"], "title": main["title"], "status": main["status"], "writer": main["writer"], "parentId": main.get("parent_id"), "importedNativeLineage": next(item["importedNativeLineage"] for item in lineage if item["sessionId"] == main["id"])}
    finally:
        connection.rollback()
        connection.close()
    attachment_root = Path(database).parent / "attachments"
    for table, values in tables.items():
        archive.jsonl("workstudio/" + table + ".jsonl", values)
        # Explicit image fields and attachment IDs only; no arbitrary paths from
        # shell output are opened by the exporter.
        for value in values:
            archive.referenced_attachments(value, "workstudio:" + table, attachment_root)
    for item in tables.get("items", []):
        body = json.loads(item["body"])
        attached = archive.referenced_attachments(body, item["id"], attachment_root)
        if item["type"] in ("user", "agent"):
            archive.messages.append({"source": "workstudio", "sessionId": item["session_id"], "id": item["id"], "seq": item["seq"], "timestamp": item["created_at"], "role": "user" if item["type"] == "user" else "assistant", "text": body.get("text", body.get("markdown", "")), "attachments": attached})
        elif item["type"] == "tool":
            archive.tools.append({"source": "workstudio", **item})
    archive.manifest["counts"].update({"sessions": len(sessions), "items": len(tables.get("items", [])), "events": len(tables.get("events", []))})
    if codex_home:
        archive_codex(archive, codex_home, [session["runtime_ref"] for session in sessions if session["runtime"] == "codex" and session.get("runtime_ref")], publish_messages=False)


def archive_codex(archive, codex_home, thread_ids, publish_messages=True):
    codex_home = Path(codex_home).resolve()
    database = codex_home / "state_5.sqlite"
    connection = readonly_database(database)
    thread_rows = []
    try:
        known_tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        pending, selected, edges = list(thread_ids), set(), []
        while pending:
            tid = pending.pop(0)
            if tid in selected:
                continue
            selected.add(tid)
            matches = rows(connection, "SELECT id,rollout_path,title,created_at,updated_at FROM threads WHERE id=?", (tid,))
            if not matches:
                archive.manifest["missing"].append({"threadId": tid, "reason": "thread-metadata-not-found"})
            thread_rows.extend(matches)
            if "thread_spawn_edges" in known_tables:
                children = rows(connection, "SELECT * FROM thread_spawn_edges WHERE parent_thread_id=?", (tid,))
                edges.extend(children)
                pending.extend(child["child_thread_id"] for child in children)
        attachments = []
        if "thread_attachments" in known_tables:
            for tid in sorted(selected):
                attachments.extend(rows(connection, "SELECT * FROM thread_attachments WHERE thread_id=?", (tid,)))
    finally:
        connection.rollback()
        connection.close()
    archive.jsonl("codex/threads.jsonl", thread_rows)
    archive.jsonl("codex/thread-edges.jsonl", edges)
    archive.jsonl("codex/thread-attachments.jsonl", attachments)
    for row in attachments:
        try:
            archive.referenced_attachments(json.loads(row["payload"]), row["id"])
        except (ValueError, KeyError):
            archive.manifest["warnings"].append({"attachmentId": row.get("id"), "reason": "unrecognized-attachment-metadata"})
    sources = {}
    for row in thread_rows:
        path = clean_source_path(row["rollout_path"])
        sources[str(path.resolve()).lower()] = path
    # Exact ID filename matching also finds continuation fragments. No unrelated
    # session content is opened and no all-history index is produced.
    for tid in sorted(selected):
        for root in (codex_home / "sessions", codex_home / "archived_sessions"):
            if root.is_dir():
                for path in root.rglob("*" + tid + "*.jsonl"):
                    sources[str(path.resolve()).lower()] = path
    native_messages, native_tools, event_counts = [], [], Counter()
    for source in sorted(sources.values()):
        relative = "codex/raw/" + hashlib.sha256(str(source).encode()).hexdigest()[:10] + "-" + source.name
        captured = archive.copy_snapshot(source, relative)
        if not captured:
            continue
        with captured.open("r", encoding="utf-8") as reader:
            for line_number, line in enumerate(reader, 1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    archive.manifest["warnings"].append({"path": relative, "line": line_number, "reason": "incomplete-or-invalid-record-preserved-in-raw"})
                    continue
                payload = event.get("payload", {})
                kind = event.get("type", "unknown")
                payload_type = payload.get("type", "unknown") if isinstance(payload, dict) else "unknown"
                event_counts[kind + "/" + payload_type] += 1
                context = relative + ":" + str(line_number)
                attached = archive.referenced_attachments(payload, context)
                if kind == "response_item" and payload_type == "message" and payload.get("role") in ("user", "assistant") and payload.get("channel") != "analysis":
                    content = payload.get("content", [])
                    text = "\n".join(block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") in ("input_text", "output_text", "text"))
                    # Native continuation rollouts repeat previous messages. Keep
                    # every distinct message; the raw source is always byte exact.
                    fingerprint = hashlib.sha256(json_text({"id": payload.get("id"), "role": payload["role"], "text": text, "timestamp": event.get("timestamp") if not payload.get("id") else None}).encode()).hexdigest()
                    if fingerprint not in archive.native_seen:
                        archive.native_seen.add(fingerprint)
                        native_messages.append({"source": "codex", "sessionId": source.stem, "id": payload.get("id"), "timestamp": event.get("timestamp"), "role": payload["role"], "channel": payload.get("channel"), "text": text, "attachments": attached, "sourceRecord": context})
                elif kind == "response_item" and ("call" in payload_type or "tool" in payload_type or payload_type.endswith("_output")):
                    native_tools.append({"sourceRecord": context, **event})
    archive.jsonl("codex/messages.jsonl", native_messages)
    archive.jsonl("codex/tools.jsonl", native_tools)
    archive.manifest["counts"].update({"nativeThreads": len(selected), "nativeRawFiles": len(sources), "nativeMessages": len(native_messages), "nativeTools": len(native_tools), "nativeRecords": sum(event_counts.values()), "nativeRecordTypes": dict(event_counts)})
    if publish_messages:
        archive.messages.extend(native_messages)
        archive.tools.extend(native_tools)


def include_directory(archive, source):
    source = Path(source).resolve()
    if not source.is_dir():
        raise ValueError("Included archive directory does not exist")
    for path in sorted(source.rglob("*")):
        if path.is_file():
            archive.copy_snapshot(path, str(Path("linked-archives") / source.name / path.relative_to(source)))


def mirror_archive(output, destination):
    source, target = Path(output).resolve(), Path(destination).resolve()
    if target.exists():
        raise ValueError("Mirror directory already exists; choose a new snapshot directory")
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("Source and mirror must be separate directories")
    shutil.copytree(source, target)
    company = json.loads((target / "company-archive.json").read_text(encoding="utf-8"))
    company["transcriptPath"] = str(target / "transcript.txt")
    write_json(target / "company-archive.json", company)
    index = json.loads((target / "import-index.json").read_text(encoding="utf-8"))
    index.update(company)
    index.update({"manifestPath": str(target / "company-archive.json"), "fullManifestPath": str(target / "manifest.json")})
    write_json(target / "import-index.json", index)
    return index


class ExportTests(unittest.TestCase):
    def test_exact_task_tree_and_readonly(self):
        with tempfile.TemporaryDirectory(prefix="amo-agent-history-test-") as directory:
            root = Path(directory)
            database = root / "studio.db"
            c = sqlite3.connect(database)
            c.executescript("CREATE TABLE tasks(id TEXT,workspace_id TEXT,title TEXT); CREATE TABLE workspaces(id TEXT); CREATE TABLE sessions(id TEXT,task_id TEXT,parent_id TEXT,created_at TEXT,runtime TEXT,runtime_ref TEXT,profile_id TEXT,workspace_id TEXT,title TEXT,status TEXT,writer TEXT); CREATE TABLE items(session_id TEXT,seq INTEGER,id TEXT,type TEXT,created_at TEXT,body TEXT); CREATE TABLE events(seq INTEGER,type TEXT,payload TEXT); CREATE TABLE kv(key TEXT,value TEXT);")
            c.executemany("INSERT INTO tasks VALUES(?,?,?)", [("target", "ws", "wanted"), ("other", "ws", "unrelated")])
            c.execute("INSERT INTO workspaces VALUES('ws')")
            for sid, tid, parent in [("main", "target", None), ("child", None, "main"), ("other", "other", None)]:
                c.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)", (sid, tid, parent, "today", "mock", None, "profile", "ws", "title", "running", "workbench"))
                c.execute("INSERT INTO items VALUES(?,?,?,?,?,?)", (sid, 1, sid + "-item", "user", "today", json_text({"text": sid})))
            c.execute("INSERT INTO events VALUES(1,'selected',?)", (json_text({"sessionId": "main"}),))
            c.execute("INSERT INTO events VALUES(2,'unrelated',?)", (json_text({"sessionId": "other", "text": "target"}),))
            c.execute("INSERT INTO kv VALUES('mcp-identity:session:main','never-export-this')")
            c.commit()
            c.close()
            before = sha256(database)
            archive = Archive(root / "out", "test", "Test", "workstudio")
            export_workstudio(archive, database, "target")
            result = archive.finish()
            self.assertEqual(before, sha256(database))
            self.assertEqual(result["messageCount"], 2)
            self.assertEqual(archive.manifest["counts"]["events"], 1)
            self.assertNotIn("never-export-this", (root / "out/workstudio/kv.jsonl").read_text())
            self.assertEqual(result["sha256"], sha256(root / "out/transcript.txt"))
            readonly = readonly_database(database)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    readonly.execute("DELETE FROM tasks")
            finally:
                readonly.close()

    def test_native_continuation_and_embedded_image(self):
        with tempfile.TemporaryDirectory(prefix="amo-agent-history-test-") as directory:
            root = Path(directory)
            home = root / "codex"
            (home / "sessions").mkdir(parents=True)
            first = home / "sessions/rollout-target.jsonl"
            second = home / "sessions/rollout-target_continuation.jsonl"
            image = "data:image/png;base64," + base64.b64encode(b"image-fixture").decode()
            event = {"timestamp": "today", "type": "response_item", "payload": {"type": "message", "id": "m1", "role": "user", "content": [{"type": "input_text", "text": "hello"}, {"type": "input_image", "image_url": image}]}}
            first.write_text(json_text(event) + "\n", encoding="utf-8")
            second.write_text(json_text(event) + "\n" + json_text({"type": "response_item", "payload": {"type": "function_call", "name": "tool"}}) + "\n", encoding="utf-8")
            c = sqlite3.connect(home / "state_5.sqlite")
            c.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,title TEXT,created_at INTEGER,updated_at INTEGER)")
            c.execute("INSERT INTO threads VALUES(?,?,?,?,?)", ("target", str(first), "Test", 1, 1))
            c.commit()
            c.close()
            archive = Archive(root / "out", "test", "Test", "codex")
            archive_codex(archive, home, ["target"])
            result = archive.finish()
            self.assertEqual(result["messageCount"], 1)
            self.assertEqual(result["counts"]["nativeRawFiles"], 2)
            self.assertEqual(result["counts"]["tools"], 1)
            self.assertEqual(result["counts"]["attachments"], 1)
            self.assertEqual(result["counts"]["missing"], 0)
            mirrored = mirror_archive(root / "out", root / "private-copy")
            self.assertEqual(mirrored["sha256"], sha256(Path(mirrored["transcriptPath"])))
            with self.assertRaises(ValueError):
                mirror_archive(root / "out", root / "private-copy")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--self-test", action="store_true")
    sub = parser.add_subparsers(dest="source")
    for source in ("workstudio", "codex"):
        command = sub.add_parser(source)
        command.add_argument("--output", required=True)
        command.add_argument("--id", required=True)
        command.add_argument("--title", required=True)
        command.add_argument("--codex-home", required=source == "codex")
        command.add_argument("--mirror-to")
        command.add_argument("--include-directory", action="append", default=[])
        if source == "workstudio":
            command.add_argument("--database", required=True)
            command.add_argument("--task-id", required=True)
        else:
            command.add_argument("--thread-id", required=True, action="append")
    args = parser.parse_args()
    if args.self_test:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ExportTests))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    if not args.source:
        parser.error("Choose an exact workstudio task or codex thread")
    archive = Archive(args.output, args.id, args.title, args.source)
    if args.source == "workstudio":
        export_workstudio(archive, args.database, args.task_id, args.codex_home)
    else:
        archive_codex(archive, args.codex_home, args.thread_id)
    for directory in args.include_directory:
        include_directory(archive, directory)
    result = archive.finish()
    if args.mirror_to:
        result = mirror_archive(args.output, args.mirror_to)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
