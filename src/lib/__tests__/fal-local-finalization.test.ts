// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { projects, scripts, assets, compositions, aiTasks, type Shot } from '../db/schema';
const network = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('../ssrf-guard', () => network);
const exec = promisify(execFile);
let root: string;
let db: ReturnType<typeof import('../db')['getDb']>;
let grid: typeof import('../storyboard-grid-persistence');
let film: typeof import('../storyboard-film-persistence');
let ledger: typeof import('../ai-tasks');
let probe: typeof import('../media-probe')['probeMedia'];
let bytes: Buffer;
const shots = (count: number): Shot[] => Array.from({ length: count }, (_, index) => ({ shotId: index + 1, type: 'hook', duration: 1, description: `Frame ${index}`, camera: 'static', visualSource: 'ai_generate', transition: 'direct_concat', voiceover: 'hello' }));
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'clipforge-finalize-')); vi.stubEnv('APP_DATA_DIR', root);
  vi.stubEnv('FFMPEG_PATH', 'ffmpeg'); vi.stubEnv('FFPROBE_PATH', 'ffprobe');
  await mkdir(join(root, 'uploads', 'fixture'), { recursive: true });
  await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x360:rate=1', '-frames:v', '1', '-threads', '1', join(root, 'uploads', 'fixture', 'grid.png')]);
  await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000', '-t', '0.5', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(root, 'fixture.mp4')]);
  bytes = await readFile(join(root, 'fixture.mp4'));
  db = (await import('../db')).getDb();
  grid = await import('../storyboard-grid-persistence'); film = await import('../storyboard-film-persistence'); ledger = await import('../ai-tasks'); probe = (await import('../media-probe')).probeMedia;
}, 30000);
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function project() { return db.insert(projects).values({ name: 'Recovery regression' }).returning().get().id; }

describe('real SQLite and FFmpeg finalization (HTTP only is mocked)', () => {
  it('crops real grid cells, switches the whole selection atomically, and retries idempotently', async () => {
    const id = project(); const s = db.insert(scripts).values({ projectId: id, styleType: 'pain_point', shots: shots(2) }).returning().get();
    for (const shot of shots(2)) db.insert(assets).values({ projectId: id, shotId: shot.shotId, type: 'ai_generated', selected: true, filePath: '/api/files/fixture/grid.png', status: 'done' }).run();
    const mode = grid.storyboardGridMode(s.id, s.shots!);
    const result = await grid.persistStoryboardGrid(id, mode, '/api/files/fixture/grid.png', 'fal-ai', 'fal-ai/gpt-image-2', 'paid-grid');
    expect(result.cells).toHaveLength(2);
    for (const cell of result.cells) {
      const media = await probe(join(root, 'uploads', cell.filePath.replace('/api/files/', '')));
      expect(media.width).toBeGreaterThan(0); expect(media.height).toBeGreaterThan(0);
    }
    let rows = db.select().from(assets).where(eq(assets.projectId, id)).all();
    expect(rows).toHaveLength(4); expect(rows.filter(a => a.selected).map(a => a.filePath)).toEqual(result.cells.map(c => c.filePath));
    await grid.persistStoryboardGrid(id, mode, '/api/files/fixture/grid.png', 'fal-ai', 'fal-ai/gpt-image-2', 'paid-grid');
    rows = db.select().from(assets).where(eq(assets.projectId, id)).all(); expect(rows).toHaveLength(4); expect(rows.filter(a => a.selected)).toHaveLength(2);
    db.update(scripts).set({ shots: shots(3) }).where(eq(scripts.id, s.id)).run();
    await expect(grid.persistStoryboardGrid(id, mode, '/api/files/fixture/grid.png', 'fal-ai', 'model', 'paid-grid')).rejects.toThrow(/脚本已修改/);
    expect(db.select().from(assets).where(eq(assets.projectId, id)).all()).toEqual(rows);
  }, 30000);
  it('failure after preparing some cells never activates a partially changed storyboard', async () => {
    const id = project(); const s = db.insert(scripts).values({ projectId: id, styleType: 'pain_point', shots: shots(10) }).returning().get();
    const old = db.insert(assets).values({ projectId: id, shotId: 1, type: 'ai_generated', selected: true, filePath: '/api/files/fixture/grid.png', status: 'done' }).returning().get();
    await expect(grid.persistStoryboardGrid(id, grid.storyboardGridMode(s.id, s.shots!), '/api/files/fixture/grid.png', 'fal-ai', 'model', 'invalid-grid')).rejects.toThrow(/超过/);
    expect(db.select().from(assets).where(eq(assets.projectId, id)).all()).toEqual([old]);
  }, 30000);
  it('cloud completion stays recoverable until a validated local candidate exists', async () => {
    const id = project(); const task = await ledger.recordAiTask({ projectId: id, shotId: 1, provider: 'fal-ai', model: 'model', taskId: 'paid-local', mediaType: 'image' });
    await ledger.updateAiTask(task, { status: 'download_pending', resultUrls: ['https://fal.media/paid.png'] });
    expect((await ledger.listAiTasks(id, true)).map(t => t.status)).toEqual(['download_pending']);
    await ledger.markAiTaskDownloaded(id, 1, 'https://fal.media/paid.png', '/api/files/fixture/grid.png');
    expect(await ledger.listAiTasks(id, true)).toEqual([]);
    expect(db.select().from(aiTasks).where(eq(aiTasks.id, task!)).get()).toMatchObject({ status: 'completed', resultUrls: ['/api/files/fixture/grid.png'] });
  });
  it('persists a real video+audio film once and recovers locally after CDN expiry', async () => {
    network.safeFetch.mockImplementation(async () => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }));
    const id = project(); const first = await film.persistGeneratedFilm(id, 'https://fal.media/film.mp4', 'bytedance/seedance-2.5/reference-to-video', 'paid-film');
    const saved = db.select().from(compositions).where(eq(compositions.projectId, id)).all();
    expect(saved).toHaveLength(1); expect(saved[0].status).toBe('done'); expect((await probe(saved[0].outputPath!)).hasAudio).toBe(true);
    network.safeFetch.mockRejectedValue(new Error('expired CDN'));
    const second = await film.persistGeneratedFilm(id, 'https://fal.media/film.mp4', 'model', 'paid-film');
    expect(second).toEqual(first); expect(db.select().from(compositions).where(eq(compositions.projectId, id)).all()).toHaveLength(1);
  }, 15000);
  it('rejects HTML pretending to be a video without creating a completed composition', async () => {
    const id = project(); network.safeFetch.mockImplementation(async () => new Response('<html>not media</html>', { headers: { 'content-type': 'video/mp4' } }));
    await expect(film.persistGeneratedFilm(id, 'https://fal.media/broken.mp4', 'model', 'paid-broken')).rejects.toThrow();
    expect(db.select().from(compositions).where(eq(compositions.projectId, id)).all()).toEqual([]);
  });
});
