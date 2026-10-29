"""Bounded local reference lookup; no network, embeddings or script execution."""
from __future__ import annotations

import argparse
import json
import sys
import os
from pathlib import Path

DEFAULT_ROOT = Path(os.environ.get("DSH_CTF_KB", str(Path(__file__).resolve().parents[3] / "vendor/ctf-knowledge")))
TEXT_EXTENSIONS = {".md", ".txt", ".py", ".js"}


def inside(root, name):
    target = (root / name).resolve(strict=True)
    if not target.is_relative_to(root):
        raise ValueError("reference path must stay inside the library")
    return target


def bounded(result, max_chars):
    """Budget the complete serialized tool result, not only snippet text."""
    if max_chars < 512:
        raise ValueError("max-chars must be at least 512")
    encoded = json.dumps(result, ensure_ascii=False)
    if len(encoded) <= max_chars:
        return result
    result["truncated"] = True
    while result.get("hits") and len(json.dumps(result, ensure_ascii=False)) > max_chars:
        last = result["hits"][-1]
        if len(last.get("text", "")) > 128:
            last["text"] = last["text"][:max(128, len(last["text"]) // 2)]
        else:
            result["hits"].pop()
    if "text" in result:
        while len(json.dumps(result, ensure_ascii=False)) > max_chars and result["text"]:
            result["text"] = result["text"][:len(result["text"]) // 2]
    if len(json.dumps(result, ensure_ascii=False)) > max_chars:
        raise ValueError("metadata exceeds output budget; increase max-chars")
    return result


def candidates(root):
    for path in root.rglob("*"):
        if path.suffix.lower() not in TEXT_EXTENSIONS or not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part.startswith(".") or part in {"node_modules", "__pycache__"} for part in relative.parts):
            continue
        # Do not traverse reference symlinks escaping the configured library.
        if path.resolve().is_relative_to(root):
            yield path


def search(root, query, limit=5, max_chars=6000):
    terms = list(dict.fromkeys(term.casefold() for term in query.split() if term.strip()))
    if not terms or limit < 1:
        raise ValueError("provide query terms and a positive limit")
    paths = sorted(candidates(root), key=lambda p: (not p.name.endswith(".idx.md"), str(p)))
    hits, scanned, errors = [], 0, 0
    for path in paths:
        scanned += 1
        relative = path.relative_to(root).as_posix()
        filename = relative.casefold()
        try:
            with path.open(encoding="utf-8-sig", errors="replace") as stream:
                best = None
                for number, line in enumerate(stream, 1):
                    text = line.strip()
                    folded = text.casefold()
                    matched = sum(term in folded or term in filename for term in terms)
                    if matched != len(terms):
                        continue
                    # Literal matching avoids regex/code execution from queries.
                    score = sum(4 * (term in folded) + 2 * (term in filename) for term in terms)
                    score += 3 * path.name.endswith(".idx.md") + int(text.startswith("#"))
                    item = {"file": relative, "line": number, "text": text[:1200], "score": score}
                    if best is None or score > best["score"]:
                        best = item
                if best is not None:
                    hits.append(best)
                    hits.sort(key=lambda item: (-item["score"], item["file"], item["line"]))
                    hits = hits[:limit + 1]
        except OSError:
            errors += 1
    return bounded({"root": str(root), "query": query, "scanned_files": scanned,
                    "read_errors": errors, "truncated": len(hits) > limit,
                    "hits": hits[:limit]}, max_chars)


def read_section(root, name, line=1, count=30, max_chars=4000):
    if line < 1 or count < 1:
        raise ValueError("line and count must be positive")
    target = inside(root, name)
    if target.suffix.lower() not in TEXT_EXTENSIONS or not target.is_file():
        raise ValueError("choose a text reference")
    lines = []
    more = False
    with target.open(encoding="utf-8-sig", errors="replace") as stream:
        for number, value in enumerate(stream, 1):
            if number < line:
                continue
            if number >= line + count:
                more = True
                break
            lines.append(f"{number}: {value.rstrip()}"[:2000])
    return bounded({"file": name, "start_line": line, "truncated": more,
                    "text": "\n".join(lines)}, max_chars)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    commands = parser.add_subparsers(dest="action", required=True)
    find = commands.add_parser("search")
    find.add_argument("--query", required=True, help="literal terms; all must match line or path")
    find.add_argument("--limit", type=int, default=5)
    find.add_argument("--max-chars", type=int, default=6000)
    read = commands.add_parser("read")
    read.add_argument("--file", required=True)
    read.add_argument("--line", type=int, default=1)
    read.add_argument("--count", type=int, default=30)
    read.add_argument("--max-chars", type=int, default=4000)
    args = parser.parse_args(argv)
    try:
        root = args.root.resolve(strict=True)
        if not root.is_dir():
            raise ValueError("library root must be a directory")
        result = (search(root, args.query, args.limit, args.max_chars) if args.action == "search"
                  else read_section(root, args.file, args.line, args.count, args.max_chars))
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
