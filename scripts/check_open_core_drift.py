#!/usr/bin/env python3
"""Fail when the package code here drifts from vantio-open-core main.

During the freeze in docs/publishing.md, vantio-open-core still publishes
@vantio/cli 0.3.26 and vantio-agent-sdk 3.1.2 from sealed bytes. The package
code in this repository must stay byte-identical to open-core so the public
home shows the code that ships.

Allowed differences:
- README.md and CHANGELOG.md in each package
- tests under test/ or tests/
- repository, bugs, and homepage links in package.json and server.json, and
  the [project.urls] table in pyproject.toml
- files listed in OPEN_CORE_ONLY, which stay in open-core only

Usage: check_open_core_drift.py <path-to-open-core-checkout>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOTS = (
    "packages/vantio-cli",
    "packages/vantio-agent-sdk",
    "packages/vantio-agent-sdk-py",
    "packages/vantio-optics-mcp",
    "extensions/vantio-optics",
)
SKIP_DIRS = {"node_modules", "__pycache__", "dist", "build", ".pytest_cache"}
FREE_TEXT = {"README.md", "CHANGELOG.md"}
TEST_DIRS = {"test", "tests"}
LINK_KEYS = {"repository", "bugs", "homepage"}
OPEN_CORE_ONLY = {
    "packages/vantio-cli/LEAVE_ENGINEERING_GAP.md",
    "packages/vantio-optics-mcp/package-lock.json",
}


def files(base: Path, root: str) -> set[str]:
    found: set[str] = set()
    top = base / root
    if not top.is_dir():
        return found
    for path in top.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(base)
        if any(part in SKIP_DIRS for part in rel.parts) or rel.suffix == ".pyc":
            continue
        found.add(rel.as_posix())
    return found


def allowed_free(rel: str) -> bool:
    parts = rel.split("/")
    return parts[-1] in FREE_TEXT or any(part in TEST_DIRS for part in parts[2:-1])


def normalized(path: Path) -> bytes:
    if path.name in {"package.json", "server.json"}:
        body = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(body, dict):
            for key in LINK_KEYS:
                body.pop(key, None)
        return json.dumps(body, sort_keys=True).encode("utf-8")
    if path.name == "pyproject.toml":
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"(?ms)^\[project\.urls\]\n.*?(?=^\[|\Z)", "", text)
        return text.encode("utf-8")
    return path.read_bytes()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    here = Path(__file__).resolve().parents[1]
    core = Path(argv[1]).resolve()
    problems: list[str] = []
    for root in ROOTS:
        ours = files(here, root)
        theirs = files(core, root)
        if not theirs:
            problems.append(f"{root}: missing in open-core")
            continue
        for rel in sorted(ours - theirs):
            if not allowed_free(rel):
                problems.append(f"only in vantio-optics: {rel}")
        for rel in sorted(theirs - ours):
            if rel not in OPEN_CORE_ONLY and not allowed_free(rel):
                problems.append(f"only in open-core: {rel}")
        for rel in sorted(ours & theirs):
            if allowed_free(rel):
                continue
            if normalized(here / rel) != normalized(core / rel):
                problems.append(f"differs: {rel}")
    if problems:
        print("Package code drifted from vantio-open-core main:")
        for line in problems:
            print(f"  {line}")
        print("Mirror the change in both repositories, or end the freeze in docs/publishing.md.")
        return 1
    print("Package code matches vantio-open-core main.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
