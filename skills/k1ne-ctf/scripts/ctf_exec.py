"""Execute argv plans inside the host shell's sandbox; preserve raw outputs."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path


def workspace(primary, fallback=None):
    """One write probe per explicit candidate, never an ACL investigation."""
    errors = []
    for candidate in [primary, fallback] if fallback else [primary]:
        root = Path(candidate).resolve()
        probe = root / (".ctf-write-probe-" + uuid.uuid4().hex)
        try:
            root.mkdir(parents=True, exist_ok=True)
            with probe.open("xb") as stream:
                stream.write(b"probe")
            probe.unlink()
            return root, errors
        except OSError as error:
            errors.append({"path": str(root), "error": type(error).__name__})
    raise OSError("No writable candidate: " + json.dumps(errors))


def run_plan(plan, root):
    steps = plan.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("steps must be a nonempty list")
    ids = []
    for step in steps:
        argv = step.get("argv")
        if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or '\0' in x for x in argv):
            raise ValueError("each argv must be a nonempty array of strings")
        ids.append(step.get("id", str(len(ids))))
        if not isinstance(ids[-1], str) or not ids[-1]:
            raise ValueError("step id must be nonempty text")
        timeout = step.get("timeout")
        if timeout is not None and (not isinstance(timeout, (int, float)) or timeout <= 0):
            raise ValueError("timeout must be positive")
    if len(set(ids)) != len(ids):
        raise ValueError("step ids must be unique")
    if plan.get("parallel") and not all(step.get("independent") is True for step in steps):
        raise ValueError("parallel steps must explicitly declare independent=true")
    folder = root / ".ctf-fast" / uuid.uuid4().hex
    folder.mkdir(parents=True)

    def run(index):
        step = steps[index]
        stdout, stderr = folder / f"{index}.stdout", folder / f"{index}.stderr"
        timeout = step.get("timeout")
        if timeout is not None and (not isinstance(timeout, (int, float)) or timeout <= 0):
            raise ValueError("timeout must be positive")
        start = time.monotonic()
        code, error = None, None
        with stdout.open("wb") as out, stderr.open("wb") as err:
            try:
                child = subprocess.Popen(step["argv"], cwd=root, shell=False, stdout=out, stderr=err,
                                         env=dict(os.environ, PYTHONIOENCODING="utf-8"))
                try:
                    code = child.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
                    code, error = 124, "timeout"
                except BaseException:
                    child.kill()
                    child.wait()
                    raise
            except OSError as exc:
                code, error = 127, str(exc)
        result = {"id": ids[index], "argv": step["argv"], "exit_code": code, "error": error,
                  "elapsed_ms": round((time.monotonic() - start) * 1000), "outputs": []}
        for path in (stdout, stderr):
            with path.open("rb") as stream:
                sha = hashlib.file_digest(stream, "sha256").hexdigest()
            result["outputs"].append({"path": str(path), "sha256": sha, "bytes": path.stat().st_size})
        return result

    if plan.get("parallel"):
        workers = int(plan.get("workers", 4))
        if workers < 1:
            raise ValueError("workers must be positive")
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(run, range(len(steps))))
    else:
        results = []
        for index in range(len(steps)):
            results.append(run(index))
            if results[-1]["exit_code"] and plan.get("stop_on_error", True):
                break
    output = folder / "results.json"
    result = {"revision": "0.2.0", "workspace": str(root), "results": results,
              "skipped": len(steps) - len(results), "archive": str(output)}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--fallback", type=Path)
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan.read_text(encoding="utf-8-sig")) if args.plan else None
        root, probes = workspace(args.workspace, args.fallback)
        result = run_plan(plan, root) if plan else {"workspace": str(root), "probe_failures": probes}
        print(json.dumps(result, ensure_ascii=False))
        return int(any(x["exit_code"] for x in result.get("results", [])))
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
