import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCached } from '../src/agent/omni/fetch-cached';

const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const store = new Map<string, Response>();

const cachesMock = {
  open: async (name: string) => ({
    match: async (url: string) => store.get(`${name}:${url}`) ?? undefined,
    put: async (url: string, response: Response) => { store.set(`${name}:${url}`, response); },
  }),
};

beforeEach(() => {
  store.clear();
  vi.stubGlobal('caches', cachesMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('fetchCached', () => {
  it('downloads with byte progress and stores the entry', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(payload, { headers: { 'content-length': String(payload.byteLength) } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const progress: { loaded: number; total: number; fromCache: boolean }[] = [];
    const bytes = await fetchCached('https://example.test/a.onnx', 'cache-a', (p) => progress.push({ ...p }));

    expect(bytes).toEqual(payload);
    expect(progress.at(-1)).toEqual({
      url: 'https://example.test/a.onnx',
      loaded: payload.byteLength,
      total: payload.byteLength,
      fromCache: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.has('cache-a:https://example.test/a.onnx')).toBe(true);
  });

  it('serves the second call from the cache without refetching', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(payload, { headers: { 'content-length': String(payload.byteLength) } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchCached('https://example.test/a.onnx', 'cache-a');

    const progress: { fromCache: boolean }[] = [];
    const bytes = await fetchCached('https://example.test/a.onnx', 'cache-a', (p) => progress.push({ ...p }));
    expect(bytes).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(progress.at(-1)?.fromCache).toBe(true);
  });

  it('reports HTTP failures instead of serving garbage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
    await expect(fetchCached('https://example.test/missing.onnx', 'cache-a')).rejects.toThrow(/HTTP 404/);
  });
});
