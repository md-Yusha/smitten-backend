const MAX_ENTRIES = 48;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ITEM_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, Buffer>();
let cachedBytes = 0;

export function getCachedVaultMedia(key: string): Buffer | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function setCachedVaultMedia(key: string, data: Buffer) {
  const existing = cache.get(key);
  if (existing) {
    cachedBytes -= existing.length;
    cache.delete(key);
  }

  // Large media is served without staying resident in server memory.
  if (data.length > MAX_ITEM_BYTES) return;

  while (
    cache.size >= MAX_ENTRIES ||
    (cache.size > 0 && cachedBytes + data.length > MAX_BYTES)
  ) {
    const first = cache.keys().next().value;
    if (!first) break;
    const evicted = cache.get(first);
    if (evicted) cachedBytes -= evicted.length;
    cache.delete(first);
  }

  cache.set(key, data);
  cachedBytes += data.length;
}

export function evictCachedVaultMedia(key: string) {
  const existing = cache.get(key);
  if (existing) cachedBytes -= existing.length;
  cache.delete(key);
}
