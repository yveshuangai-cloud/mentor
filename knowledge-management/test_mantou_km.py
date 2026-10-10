"""Synthetic-only acceptance tests; no account, application or network needed."""
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("mantou_km", Path(__file__).with_name("mantou_km.py"))
km = importlib.util.module_from_spec(spec)
spec.loader.exec_module(km)


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "authorized-project"
        self.root.mkdir()
        self.db = self.base / "private" / "index.sqlite3"
        fixture = Path(__file__).with_name("fixtures") / "example.md"
        self.doc = self.root / "research.md"
        self.doc.write_bytes(fixture.read_bytes())

    def tearDown(self):
        self.temp.cleanup()

    def ingest(self, **kwargs):
        return km.ingest(argparse.Namespace(db=str(self.db), project_root=str(self.root), path=kwargs.get("path")))

    def search(self, query):
        return km.search(argparse.Namespace(db=str(self.db), query=query, limit=20))["matches"]

    def test_chinese_metadata_provenance_and_literal_search(self):
        self.assertEqual(self.ingest()["indexed"], 1)
        hit = self.search("品牌 行銷")[0]
        self.assertEqual(hit["relative_path"], "research.md")
        self.assertEqual(hit["source_date"], "2026-01-01")
        self.assertEqual(hit["status"], "synthetic_example")
        self.assertEqual(hit["sha256"], hashlib.sha256(self.doc.read_bytes()).hexdigest())
        self.assertTrue(self.search("abc123"))
        self.assertTrue(self.search("100%"))
        self.assertFalse(self.search("' OR 1=1 --"))
        self.assertFalse(self.search("品牌 不存在"))
        full = km.get(argparse.Namespace(db=str(self.db), id=hit["id"]))
        self.assertEqual(full["content"], self.doc.read_text())

    def test_reindex_updates_removes_and_preserves_source(self):
        before = self.doc.read_bytes()
        self.ingest()
        self.assertEqual(self.doc.read_bytes(), before)
        self.assertEqual(self.ingest()["unchanged"], 1)
        self.doc.write_text("# 新研究\n狀態：candidate\n只討論資料中心與能源。", encoding="utf-8")
        self.assertEqual(self.ingest()["indexed"], 1)
        self.assertFalse(self.search("品牌"))
        self.assertEqual(self.search("能源")[0]["status"], "candidate")
        self.doc.unlink()
        self.assertEqual(self.ingest()["removed"], 1)
        self.assertFalse(self.search("能源"))

    def test_secret_files_content_private_and_symlinks_excluded(self):
        (self.root / "secrets.txt").write_text("SYNTHETIC_SECRET_FILENAME")
        (self.root / "ordinary.md").write_text("API_KEY=synthetic-key-value-not-real\nSYNTHETIC_SECRET_BODY")
        (self.root / "private").mkdir()
        (self.root / "private" / "data.md").write_text("SYNTHETIC_PRIVATE_CONTENT")
        outside = self.base / "outside.txt"
        outside.write_text("OUTSIDE_AUTHORIZED_SCOPE")
        (self.root / "shortcut.txt").symlink_to(outside)
        (self.root / "escape").symlink_to(self.base, target_is_directory=True)
        self.ingest()
        for term in ("SYNTHETIC_SECRET_FILENAME", "SYNTHETIC_SECRET_BODY", "SYNTHETIC_PRIVATE_CONTENT", "OUTSIDE_AUTHORIZED_SCOPE"):
            self.assertFalse(self.search(term))
        self.assertEqual(km.info(argparse.Namespace(db=str(self.db)))["documents"], 1)

    def test_new_secret_reindex_purges_old_content(self):
        self.doc.write_text("Previously safe unique-marker-987")
        self.ingest()
        self.doc.write_text("PASSWORD=synthetic-sensitive-value\nunique-marker-987")
        self.assertEqual(self.ingest()["removed"], 1)
        self.assertFalse(self.search("unique-marker-987"))
        self.assertNotIn(b"unique-marker-987", self.db.read_bytes())

    def test_outside_path_and_database_rebinding_rejected(self):
        self.ingest()
        outsider = self.base / "other"
        outsider.mkdir()
        for path in ("../other", str(outsider)):
            with self.assertRaises(ValueError):
                self.ingest(path=path)
        with self.assertRaises(ValueError):
            km.ingest(argparse.Namespace(db=str(self.db), project_root=str(outsider), path=None))
        self.assertTrue(self.search("品牌"))

    def test_partial_reindex_keeps_other_scopes(self):
        for name in ("first", "second"):
            (self.root / name).mkdir()
            (self.root / name / "doc.md").write_text(name+" 品牌")
        self.ingest()
        (self.root / "first" / "doc.md").unlink()
        self.assertEqual(self.ingest(path="first")["removed"], 1)
        self.assertTrue(self.search("second"))

    def test_non_utf8_fails_without_partial_commit_or_pruning(self):
        self.ingest()
        self.doc.write_text("New content")
        (self.root / "broken.txt").write_bytes(b"\xff\xfe")
        with self.assertRaises(ValueError):
            self.ingest()
        self.assertTrue(self.search("品牌"))
        self.assertFalse(self.search("New content"))

    def test_permissions_and_public_checkout_database_refusal(self):
        self.ingest()
        self.assertEqual(self.db.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.db.parent.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(ValueError):
            km.db_path(str(km.MODULE / "leak.sqlite3"))
        with self.assertRaises(ValueError):
            km.project_root(str(Path.home()))

    def test_mail_source_metadata_is_allowed_locally(self):
        self.doc.write_text("# 合成郵件\nsource_message_id: synthetic-message\nfrom: sender@example.test\n工作內容：品牌研究", encoding="utf-8")
        self.ingest()
        self.assertTrue(self.search("品牌研究"))

    def test_explicit_iso_date_retains_source_calendar_day(self):
        self.doc.write_text("date: 2026-01-01T23:30:00-05:00\nstatus: synthetic\n# 合成來源日期\n來源紀錄", encoding="utf-8")
        self.ingest()
        self.assertEqual(self.search("來源紀錄")[0]["source_date"], "2026-01-01")
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE documents SET source_date=NULL")
        self.assertEqual(self.ingest()["unchanged"], 1)
        self.assertEqual(self.search("來源紀錄")[0]["source_date"], "2026-01-01")
        self.doc.write_text("date: 2026-01-01NOTADATE\n# 合成來源日期\n來源紀錄", encoding="utf-8")
        self.ingest()
        self.assertIsNone(self.search("來源紀錄")[0]["source_date"])


if __name__ == "__main__":
    unittest.main()
