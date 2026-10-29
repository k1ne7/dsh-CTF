import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ctf_exec", ROOT / "skills/k1ne-ctf/scripts/ctf_exec.py")
execute = importlib.util.module_from_spec(spec)
spec.loader.exec_module(execute)


class ExecTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(dir=ROOT / "artifacts/tests")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def test_literal_argv_and_unicode(self):
        value = "中文 ' quotes $x; \"embedded\""
        result = execute.run_plan({"steps": [{"argv": [sys.executable, "-c", "import sys;print(sys.argv[1])", value]}]}, self.root)
        path = Path(result["results"][0]["outputs"][0]["path"])
        self.assertEqual(path.read_text(encoding="utf-8").strip(), value)
        self.assertEqual(result["results"][0]["exit_code"], 0)

    def test_fail_fast(self):
        result = execute.run_plan({"steps": [
            {"argv": [sys.executable, "-c", "raise SystemExit(5)"]},
            {"argv": [sys.executable, "-c", "open('should-not-exist','w').close()"]}]}, self.root)
        self.assertEqual(result["results"][0]["exit_code"], 5)
        self.assertEqual(result["skipped"], 1)
        self.assertFalse((self.root / "should-not-exist").exists())

    def test_parallel_requires_independence(self):
        with self.assertRaises(ValueError):
            execute.run_plan({"parallel": True, "steps": [{"argv": [sys.executable]}]}, self.root)

    def test_parallel_and_archive(self):
        result = execute.run_plan({"parallel": True, "steps": [
            {"id": str(i), "independent": True, "argv": [sys.executable, "-c", f"print({i})"]}
            for i in range(3)]}, self.root)
        self.assertEqual(len(result["results"]), 3)
        self.assertEqual(json.loads(Path(result["archive"]).read_text(encoding="utf-8"))["revision"], "0.2.0")

    def test_workspace_fallback(self):
        primary = self.root / "file-not-directory"
        primary.write_text("original", encoding="utf-8")
        used, errors = execute.workspace(primary, self.root / "allowed-fallback")
        self.assertEqual(used, (self.root / "allowed-fallback").resolve())
        self.assertEqual(len(errors), 1)
        self.assertEqual(primary.read_text(encoding="utf-8"), "original")

    def test_no_shell_interpretation(self):
        result = execute.run_plan({"steps": [{"argv": ["nonexistent-binary-ctf-test"]}]}, self.root)
        self.assertEqual(result["results"][0]["exit_code"], 127)


if __name__ == "__main__":
    unittest.main()
