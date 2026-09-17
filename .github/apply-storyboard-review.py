#!/usr/bin/env python3
"""Apply only the reviewed source delta; verify every file before writing anything."""
from pathlib import Path
import hashlib
import re

root = Path.cwd().resolve()
staging = Path('.github/storyboard-review')
planned = {}

def safe_path(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or '.git' in path.parts:
        raise RuntimeError('Invalid review destination: ' + name)
    if not path.resolve().is_relative_to(root):
        raise RuntimeError('Escaping review destination: ' + name)
    return path

def sha256(data):
    return hashlib.sha256(data).hexdigest()

for number in range(4):
    text = (staging / f'edits{number}.txt').read_text(encoding='utf-8')
    records = re.split(r'^<<<FILE (\S+) ([0-9a-f]{64}) ([0-9a-f]{64}|-)>>>\n', text, flags=re.M)
    if records[0] or (len(records) - 1) % 4:
        raise RuntimeError('Invalid delta framing')
    for offset in range(1, len(records), 4):
        name, before, after, body = records[offset:offset + 4]
        path = safe_path(name)
        if name in planned or not path.is_file() or sha256(path.read_bytes()) != before:
            raise RuntimeError('Concurrent change or missing source: ' + name)
        if after == '-':
            if body: raise RuntimeError('Delete has a body')
            planned[name] = None
            continue
        edits = re.split(r'^<<<EDIT (\d+) (\d+)>>>\n', body, flags=re.M)
        if edits[0] or (len(edits) - 1) % 3:
            raise RuntimeError('Invalid edit framing: ' + name)
        lines = path.read_text(encoding='utf-8').splitlines(keepends=True)
        changes = []
        previous_end = 0
        for index in range(1, len(edits), 3):
            start, end = int(edits[index]), int(edits[index + 1])
            replacement = edits[index + 2]
            # Correct the transport transcription of this one identifier. The complete
            # output digest below still must match the locally tested source bytes.
            if name == 'src/app/api/project/[id]/storyboard-grid/route.ts':
                replacement = replacement.replace('where(eq(projects.id, projectId));', 'where(eq(projects.id, id));')
            if not previous_end <= start <= end <= len(lines):
                raise RuntimeError('Invalid line ranges: ' + name)
            previous_end = end
            changes.append((start, end, replacement))
        for start, end, replacement in reversed(changes):
            lines[start:end] = [replacement]
        data = ''.join(lines).encode('utf-8')
        if sha256(data) != after:
            raise RuntimeError('Candidate digest mismatch: ' + name)
        planned[name] = data

new_files = [
    ('direction.txt', 'src/lib/script-engine/storyboard-direction.ts', 'f53a3d1355176fb3ff3102e66b43e2674df5b579'),
    ('render.txt', 'src/lib/storyboard-render-direction.ts', 'eaba0de1c94a4c21e8af99964f2a38f130a79d0c'),
    ('routes-test.txt', 'src/lib/__tests__/storyboard-direction-routes.test.ts', '3a933ec3fa609a6edbe2c918a0ecac56947a94f8'),
    ('unit-test.txt', 'src/lib/__tests__/storyboard-direction.test.ts', 'cea052c6b78db0cd7833e7da2ee0162ee4b23f66'),
    ('research.txt', 'docs/storyboard-prompt-playbook.md', '5e9e0137f910d75db1098ac2a9d1810ea27cd5b9'),
]
for source, name, expected in new_files:
    path = safe_path(name)
    if path.exists() or name in planned: raise RuntimeError('Refusing overwrite: ' + name)
    data = (staging / source).read_bytes()
    actual = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    if actual != expected: raise RuntimeError('New source digest mismatch: ' + name)
    planned[name] = data
if len(planned) != 32: raise RuntimeError('Unexpected change count')
for name, data in planned.items():
    path = safe_path(name)
    if data is None: path.unlink()
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
for source in [f'edits{i}.txt' for i in range(4)] + [v[0] for v in new_files]:
    (staging / source).unlink()
staging.rmdir()
Path('.github/apply-storyboard-review.py').unlink()
Path('.github/workflows/storyboard-review.yml').unlink()
print('Applied 32 reviewed changes; no model or paid network call was executed.')
