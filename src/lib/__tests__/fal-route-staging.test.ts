// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const m = vi.hoisted(() => ({ createProvider: vi.fn(), recordAiTask: vi.fn(), updateAiTask: vi.fn(), upload: vi.fn(), image: vi.fn(), video: vi.fn(), wait: vi.fn() }));
vi.mock('../providers', () => ({ createProvider: m.createProvider }));
vi.mock('../ai-tasks', () => ({ recordAiTask: m.recordAiTask, updateAiTask: m.updateAiTask }));
import { POST as image } from '@/app/api/ai/image/route';
import { POST as video } from '@/app/api/ai/video/route';
let dir: string;
const request = (body: object) => new NextRequest('http://localhost/api/ai/video', { method: 'POST', body: JSON.stringify(body) });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clipforge-stage-')); vi.stubEnv('APP_DATA_DIR', dir); await mkdir(join(dir, 'uploads', 'p'), { recursive: true });
  for (const file of ['a.png', 'b.png', 'c.mp4', 'd.mp3']) await writeFile(join(dir, 'uploads', 'p', file), 'sample');
  for (const mock of Object.values(m)) mock.mockReset();
  m.upload.mockImplementation(async (path: string) => `https://fal.media/${path.split('/').at(-1)}`);
  m.createProvider.mockReturnValue({ name: 'fal-ai', uploadLocalMedia: m.upload, submitImageTask: m.image, submitVideoTask: m.video, waitForTask: m.wait });
  m.recordAiTask.mockResolvedValue('ledger-row');
  m.image.mockResolvedValue({ taskId: 'image-paid', modelId: 'fal-ai/gpt-image-2/edit' });
  m.video.mockResolvedValue({ taskId: 'video-paid', modelId: 'bytedance/seedance-2.5/reference-to-video' });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
describe('staged URLs and persisted recovery reach actual generation entrypoints', () => {
  it('image payload uses successful uploaded URLs, not local URLs or option overrides', async () => {
    m.wait.mockResolvedValue({ status: 'completed', result: { imageUrls: ['https://fal.media/generated.png'] } });
    const response = await image(request({ provider: 'fal-ai', model: 'fal-ai/gpt-image-2', prompt: 'approved', apiKey: 'k', projectId: 'p', shotId: 1, imageUrl: '/api/files/p/a.png', imageUrls: ['/api/files/p/b.png'], options: { prompt: 'tampered', modelId: 'tampered', referenceImageUrl: '/api/files/private.png' } }));
    expect(response.status).toBe(200);
    expect(m.image).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'approved', modelId: 'fal-ai/gpt-image-2', referenceImageUrl: 'https://fal.media/a.png', referenceImageUrls: ['https://fal.media/b.png'] }));
    expect(m.recordAiTask.mock.invocationCallOrder[0]).toBeLessThan(m.wait.mock.invocationCallOrder[0]);
    expect(m.updateAiTask).toHaveBeenCalledWith('ledger-row', expect.objectContaining({ status: 'download_pending' }));
  });
  it('reference video preserves staged image/video/audio arrays in order', async () => {
    m.wait.mockResolvedValue({ status: 'completed', result: { videoUrls: ['https://fal.media/generated.mp4'] } });
    const response = await video(request({ provider: 'fal-ai', model: 'bytedance/seedance-2.5/reference-to-video', prompt: 'same character', apiKey: 'k', referenceImageUrls: ['/api/files/p/a.png', '/api/files/p/b.png'], referenceVideoUrls: ['/api/files/p/c.mp4'], referenceAudioUrls: ['/api/files/p/d.mp3'], options: { duration: 8, audioEnabled: true } }));
    expect(response.status).toBe(200);
    expect(m.video).toHaveBeenCalledWith(expect.objectContaining({ referenceImageUrls: ['https://fal.media/a.png', 'https://fal.media/b.png'], referenceVideoUrls: ['https://fal.media/c.mp4'], referenceAudioUrls: ['https://fal.media/d.mp3'] }));
    expect(m.recordAiTask.mock.invocationCallOrder[0]).toBeLessThan(m.wait.mock.invocationCallOrder[0]);
    expect(m.updateAiTask).toHaveBeenCalledWith('ledger-row', expect.objectContaining({ status: 'download_pending' }));
  });
  it('upload failure cannot silently switch to inline data or a reference-free paid generation', async () => {
    m.upload.mockRejectedValue(new Error('storage unavailable'));
    const response = await image(request({ provider: 'fal-ai', model: 'fal-ai/gpt-image-2', prompt: 'same product', apiKey: 'k', imageUrl: '/api/files/p/a.png' }));
    expect(response.status).toBe(400); expect(m.image).not.toHaveBeenCalled(); expect(m.video).not.toHaveBeenCalled();
  });
  it('a poll failure returns the original paid handle and retains it as recoverable', async () => {
    m.wait.mockRejectedValue(new Error('poll timed out'));
    const response = await image(request({ provider: 'fal-ai', model: 'fal-ai/gpt-image-2', prompt: 'approved', apiKey: 'k' }));
    expect(response.status).toBe(504); expect(await response.json()).toMatchObject({ taskId: 'image-paid', recoverable: true });
    expect(m.image).toHaveBeenCalledTimes(1); expect(m.updateAiTask).toHaveBeenCalledWith('ledger-row', expect.objectContaining({ status: 'unknown' }));
  });
});
