#!/usr/bin/env python3
"""Local, read-only source ingestion. No cloud, networking or application writes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone

MODULE = Path(__file__).resolve().parent
MAX_BYTES = 2 * 1024 * 1024
EXTENSIONS = {".md", ".markdown", ".txt"}
EXCLUDED_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", "private", "local-data", "secrets", "credentials", ".ssh", ".aws", ".config"}
SENSITIVE_NAME = re.compile(r"(?:secret|credential|password|api[-_]?key|access[-_]?token|\.env)", re.I)
SECRET = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b")
ASSIGNMENT = re.compile(r"(?im)^\s*(?:export\s+)?(?:[A-Z_]*(?:API_KEY|TOKEN|PASSWORD|SECRET|ACCESS_KEY)[A-Z_]*|api[-_]key|password)\s*[:=]\s*[\"']?([^\s\"'`#]+)")
PLACEHOLDERS = {"example", "placeholder", "redacted", "changeme", "your_api_key", "your_token", "none", "null"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normal(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def secret_content(text: str) -> bool:
    if SECRET.search(text):
        return True
    for match in ASSIGNMENT.finditer(text):
        value = match.group(1)
        if len(value) >= 8 and normal(value) not in PLACEHOLDERS and not value.startswith(("$", "<", "{{", "process.env", "os.environ")):
            return True
    return False


def git_root(path: Path) -> Path | None:
    for parent in (path, *path.parents):
        if (parent / ".git").exists():
            return parent
    return None


def db_path(value: str) -> Path:
    candidate = Path(value).expanduser()
    if candidate.is_symlink():
        raise ValueError("Database must not be a symbolic link")
    target = candidate.resolve()
    # Never put indexed private content in this public module's checkout.
    repository = git_root(MODULE)
    if repository and within(target, repository):
        raise ValueError("Database must be outside the program repository")
    other_repo = git_root(target.parent)
    if other_repo:
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", "--", str(target)], cwd=other_repo, capture_output=True)
        if tracked.returncode == 0:
            raise ValueError("Database must not be a tracked Git file")
        result = subprocess.run(["git", "check-ignore", "--no-index", "--", str(target)], cwd=other_repo, capture_output=True)
        if result.returncode != 0:
            raise ValueError("Database in another checkout must be gitignored first")
    return target


def connect(path: Path, create: bool = False) -> sqlite3.Connection:
    if not create and not path.is_file():
        raise ValueError("Database does not exist; ingest an explicitly authorized project first")
    if create:
        if not path.parent.exists():
            path.parent.mkdir(parents=True, mode=0o700)
        # Atomic restrictive creation also works on the first ingest.
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
    os.chmod(path, 0o600)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA secure_delete=ON")
    if create:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents(
          id INTEGER PRIMARY KEY, relative_path TEXT UNIQUE NOT NULL,
          sha256 TEXT NOT NULL, file_type TEXT NOT NULL, source_date TEXT,
          source_mtime_utc TEXT NOT NULL, indexed_at_utc TEXT NOT NULL,
          status TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
          search_text TEXT NOT NULL
        );
        """)
    return conn


