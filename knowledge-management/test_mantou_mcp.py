"""Protocol integration using only synthetic, temporary knowledge."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

MODULE = Path(__file__).resolve().parent


class ProtocolTests(unittest.TestCase):
    def test_real_stdio_source_read_and_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "sources"
            root.mkdir()
            (root / "example.md").write_text("# 品牌方法\n日期：2026-10-10\n狀態：候選\n品牌活動經驗\n")
            db = Path(temp) / "index.sqlite3"
            subprocess.run([sys.executable, str(MODULE / "mantou_km.py"), "--db", str(db), "ingest", "--project-root", str(root)], check=True, capture_output=True)
            params = StdioServerParameters(command=sys.executable, args=[str(MODULE / "mantou_mcp.py")], env={**os.environ, "MANTOU_KB_ROOT":str(root), "MANTOU_KB_DB":str(db)})
            def parse(result):
                self.assertFalse(result.isError)
                return json.loads(next(c.text for c in result.content if c.type == "text"))
            async def run():
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = parse(await session.call_tool("knowledge_search", {"query":"品牌活動"}))
                        self.assertEqual(result["returned"], 1)
                        doc = parse(await session.call_tool("knowledge_get", {"document_id":result["matches"][0]["id"]}))
                        self.assertEqual(doc["status"], "候選")
                        self.assertEqual(doc["content"], (root / "example.md").read_text())
                        self.assertTrue((await session.call_tool("knowledge_search", {"query":"品牌", "limit":101})).isError)
                        self.assertTrue((await session.call_tool("knowledge_get", {"document_id":999})).isError)
                        original = (root / "example.md").read_bytes()
                        parse(await session.call_tool("knowledge_refresh", {}))
                        self.assertEqual(original, (root / "example.md").read_bytes())
            asyncio.run(run())
            wrong = Path(temp) / "other"
            wrong.mkdir()
            env = {**params.env, "MANTOU_KB_ROOT":str(wrong)}
            result = subprocess.run([sys.executable, str(MODULE / "mantou_mcp.py")], env=env, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"different project", result.stderr)


if __name__ == "__main__":
    unittest.main()
