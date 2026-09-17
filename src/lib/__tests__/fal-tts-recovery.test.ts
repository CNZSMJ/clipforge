// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const mocks = vi.hoisted(() => ({ submitFalTask: vi.fn(), readFalTask: vi.fn(), downloadMediaBuffer: vi.fn() }));
vi.mock('../providers/fal-queue', () => mocks);
vi.mock('../media-download', () => mocks);
import { generateFalSpeech, clearCompletedFalSpeech } from '../fal-tts';
import { ProviderError } from '../providers/base';
import type { TTSConfig } from '../tts';
let dir: string;
const text = 'Keep the original narration job';
const config: TTSConfig = { provider: 'falai', apiKey: 'private-key', baseUrl: 'https://queue.fal.run', model: 'fal-ai/minimax/speech-02-hd', voice: 'Wise_Woman', speed: 1, emotion: 'happy' };
const journal = () => join(dir, 'cache', 'tts', 'fal-pending');
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clipforge-tts-')); vi.stubEnv('APP_DATA_DIR', dir);
  mocks.submitFalTask.mockReset().mockResolvedValue('fal-ai/minimax/speech-02-hd::paid-1');
  mocks.readFalTask.mockReset().mockResolvedValue({ status: 'completed', data: { audio: { url: 'https://fal.media/narration.mp3' } } });
  mocks.downloadMediaBuffer.mockReset().mockResolvedValue(Buffer.from('mp3'));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
describe('durable narration without duplicate paid submissions', () => {
  it('submits once, asks for URL output, and persists only a recoverable handle (not text/key)', async () => {
    expect(await generateFalSpeech(text, config)).toEqual(Buffer.from('mp3'));
    expect(mocks.submitFalTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ apiKey: 'private-key' }), config.model, expect.objectContaining({ text, output_format: 'url', voice_setting: expect.objectContaining({ voice_id: 'Wise_Woman', emotion: 'happy', speed: 1 }) }));
    const files = await readdir(journal()); expect(files).toHaveLength(1);
    const saved = await readFile(join(journal(), files[0]), 'utf8');
    expect(saved).toContain('paid-1'); expect(saved).not.toContain('private-key'); expect(saved).not.toContain(text);
    await clearCompletedFalSpeech(text, config); expect(await readdir(journal())).toEqual([]);
  });
  it('a failed download retains the paid task and the next invocation only re-reads it', async () => {
    mocks.downloadMediaBuffer.mockRejectedValueOnce(new Error('CDN unavailable')).mockRejectedValueOnce(new Error('CDN unavailable')).mockRejectedValueOnce(new Error('CDN unavailable'));
    await expect(generateFalSpeech(text, config)).rejects.toThrow(/原任务已保留/);
    expect(mocks.submitFalTask).toHaveBeenCalledTimes(1);
    expect(await generateFalSpeech(text, config)).toEqual(Buffer.from('mp3'));
    expect(mocks.submitFalTask).toHaveBeenCalledTimes(1); expect(mocks.readFalTask).toHaveBeenCalledTimes(4);
  }, 10000);
  it('coalesces concurrent identical narration calls', async () => {
    await Promise.all([generateFalSpeech(text, config), generateFalSpeech(text, config)]);
    expect(mocks.submitFalTask).toHaveBeenCalledTimes(1); expect(mocks.downloadMediaBuffer).toHaveBeenCalledTimes(1);
  });
  it('recovers a handle created by a prior process without submitting', async () => {
    const key = createHash('sha256').update(JSON.stringify([text, config.baseUrl, config.model, config.voice, config.speed, config.emotion, config.apiKey])).digest('hex');
    await mkdir(journal(), { recursive: true }); await writeFile(join(journal(), `${key}.json`), JSON.stringify({ taskId: 'fal-ai/minimax/speech-02-hd::previous-process' }));
    await generateFalSpeech(text, config);
    expect(mocks.submitFalTask).not.toHaveBeenCalled(); expect(mocks.readFalTask).toHaveBeenCalledWith(expect.anything(), 'fal-ai/minimax/speech-02-hd::previous-process');
  });
  it('terminal failure clears the journal but never silently resubmits in the current operation', async () => {
    mocks.readFalTask.mockResolvedValue({ status: 'failed', error: 'moderation rejected' });
    await expect(generateFalSpeech(text, config)).rejects.toMatchObject({ code: 'TASK_FAILED' });
    expect(mocks.submitFalTask).toHaveBeenCalledTimes(1); expect(await readdir(journal())).toEqual([]);
  });
  it('retains a pre-submit intent after an ambiguous acknowledgement failure', async () => {
    mocks.submitFalTask.mockRejectedValue(new ProviderError('Connection lost', 'SUBMISSION_UNKNOWN', 'fal-ai'));
    await expect(generateFalSpeech(text, config)).rejects.toMatchObject({ code: 'SUBMISSION_UNKNOWN' });
    const files = await readdir(journal()); expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(journal(), files[0]), 'utf8')).state).toBe('submitting');
    expect(mocks.submitFalTask).toHaveBeenCalledTimes(1);
  });
  it('rejects an oversized script and non-finite speed before a paid POST', async () => {
    await expect(generateFalSpeech('x'.repeat(5001), config)).rejects.toThrow(/5000/);
    await expect(generateFalSpeech(text, { ...config, speed: NaN })).rejects.toThrow(/有限/);
    expect(mocks.submitFalTask).not.toHaveBeenCalled();
  });
});
