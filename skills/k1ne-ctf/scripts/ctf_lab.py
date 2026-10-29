"""Append-only CTF experiment archive. No model calls, shell, or flag verdicts."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

OUTCOMES = {"observed", "refuted", "blocked", "inconclusive"}
LEVELS = {"none", "extracted", "local", "service", "platform"}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Lab:
    def __init__(self, workspace):
        self.workspace = Path(workspace).resolve(strict=True)
        if not self.workspace.is_dir():
            raise ValueError("workspace must be a directory")
        self.root = self.workspace / ".k1ne-ctf"
        if self.root.is_symlink() or not self.root.resolve().is_relative_to(self.workspace):
            raise ValueError("archive must stay inside workspace")
        self.root.mkdir(exist_ok=True)
        self.inside(self.root / "evidence").mkdir(exist_ok=True)
        db = self.inside(self.root / "experiments.sqlite3")
        self.db = sqlite3.connect(db, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS experiments (
            id TEXT PRIMARY KEY, created TEXT NOT NULL, payload TEXT NOT NULL)""")
        self.db.commit()

    def close(self):
        self.db.close()

    def inside(self, path) -> Path:
        value = Path(path)
        resolved = (value if value.is_absolute() else self.workspace / value).resolve()
        if not resolved.is_relative_to(self.workspace):
            raise ValueError("path must stay inside workspace")
        return resolved

    def record(self, data: dict) -> dict:
        if not isinstance(data, dict):
            raise TypeError("record must be an object")
        for key in ("actor", "hypothesis", "summary"):
            if not isinstance(data.get(key), str) or not data[key].strip():
                raise ValueError(f"{key} must be nonempty text")
        outcome = data.get("outcome", "inconclusive")
        level = data.get("verification", "none")
        if outcome not in OUTCOMES or level not in LEVELS:
            raise ValueError("invalid outcome or verification level")
        evidence = data.get("evidence", [])
        if not isinstance(evidence, list) or any(not isinstance(x, str) for x in evidence):
            raise ValueError("evidence must be a list of workspace file paths")
        if level != "none" and not evidence:
            raise ValueError("verification claims require evidence, not just assertions")
        sources = [self.inside(path) for path in evidence]
        if any(not path.is_file() for path in sources):
            raise ValueError("evidence must be existing regular files")
        identifier = uuid.uuid4().hex
        folder = self.inside(self.root / "evidence" / identifier)
        folder.mkdir()
        archived = []
        try:
            for index, source in enumerate(sources):
                target = folder / f"{index:03d}.bin"
                shutil.copyfile(source, target)
                archived.append({"source": source.relative_to(self.workspace).as_posix(),
                                 "archive": target.relative_to(self.workspace).as_posix(),
                                 "sha256": digest(target), "bytes": target.stat().st_size})
            payload = {"id": identifier, "created": datetime.now(timezone.utc).isoformat(),
                       "actor": data["actor"], "hypothesis": data["hypothesis"],
                       "outcome": outcome, "summary": data["summary"], "next": data.get("next", ""),
                       "verification": level, "evidence": archived}
            # Execution metadata is produced by run(), not trusted as a success verdict.
            if "execution" in data:
                payload["execution"] = data["execution"]
            with self.db:
                self.db.execute("INSERT INTO experiments VALUES (?, ?, ?)",
                                (identifier, payload["created"], json.dumps(payload, ensure_ascii=False)))
            return payload
        except BaseException:
            # Only our freshly created UUID directory, never user evidence.
            if folder.resolve().is_relative_to(self.root.resolve()) and folder.name == identifier:
                shutil.rmtree(folder)
            raise

    def get(self, identifier):
        row = self.db.execute("SELECT payload FROM experiments WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise ValueError("experiment not found")
        return json.loads(row[0])

    def list(self):
        result = []
        for (raw,) in self.db.execute("SELECT payload FROM experiments ORDER BY created, id"):
            value = json.loads(raw)
            result.append({key: value[key] for key in
                           ("id", "created", "actor", "hypothesis", "outcome", "summary", "verification")})
        return result

    def verify(self, identifier):
        values = []
        for item in self.get(identifier)["evidence"]:
            target = self.inside(item["archive"])
            values.append({"archive": item["archive"],
                           "intact": target.is_file() and digest(target) == item["sha256"]})
        return {"id": identifier, "archive_integrity": all(x["intact"] for x in values),
                "has_evidence": bool(values), "checks": values,
                "note": "Integrity is not semantic verification or platform acceptance."}

    def run(self, command, actor, hypothesis, timeout=None):
        if not command:
            raise ValueError("command required after --")
        if timeout is not None and timeout <= 0:
            raise ValueError("timeout must be positive")
        run_dir = self.inside(self.root / "runs" / uuid.uuid4().hex)
        run_dir.mkdir(parents=True)
        stdout_path, stderr_path = run_dir / "stdout.bin", run_dir / "stderr.bin"
        start = time.monotonic()
        timed_out, error, code = False, None, None
        with stdout_path.open("wb") as out, stderr_path.open("wb") as err:
            try:
                process = subprocess.Popen(command, cwd=self.workspace, stdout=out, stderr=err, shell=False)
                try:
                    code = process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    process.kill()
                    code = process.wait()
            except OSError as exc:
                error = f"{type(exc).__name__}: {exc}"
                err.write(error.encode("utf-8"))
            except BaseException:
                if "process" in locals() and process.poll() is None:
                    process.kill()
                    process.wait()
                raise
        elapsed = round((time.monotonic() - start) * 1000, 3)
        execution = {"argv": command, "cwd": str(self.workspace), "exit_code": code,
                     "elapsed_ms": elapsed, "timed_out": timed_out, "launch_error": error}
        metadata = run_dir / "execution.json"
        metadata.write_text(json.dumps(execution, ensure_ascii=False, indent=2), encoding="utf-8")
        payload = self.record({"actor": actor, "hypothesis": hypothesis,
                               "outcome": "blocked" if error or timed_out else "inconclusive",
                               "summary": "Command captured; inspect output before drawing a conclusion.",
                               "verification": "none", "execution": execution,
                               "evidence": [str(stdout_path), str(stderr_path), str(metadata)]})
        return payload


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    commands = parser.add_subparsers(dest="action", required=True)
    record = commands.add_parser("record")
    record.add_argument("--input", required=True, help="JSON file inside workspace")
    commands.add_parser("list")
    for name in ("show", "verify"):
        commands.add_parser(name).add_argument("id")
    run = commands.add_parser("run")
    run.add_argument("--actor", required=True)
    run.add_argument("--hypothesis", required=True)
    run.add_argument("--timeout", type=float)
    run.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    lab = None
    try:
        lab = Lab(args.workspace)
        if args.action == "record":
            result = lab.record(json.loads(lab.inside(args.input).read_text(encoding="utf-8-sig")))
        elif args.action == "list":
            result = lab.list()
        elif args.action == "show":
            result = lab.get(args.id)
        elif args.action == "verify":
            result = lab.verify(args.id)
        else:
            command = args.command[1:] if args.command[:1] == ["--"] else args.command
            result = lab.run(command, args.actor, args.hypothesis, args.timeout)
        print(json.dumps(result, ensure_ascii=False))
        if args.action == "verify" and not result["archive_integrity"]:
            return 1
        if args.action == "run":
            execution = result["execution"]
            if execution["launch_error"]:
                return 127
            if execution["timed_out"]:
                return 124
            return 0 if execution["exit_code"] == 0 else 1
        return 0
    except (ValueError, TypeError, OSError, sqlite3.Error) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    finally:
        if lab:
            lab.close()


if __name__ == "__main__":
    raise SystemExit(main())
