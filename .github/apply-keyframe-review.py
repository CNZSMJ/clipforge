#!/usr/bin/env python3
"""Apply the exact audited keyframe patch; no network, inference or user data access."""
from pathlib import Path
import base64, hashlib, lzma, subprocess, zlib
CHUNKS = [f'.github/keyframe-review/chunk{i}.txt' for i in range(5)]
EXPECTED_PATCH = '5047a8a27831d04dd895ca0e05cb313590ede4b82cbf3972810eeb74597d7990'
EXPECTED_TREE = '947ac6dd7b748a2af93d3048fc6941f53cb52161'
data = lzma.decompress(base64.b64decode(''.join(Path(p).read_text() for p in CHUNKS), validate=True))
if len(data) != 281203 or hashlib.sha256(data).hexdigest() != EXPECTED_PATCH:
    raise RuntimeError('Review transfer checksum mismatch; refusing to apply')
subprocess.run(['git', 'apply', '--check', '--index', '--binary', '-'], input=data, check=True)
subprocess.run(['git', 'apply', '--index', '--binary', '-'], input=data, check=True)
# Correct three known transcription artifacts in this temporary transfer only.
encoded = Path('.github/keyframe-review/correction.txt').read_text()
for old, new in [('K7Jzh2IrP18s', 'K7JzhIrP18s'), ('XHzg8/MbX9z', 'XHzg/MbX9z'), ('8H7/x+e8Lff', '8H7/x+8Lff')]:
    encoded = encoded.replace(old, new)
raw = encoded.encode()
if hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest() != '5d0eb02162a8316b94145bc4126e1e641d669c0c':
    raise RuntimeError('Correction transfer differs from audited bytes')
correction = zlib.decompress(base64.b64decode(encoded, validate=True))
if hashlib.sha256(correction).hexdigest() != '212cb8967a1cb4b3615d6daec9cae66e0df9268b8f3a673948488ddeec2b5d52':
    raise RuntimeError('Browser/regrouping correction checksum mismatch')
subprocess.run(['git', 'apply', '--check', '--index', '--binary', '-'], input=correction, check=True)
subprocess.run(['git', 'apply', '--index', '--binary', '-'], input=correction, check=True)
# Stable explicit accessible name, independent of nested <option> text.
filename = Path('src/components/keyframes/keyframe-studio.tsx')
old = '<select className={field} value={role} disabled={!!busy}'
new = '<select className={field} aria-label={tr("上传参考的用途", "Reference role")} value={role} disabled={!!busy}'
text = filename.read_text()
if text.count(old) != 1: raise RuntimeError('Reference selector changed concurrently')
filename.write_text(text.replace(old, new))
filename = Path('src/lib/__tests__/keyframe-studio.test.ts')
text = filename.read_text()
anchor = 'describe("keyframe product UX and billing boundaries", () => {\n'
addition = '''  it("names the reference selector independently from its option labels", async () => {
    await render();
    const role = container.querySelector<HTMLSelectElement>('select[aria-label="Reference role"]');
    expect(role).toBeTruthy();
    expect([...role!.options].map(option => option.value)).toEqual(["product", "character", "scene", "style", "layout"]);
    await act(async () => { role!.value = "layout"; role!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(role!.value).toBe("layout");
    expect(bought()).toEqual([]);
  });
'''
if text.count(anchor) != 1: raise RuntimeError('Reference selector test changed concurrently')
filename.write_text(text.replace(anchor, anchor + addition))
subprocess.run(['git', 'add', '--', 'src/components/keyframes/keyframe-studio.tsx', 'src/lib/__tests__/keyframe-studio.test.ts'], check=True)
subprocess.run(['git', 'rm', '--', '.github/keyframe-review/correction.txt'], check=True)
subprocess.run(['git', 'rm', '--', *CHUNKS, '.github/apply-keyframe-review.py', '.github/workflows/keyframe-review.yml'], check=True)
actual = subprocess.check_output(['git', 'write-tree'], text=True).strip()
if actual != EXPECTED_TREE:
    raise RuntimeError(f'Candidate tree mismatch: {actual}')
print('Verified exact candidate tree:', actual)
