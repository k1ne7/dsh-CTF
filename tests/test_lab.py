import concurrent.futures
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMP = ROOT / "artifacts" / "tests"
TEMP.mkdir(parents=True, exist_ok=True)
SCRIPT = ROOT / "skills/k1ne-ctf/scripts/ctf_lab.py"
spec = importlib.util.spec_from_file_location("ctf_lab", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=TEMP)
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.lab = module.Lab(self.workspace)
        self.addCleanup(self.lab.close)

    def data(self, **kw):
        return dict(actor="lead", hypothesis="a testable claim", summary="actual observation", **kw)

    def test_append_and_list(self):
        first = self.lab.record(self.data())
        second = self.lab.record(self.data())
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(len(self.lab.list()), 2)

    def test_evidence_snapshot_survives_source_change(self):
        source = self.workspace / "source.txt"
        source.write_text("original", encoding="utf-8")
        item = self.lab.record(self.data(evidence=["source.txt"], verification="extracted"))
        source.write_text("modified", encoding="utf-8")
        self.assertTrue(self.lab.verify(item["id"])["archive_integrity"])
        self.assertEqual(item["evidence"][0]["sha256"], __import__("hashlib").sha256(b"original").hexdigest())

    def test_tampering_detected(self):
        (self.workspace / "proof").write_bytes(b"x")
        item = self.lab.record(self.data(evidence=["proof"]))
        (self.workspace / item["evidence"][0]["archive"]).write_bytes(b"y")
        self.assertFalse(self.lab.verify(item["id"])["archive_integrity"])

    def test_no_semantic_success_from_exit_zero(self):
        item = self.lab.run([sys.executable, "-c", "print('flag{fake}')"], "lead", "inspect output")
        self.assertEqual(item["execution"]["exit_code"], 0)
        self.assertEqual(item["outcome"], "inconclusive")
        self.assertEqual(item["verification"], "none")
        self.assertEqual(len(item["evidence"]), 3)

    def test_nonzero_exit_and_stderr(self):
        item = self.lab.run([sys.executable, "-c", "import sys; print('bad', file=sys.stderr); sys.exit(7)"], "a", "x")
        self.assertEqual(item["execution"]["exit_code"], 7)
        err = self.workspace / item["evidence"][1]["archive"]
        self.assertIn(b"bad", err.read_bytes())

    def test_launch_error(self):
        item = self.lab.run([str(self.workspace / "nonexistent-program")], "a", "x")
        self.assertEqual(item["outcome"], "blocked")
        self.assertIsNotNone(item["execution"]["launch_error"])

    def test_timeout(self):
        item = self.lab.run([sys.executable, "-c", "import time; time.sleep(30)"], "a", "x", .1)
        self.assertTrue(item["execution"]["timed_out"])
        self.assertEqual(item["outcome"], "blocked")

    def test_invalid_timeout(self):
        with self.assertRaises(ValueError):
            self.lab.run([sys.executable], "a", "x", -1)

    def test_argv_not_shell(self):
        item = self.lab.run([sys.executable, "-c", "import sys; print(sys.argv[1])", "x; echo pwned"], "a", "x")
        output = (self.workspace / item["evidence"][0]["archive"]).read_text()
        self.assertEqual(output.strip(), "x; echo pwned")

    def test_reject_traversal(self):
        with self.assertRaises(ValueError):
            self.lab.record(self.data(evidence=["../outside"]))

    def test_requires_evidence_for_verification_claim(self):
        for level in ("extracted", "local", "service", "platform"):
            with self.subTest(level=level), self.assertRaises(ValueError):
                self.lab.record(self.data(verification=level))

    def test_invalid_fields(self):
        for patch in ({"actor": ""}, {"outcome": "solved"}, {"verification": "yes"}, {"evidence": "proof"}):
            value = self.data()
            value.update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.lab.record(value)

    def test_missing_evidence(self):
        with self.assertRaises(ValueError):
            self.lab.record(self.data(evidence=["missing"]))

    def test_unknown_id(self):
        with self.assertRaises(ValueError):
            self.lab.get("missing")

    def test_concurrent_writers(self):
        def write(index):
            lab = module.Lab(self.workspace)
            try:
                return lab.record(self.data() | {"actor": f"worker-{index}"})["id"]
            finally:
                lab.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(write, range(16)))
        self.assertEqual(len(set(ids)), 16)
        self.assertEqual(len(self.lab.list()), 16)

    def test_cli_preserves_exit_failure(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(self.workspace), "run",
                                 "--actor", "a", "--hypothesis", "x", "--", sys.executable,
                                 "-c", "raise SystemExit(9)"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["execution"]["exit_code"], 9)


if __name__ == "__main__":
    unittest.main()
