import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills/k1ne-ctf/scripts/kb_search.py"
spec = importlib.util.spec_from_file_location("kb_search", SCRIPT)
kb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kb)


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(dir=ROOT / "artifacts/tests")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()

    def put(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_literal_search_and_line(self):
        self.put("note.md", "intro\nJWT algorithm confusion\nend")
        hit = kb.search(self.root, "JWT confusion")["hits"][0]
        self.assertEqual(hit["line"], 2)
        self.assertEqual(hit["file"], "note.md")

    def test_no_match_not_hallucinated(self):
        self.put("note.md", "unrelated")
        self.assertEqual(kb.search(self.root, "JWT")["hits"], [])

    def test_index_priority(self):
        self.put("JWT.md", "JWT algorithms")
        self.put("JWT.idx.md", "JWT algorithms")
        self.assertEqual(kb.search(self.root, "JWT")["hits"][0]["file"], "JWT.idx.md")

    def test_output_budget(self):
        for i in range(8):
            self.put(f"article{i}.md", "JWT " + "中文证据" * 800)
        result = kb.search(self.root, "JWT", limit=5, max_chars=1000)
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False)), 1000)
        self.assertTrue(result["truncated"])

    def test_read_line_range(self):
        self.put("a.md", "a\nb\nc\nd")
        result = kb.read_section(self.root, "a.md", line=2, count=2)
        self.assertEqual(result["text"], "2: b\n3: c")
        self.assertTrue(result["truncated"])

    def test_reject_escape(self):
        with self.assertRaises((ValueError, FileNotFoundError)):
            kb.read_section(self.root, "../private.md")

    def test_binary_and_hidden_excluded(self):
        self.put(".private/a.md", "JWT")
        self.put("picture.png", "JWT")
        self.assertEqual(kb.search(self.root, "JWT")["scanned_files"], 0)

    def test_no_script_execution(self):
        self.put("tool.py", "# JWT\nraise Exception('do not execute')")
        self.assertEqual(kb.search(self.root, "JWT")["hits"][0]["file"], "tool.py")

    def test_regex_is_literal(self):
        self.put("a.md", "JWT")
        self.assertEqual(kb.search(self.root, ".*")["hits"], [])

    def test_invalid_budget_and_limits(self):
        with self.assertRaises(ValueError):
            kb.search(self.root, "JWT", limit=0)
        with self.assertRaises(ValueError):
            kb.search(self.root, "JWT", max_chars=10)
        with self.assertRaises(ValueError):
            kb.read_section(self.root, "a.md", line=0)


if __name__ == "__main__":
    unittest.main()
