#!/usr/bin/env python3
"""Apply the exact audited keyframe patch; no network, inference or user data access."""
from pathlib import Path
import base64, hashlib, lzma, subprocess
CHUNKS = [f'.github/keyframe-review/chunk{i}.txt' for i in range(5)]
EXPECTED_PATCH = '5047a8a27831d04dd895ca0e05cb313590ede4b82cbf3972810eeb74597d7990'
EXPECTED_TREE = 'db414444fe7da1633c0388bcb793e4c1fcd14d98'
data = lzma.decompress(base64.b64decode(''.join(Path(p).read_text() for p in CHUNKS), validate=True))
if len(data) != 281203 or hashlib.sha256(data).hexdigest() != EXPECTED_PATCH:
    raise RuntimeError('Review transfer checksum mismatch; refusing to apply')
subprocess.run(['git', 'apply', '--check', '--index', '--binary', '-'], input=data, check=True)
subprocess.run(['git', 'apply', '--index', '--binary', '-'], input=data, check=True)
subprocess.run(['git', 'rm', '--', *CHUNKS, '.github/apply-keyframe-review.py', '.github/workflows/keyframe-review.yml'], check=True)
actual = subprocess.check_output(['git', 'write-tree'], text=True).strip()
if actual != EXPECTED_TREE:
    raise RuntimeError(f'Candidate tree mismatch: {actual}')
print('Verified exact candidate tree:', actual)
