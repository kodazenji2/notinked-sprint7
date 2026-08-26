/**
 * Simple in-memory cache with a time-to-live (TTL), used to avoid
 * repeatedly hitting Ink's explorer/RPC for the same address within a
 * short window — reduces the chance of hitting rate limits on shared
 * public endpoints during testing and real usage alike.
 *
 * ⚠️ HONEST LIMITATION: like the risk registry, this is a plain
 * in-memory Map — it resets on server restart and does NOT share state
 * across multiple server instances (e.g. multiple Vercel serverless
 * invocations running in parallel won't see each other's cache). This
 * reduces load, it does not guarantee zero duplicate calls under real
 * concurrent traffic. A shared cache (Redis/Upstash) would be the real
 * fix if rate limiting becomes a confirmed, recurring problem — this is
 * the cheap first step, not the final answer.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function getCached<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setCached<T>(key: string, value: T, ttlSeconds: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/**
 * Wraps an async function with caching — call the expensive function
 * only if nothing valid is cached yet for this key.
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  const cached = getCached<T>(key);
  if (cached !== null) return cached;

  const result = await fn();
  setCached(key, result, ttlSeconds);
  return result;
}