def project_root(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_symlink():
        raise ValueError("Project root must not be a symbolic link")
    root = path.resolve(strict=True)
    if not root.is_dir() or root == Path(root.anchor) or root == Path.home():
        raise ValueError("Choose a specific project directory, not a filesystem root or home directory")
    return root


def selected_path(root: Path, value: str | None) -> Path:
    candidate = root / value if value else root
    # Reject any symlink component even if it resolves inside the root.
    lexical = Path(os.path.abspath(candidate))
    if not within(lexical, root):
        raise ValueError("Selected path is outside the authorized project")
    for component in (lexical, *lexical.parents):
        if component == root:
            break
        if component.is_symlink():
            raise ValueError("Selected path must not contain symbolic links")
    resolved = candidate.resolve(strict=True)
    if not within(resolved, root):
        raise ValueError("Selected path is outside the authorized project")
    return resolved


def excluded(path: Path, root: Path) -> bool:
    parts = path.relative_to(root).parts
    return any(normal(part) in EXCLUDED_DIRS or SENSITIVE_NAME.search(part) for part in parts)


def files(scope: Path, root: Path):
    if scope.is_file():
        yield scope
        return
    for directory, dirs, names in os.walk(scope, followlinks=False):
        current = Path(directory)
        dirs[:] = sorted(d for d in dirs if not (current / d).is_symlink() and not excluded(current / d, root))
        for name in sorted(names):
            yield current / name


def metadata(text: str, path: Path) -> tuple[str, str | None, str]:
    title = path.stem
    for line in text.splitlines()[:20]:
        if line.startswith("# "):
            title = line[2:].strip()
            break
    source_date = None
    status = "unspecified"
    # Only explicit metadata, not arbitrary dates in the body, counts as source_date.
    header = "\n".join(text.splitlines()[:30])
    date = re.search(r"(?im)^\s*(?:date|source_date|日期)\s*[:：]\s*[\"']?(\d{4}-\d{2}-\d{2})(?=T|\s|[\"']|$)", header)
    if date:
        try:
            datetime.strptime(date.group(1), "%Y-%m-%d")
            source_date = date.group(1)
        except ValueError:
            pass
    explicit_status = re.search(r"(?im)^\s*(?:status|狀態)\s*[:：]\s*(.+)$", header)
    if explicit_status:
        status = explicit_status.group(1).strip(" \"'")[:120]
    return title, source_date, status


def ingest(args) -> dict:
    root = project_root(args.project_root)
    scope = selected_path(root, args.path)
    target = db_path(args.db)
    if excluded(scope, root):
        raise ValueError("Selected path is excluded from ingestion")
    # Broad roots that contain this executable repository are not appropriate project scopes.
    if within(MODULE, root):
        raise ValueError("Do not authorize a parent of the program repository")
    with connect(target, create=True) as conn:
        stored = conn.execute("SELECT value FROM settings WHERE key='project_root'").fetchone()
        if stored and stored[0] != str(root):
            raise ValueError("Database is bound to another project; use a separate database")
        conn.execute("INSERT OR IGNORE INTO settings VALUES('project_root', ?)", (str(root),))
        stamp = now()
        seen = set()
        counts = {"indexed": 0, "unchanged": 0, "skipped": 0, "removed": 0}
        for path in files(scope, root):
            if path.is_symlink() or excluded(path, root) or path.suffix.lower() not in EXTENSIONS:
                counts["skipped"] += 1
                continue
            try:
                raw = path.read_bytes() if path.stat().st_size <= MAX_BYTES else None
                if raw is None:
                    counts["skipped"] += 1
                    continue
                text = raw.decode("utf-8")
            except (OSError, UnicodeError):
                # Abort rather than claim the selected scope was fully indexed or prune on transient errors.
                raise ValueError("A source file could not be read as UTF-8; no index changes committed") from None
            if secret_content(text):
                counts["skipped"] += 1
                continue
            rel = str(path.relative_to(root))
            seen.add(rel)
            digest = hashlib.sha256(raw).hexdigest()
            old = conn.execute("SELECT sha256 FROM documents WHERE relative_path=?", (rel,)).fetchone()
            title, date, status = metadata(text, path)
            modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
            if old and old[0] == digest:
                # Refresh parsed metadata when parser versions improve or only mtime changes.
                conn.execute("UPDATE documents SET source_date=?,status=?,title=?,source_mtime_utc=?,search_text=? WHERE relative_path=?",
                             (date,status,title,modified,normal(title+"\n"+text),rel))
                counts["unchanged"] += 1
                continue
            conn.execute("""INSERT INTO documents(relative_path,sha256,file_type,source_date,source_mtime_utc,indexed_at_utc,status,title,content,search_text)
              VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(relative_path) DO UPDATE SET
              sha256=excluded.sha256,file_type=excluded.file_type,source_date=excluded.source_date,
              source_mtime_utc=excluded.source_mtime_utc,indexed_at_utc=excluded.indexed_at_utc,
              status=excluded.status,title=excluded.title,content=excluded.content,search_text=excluded.search_text""",
              (rel,digest,path.suffix.lower(),date,modified,stamp,status,title,text,normal(title+"\n"+text)))
            counts["indexed"] += 1
        for row in conn.execute("SELECT relative_path FROM documents").fetchall():
            rel = row[0]
            if within(root / rel, scope) and rel not in seen:
                conn.execute("DELETE FROM documents WHERE relative_path=?", (rel,))
                counts["removed"] += 1
        conn.execute("INSERT OR REPLACE INTO settings VALUES('last_ingest_utc', ?)", (stamp,))
    # secure_delete plus VACUUM removes stale copies of changed or newly excluded content.
    with connect(target) as conn:
        conn.execute("VACUUM")
    return {"status": "indexed", **counts, "database": str(target), "scope": str(scope), "indexed_at_utc": stamp}


def search(args) -> dict:
    terms = [normal(t) for t in args.query.split() if t]
    if not terms:
        raise ValueError("Search query must not be empty")
    if not 1 <= args.limit <= 100:
        raise ValueError("Limit must be between 1 and 100")
    with connect(db_path(args.db)) as conn:
        where = " AND ".join("instr(search_text, ?) > 0" for _ in terms)
        rows = conn.execute(f"SELECT * FROM documents WHERE {where} ORDER BY relative_path LIMIT ?", (*terms,args.limit)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            content = item.pop("content")
            item.pop("search_text")
            offset = normal(content).find(terms[0])
            start = max(0, offset - 50)
            item["snippet"] = content[start:start+240]
            result.append(item)
        return {"matches": result, "returned": len(result), "limit": args.limit, "matching": "literal NFKC substring; whitespace terms use AND"}


def get(args) -> dict:
    with connect(db_path(args.db)) as conn:
        row = conn.execute("SELECT * FROM documents WHERE id=?", (args.id,)).fetchone()
        if not row:
            raise ValueError("Document not found")
        result = dict(row)
        result.pop("search_text")
        return result


def info(args) -> dict:
    with connect(db_path(args.db)) as conn:
        settings = dict(conn.execute("SELECT key,value FROM settings").fetchall())
        return {**settings, "documents": conn.execute("SELECT count(*) FROM documents").fetchone()[0], "read_only_sources": True, "network_access": False}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(Path.home()/".local/share/mantou-knowledge/index.sqlite3"), help="Private local database, outside this repository")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("ingest", help="Read explicitly authorized Markdown/text project")
    add.add_argument("--project-root", required=True)
    add.add_argument("--path", help="Optional file/subdirectory within project; relative or absolute")
    add.set_defaults(action=ingest)
    find = commands.add_parser("search", help="Traditional Chinese and literal keyword search")
    find.add_argument("query")
    find.add_argument("--limit", type=int, default=20)
    find.set_defaults(action=search)
    read = commands.add_parser("get", help="Read indexed local document and provenance")
    read.add_argument("id", type=int)
    read.set_defaults(action=get)
    state = commands.add_parser("info", help="Inspect local index metadata")
    state.set_defaults(action=info)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(args.action(args), ensure_ascii=False, indent=2))
        return 0
    except (ValueError, sqlite3.Error, OSError) as exc:
        print(json.dumps({"error":str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
