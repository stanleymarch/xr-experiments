/**
 * Adapted from brvtl/act-it-out src/model/fetchCached.ts (MIT).
 */
export interface FileProgress {
  url: string;
  loaded: number;
  total: number;
  fromCache: boolean;
}

/**
 * Fetches a file once and serves it from the Cache API afterwards, reporting byte progress.
 * URLs are pinned to a revision, so a cached entry never goes stale.
 */
export async function fetchCached(
  url: string,
  cacheName: string,
  onProgress?: (p: FileProgress) => void,
): Promise<Uint8Array> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(url);
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onProgress?.({ url, loaded: bytes.byteLength, total: bytes.byteLength, fromCache: true });
    return bytes;
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  const bytes = await readWithProgress(response, (loaded, total) =>
    onProgress?.({ url, loaded, total, fromCache: false }),
  );
  await cache.put(url, new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }));
  return bytes;
}

async function readWithProgress(
  response: Response,
  onChunk: (loaded: number, total: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onChunk(loaded, total || loaded);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
