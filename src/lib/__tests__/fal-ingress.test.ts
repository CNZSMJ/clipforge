// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config, proxy } from '@/proxy';
import { withLocalCors, localCorsPreflight } from '../local-cors';
import { POST as probe } from '@/app/api/ai/test-provider/route';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('unbuffered media ingress with route-local CORS', () => {
  it.each(['/api/upload', '/api/products/upload', '/api/media/analyze', '/api/replicate/analyze', '/api/project/test/materials', '/api/project/test/media', '/api/project/test/bgm'])('%s bypasses the Next request clone/truncation path', path => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `http://localhost:3457${path}` })).toBe(false);
  });
  it.each(['/api/ai/video', '/api/project/test/storyboard-grid', '/api/products', '/api/uploads-list'])('%s still receives the normal proxy', path => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: `http://localhost:3457${path}` })).toBe(true);
  });
  it('wraps actual uploads without reading/cloning their body and preserves Vary', async () => {
    const request = new NextRequest('http://localhost:3457/api/upload', { method: 'POST', body: 'stream', headers: { origin: 'http://localhost:3800' } });
    const handler = withLocalCors(async (req: NextRequest) => {
      expect(req).toBe(request); expect(req.bodyUsed).toBe(false);
      return NextResponse.json({ value: await req.text() }, { headers: { Vary: 'Accept-Encoding' } });
    });
    const response = await handler(request);
    expect(await response.json()).toEqual({ value: 'stream' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3800');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding, Origin');
  });
  it('blocks even simple untrusted cross-origin writes before the handler or paid API', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const request = new NextRequest('http://localhost:3457/api/upload', { method: 'POST', body: 'x', headers: { origin: 'https://evil.example' } });
    expect((await withLocalCors(handler)(request)).status).toBe(403);
    expect(handler).not.toHaveBeenCalled(); expect(request.bodyUsed).toBe(false);
    expect(proxy(request).status).toBe(403);
    expect(localCorsPreflight(new NextRequest(request.url, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('supports explicitly trusted deployment origins without wildcard reflection', async () => {
    vi.stubEnv('CLIPFORGE_CORS_ORIGINS', 'https://canvas.example');
    const response = await withLocalCors(async () => NextResponse.json({ ok: true }))(new NextRequest('https://clip.example/api/upload', { method: 'POST', headers: { origin: 'https://canvas.example' } }));
    expect(response.headers.get('access-control-allow-origin')).toBe('https://canvas.example');
  });
});

describe('read-only credential probe does not invent authentication success', () => {
  it.each([[200, 'ok'], [401, 'invalid'], [403, 'invalid'], [404, 'unknown'], [422, 'unknown'], [429, 'unknown'], [500, 'unknown'], [503, 'unknown']])('HTTP %i is %s', async (code, expected) => {
    const fetcher = vi.fn(async () => new Response('{}', { status: Number(code) })); vi.stubGlobal('fetch', fetcher);
    const response = await probe(new NextRequest('http://localhost/api/ai/test-provider', { method: 'POST', body: JSON.stringify({ name: 'fal-ai', apiKey: 'test-key' }) }));
    expect((await response.json()).status).toBe(expected);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/status'), expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Authorization: 'Key test-key' } }));
  });
  it('rejects malformed input without a request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const value of [null, [], { name: 4, apiKey: 'x' }, { name: 'fal-ai', apiKey: 'x', baseUrl: {} }]) {
      expect((await probe(new NextRequest('http://localhost/api/ai/test-provider', { method: 'POST', body: JSON.stringify(value) }))).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
