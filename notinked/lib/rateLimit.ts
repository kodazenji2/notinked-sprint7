/**
 * MVP rate limiter — in-memory Map, resets daily.
 *
 * ⚠️ This resets on server restart and won't work across multiple server
 * instances. Before real deployment, swap the Map for Redis (Upstash has a
 * free tier that fits this exactly) or a Postgres table with a
 * (user_id, date) unique key. The interface below (`checkAndIncrement`)
 * is designed to stay the same when you make that swap.
 */

const FREE_DAILY_LIMIT = 5;
const PREMIUM_DAILY_LIMIT = 100; // effectively unlimited for normal use

interface UsageRecord {
  date: string; // YYYY-MM-DD, UTC
  count: number;
}

const usageStore = new Map<string, UsageRecord>();

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetsAt: string; // ISO timestamp of next UTC midnight
}

function nextMidnightUTC(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
  return next.toISOString();
}

/**
 * Checks whether `identifier` (wallet address, account id, etc.) can make
 * another request today, and increments their count if so.
 */
export function checkAndIncrement(
  identifier: string,
  isPremium: boolean
): RateLimitResult {
  const limit = isPremium ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const today = todayUTC();
  const key = identifier.toLowerCase();

  const existing = usageStore.get(key);
  const current = existing && existing.date === today ? existing.count : 0;

  if (current >= limit) {
    return { allowed: false, remaining: 0, limit, resetsAt: nextMidnightUTC() };
  }

  usageStore.set(key, { date: today, count: current + 1 });

  return {
    allowed: true,
    remaining: limit - (current + 1),
    limit,
    resetsAt: nextMidnightUTC(),
  };
}

/** Read-only check, does not increment. Useful for showing remaining count in UI. */
export function getUsage(identifier: string, isPremium: boolean): RateLimitResult {
  const limit = isPremium ? PREMIUM_DAILY_LIMIT : FREE_DAILY_LIMIT;
  const today = todayUTC();
  const key = identifier.toLowerCase();
  const existing = usageStore.get(key);
  const current = existing && existing.date === today ? existing.count : 0;

  return {
    allowed: current < limit,
    remaining: Math.max(0, limit - current),
    limit,
    resetsAt: nextMidnightUTC(),
  };
}
