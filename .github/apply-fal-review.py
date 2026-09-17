"""Temporary deterministic publisher for the explicitly authorized Fal review.
No downloads, inference, secrets or dynamic evaluation; removed by this script.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import subprocess
import sys

ROOT = Path.cwd().resolve()
EXPECTED_ARCHIVE = "6aab8d795f690c83df6ec290dbd3b700f538b6c5c29ef127b7dc279d5c3fc2a2"
EXPECTED_TREE = "b93de2af5bc453a2cb5f14fb411ec24d9476de53"
WORKFLOW = Path(".github/workflows/apply-fal-review.yml")
parts = [Path(f".github/fal-review-ops.{i:02d}.brpart") for i in range(7)]
archive = b"".join(p.read_bytes() for p in parts)
assert hashlib.sha256(archive).hexdigest() == EXPECTED_ARCHIVE, "Payload checksum mismatch"
raw = subprocess.run(
    ["node", "-e", "process.stdout.write(require('node:zlib').brotliDecompressSync(require('node:fs').readFileSync(0), {maxOutputLength: 10000000}))"],
    input=archive, stdout=subprocess.PIPE, check=True,
).stdout
changes = json.loads(raw)["changes"]
assert len(changes) == 88
seen = set()
for change in changes:
    name = change["path"]
    path = PurePosixPath(name)
    assert not path.is_absolute() and not any(x in ("..", ".git") for x in path.parts)
    assert name not in seen and not name.startswith(".github/workflows/")
    seen.add(name)
    dest = ROOT / name
    assert dest.resolve().is_relative_to(ROOT) and not dest.is_symlink()
    before = change["before"]
    if before is None:
        assert not dest.exists(), f"New path already exists: {name}"
    else:
        assert hashlib.sha256(dest.read_bytes()).hexdigest() == before, f"Source changed: {name}"

# Validate every preimage before writing any file. Line edits are applied backwards.
for change in changes:
    dest = ROOT / change["path"]
    if change.get("delete"):
        dest.unlink()
        continue
    if "content" in change:
        text = change["content"]
    else:
        lines = dest.read_bytes().decode("utf-8").splitlines(keepends=True)
        for start, end, replacement in reversed(change["edits"]):
            assert 0 <= start <= end <= len(lines)
            lines[start:end] = replacement.splitlines(keepends=True)
        text = "".join(lines)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(text.encode("utf-8"))

# The native connector removes the final unchanged workflow after publishing.
workflow_bytes = WORKFLOW.read_bytes()
for path in [*parts, Path(".github/apply-fal-review.py"), WORKFLOW]:
    path.unlink()
subprocess.run(["git", "add", "-A"], check=True)
tree = subprocess.check_output(["git", "write-tree"], text=True).strip()
assert tree == EXPECTED_TREE, f"Final source tree mismatch: {tree}"
print(f"Verified {len(changes)} application changes; final tree {tree}", flush=True)
if "--publish" in sys.argv:
    WORKFLOW.write_bytes(workflow_bytes)
    subprocess.run(["git", "add", "--", str(WORKFLOW)], check=True)
    workflow_diff = subprocess.check_output(
        ["git", "diff", "--cached", "--name-only", "--", ".github/workflows/"], text=True
    ).strip()
    assert not workflow_diff, f"Publishing token must not modify workflows: {workflow_diff}"
