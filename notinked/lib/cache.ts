import { redis } from "./redisClient";

export async function getCached<T>(key: string): Promise<T | null> {
  return (await redis.get<T | null>(key)) ?? null;
}

export async function setCached<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  await redis.set(key, value, { ex: ttlSeconds });
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
  const cached = await getCached<T>(key);
  if (cached !== null) return cached;

  const result = await fn();
  await setCached(key, result, ttlSeconds);
  return result;
}
