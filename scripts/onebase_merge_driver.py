#!/usr/bin/env python3
"""Three-way merge driver for syncing Crestrail into OneBase.

The repositories do not share Git history.  This driver therefore uses the
last upstream snapshot synchronized into OneBase as the logical merge base,
then applies OneBase's forward-only branding rules to upstream content.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


UPSTREAM_BASE = "29b3b1060fb540db64b34296503d14550b10cc09"
UPSTREAM_HEAD = "crestrail/develop"

RENAMED_PATHS = {
    "docs/shirehub-es-sync/README.md": "docs/acme-es-sync/README.md",
    "docs/shirehub-es-sync/install.sql": "docs/acme-es-sync/install.sql",
    "js-runtime/crestrail-runtime/index.js": "js-runtime/onebase-runtime/index.js",
    "py-runtime/crestrail_runtime/crestrail_host.py": (
        "py-runtime/onebase_runtime/onebase_host.py"
    ),
}

BYTE_REPLACEMENTS = (
    (b"cres_kafka_", b"obes_kafka_"),
    (b"cres_es_", b"obes_es_"),
    (b"cres_os_", b"obes_os_"),
    (b"crs_live_", b"obs_live_"),
    (b"cr_live_", b"ob_live_"),
    (b"crp_", b"obp_"),
    (b"crm_", b"obm_"),
    (b"CRESTRAIL", b"ONEBASE"),
    (b"CrestRail", b"OneBase"),
    (b"Crestrail", b"Onebase"),
    (b"crestrail", b"onebase"),
    (b"SHIREHUB", b"ACME"),
    (b"ShireHub", b"Acme"),
    (b"Shirehub", b"Acme"),
    (b"shirehub", b"acme"),
)


def run_git(*args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        check=check,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def git_blob(ref: str, path: str) -> bytes | None:
    result = run_git("show", f"{ref}:{path}", check=False)
    return result.stdout if result.returncode == 0 else None


def brandify(data: bytes) -> bytes:
    for old, new in BYTE_REPLACEMENTS:
        data = data.replace(old, new)
    # A word boundary prevents damage to identifiers such as incr_* / decr_*.
    return re.sub(rb"\bcr_", b"ob_", data)


def merge_bytes(current: bytes, base: bytes, incoming: bytes) -> tuple[bytes, int]:
    with tempfile.TemporaryDirectory(prefix="onebase-merge-") as temp_dir:
        temp = Path(temp_dir)
        current_path = temp / "current"
        base_path = temp / "base"
        incoming_path = temp / "incoming"
        current_path.write_bytes(current)
        base_path.write_bytes(base)
        incoming_path.write_bytes(incoming)
        result = subprocess.run(
            [
                "git",
                "merge-file",
                "-p",
                "-L",
                "OneBase",
                "-L",
                f"Crestrail base {UPSTREAM_BASE[:7]}",
                "-L",
                "Crestrail develop",
                str(current_path),
                str(base_path),
                str(incoming_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode > 1:
            sys.stderr.buffer.write(result.stderr)
        return result.stdout, result.returncode


def merge_driver(current_path: Path, incoming_path: Path, repo_path: str) -> int:
    current = current_path.read_bytes()
    incoming = brandify(incoming_path.read_bytes())
    base = git_blob(UPSTREAM_BASE, repo_path)
    base = brandify(base) if base is not None else b""
    merged, status = merge_bytes(current, base, incoming)
    current_path.write_bytes(merged)
    return status


def merge_renamed_paths(root: Path) -> int:
    status = 0
    for old_path, new_path in RENAMED_PATHS.items():
        current_path = root / new_path
        current = current_path.read_bytes() if current_path.exists() else b""
        base = brandify(git_blob(UPSTREAM_BASE, old_path) or b"")
        incoming = brandify(git_blob(UPSTREAM_HEAD, old_path) or b"")
        merged, merge_status = merge_bytes(current, base, incoming)
        current_path.parent.mkdir(parents=True, exist_ok=True)
        current_path.write_bytes(merged)
        status = max(status, merge_status)

        obsolete_path = root / old_path
        if obsolete_path.exists():
            obsolete_path.unlink()

    # Remove directories made empty by the path migrations.
    for old_path in RENAMED_PATHS:
        parent = (root / old_path).parent
        while parent != root:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
    return status


def brandify_tree(root: Path) -> None:
    tracked = run_git("ls-files", "-z").stdout.split(b"\0")
    for raw_path in tracked:
        if not raw_path:
            continue
        repo_path = os.fsdecode(raw_path)
        if repo_path in {".gitattributes", "scripts/onebase_merge_driver.py"}:
            continue
        path = root / repo_path
        if not path.is_file():
            continue
        data = path.read_bytes()
        # Branding tokens are ASCII and all relevant source files are UTF-8.
        # Skip binary files to avoid accidental byte-level modifications.
        if b"\0" in data:
            continue
        transformed = brandify(data)
        if transformed != data:
            path.write_bytes(transformed)


def post_merge() -> int:
    root = Path(run_git("rev-parse", "--show-toplevel").stdout.decode().strip())
    status = merge_renamed_paths(root)
    brandify_tree(root)
    return status


def resolve_conflicts() -> int:
    root = Path(run_git("rev-parse", "--show-toplevel").stdout.decode().strip())
    conflicted = run_git(
        "diff", "--name-only", "--diff-filter=U", "-z"
    ).stdout.split(b"\0")
    status = 0
    for raw_path in conflicted:
        if not raw_path:
            continue
        repo_path = os.fsdecode(raw_path)
        current = git_blob("HEAD", repo_path) or b""
        base = brandify(git_blob(UPSTREAM_BASE, repo_path) or b"")
        incoming = brandify(git_blob(UPSTREAM_HEAD, repo_path) or b"")
        merged, merge_status = merge_bytes(current, base, incoming)
        path = root / repo_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(merged)
        if merge_status == 0:
            run_git("add", "--", repo_path)
        status = max(status, merge_status)
    return status


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--post-merge":
        return post_merge()
    if len(sys.argv) == 2 and sys.argv[1] == "--resolve-conflicts":
        return resolve_conflicts()
    if len(sys.argv) != 5:
        print(
            "usage: onebase_merge_driver.py "
            "[--post-merge|--resolve-conflicts|<ancestor> <current> <incoming> <path>]",
            file=sys.stderr,
        )
        return 2
    # The synthetic ancestor supplied by Git is intentionally ignored because
    # these repositories have unrelated root commits.
    _, current, incoming, repo_path = sys.argv[1:]
    return merge_driver(Path(current), Path(incoming), repo_path)


if __name__ == "__main__":
    raise SystemExit(main())
