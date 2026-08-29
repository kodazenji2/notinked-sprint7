import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "./redisClient";

const FREE_DAILY_LIMIT = 5;
const PREMIUM_DAILY_LIMIT = 100;

const FREE_LIMITER = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(FREE_DAILY_LIMIT, "1 d"),
  prefix: "notinked:free-rate-limit",
  analytics: false,
  ephemeralCache: false,
});

const PREMIUM_LIMITER = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(PREMIUM_DAILY_LIMIT, "1 d"),
  prefix: "notinked:premium-rate-limit",
  analytics: false,
  ephemeralCache: false,
});

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetsAt: string;
}

function normalizeIdentifier(identifier: string): string {
  return (identifier || "anonymous").trim().toLowerCase();
}

function toIsoReset(resetMs: number): string {
  return new Date(resetMs).toISOString();
}

export async function checkAndIncrement(
  identifier: string,
  isPremium: boolean
): Promise<RateLimitResult> {
  const limiter = isPremium ? PREMIUM_LIMITER : FREE_LIMITER;
  const key = normalizeIdentifier(identifier);
  const result = await limiter.limit(key);

  return {
    allowed: result.success,
    remaining: Math.max(0, result.remaining),
    limit: result.limit,
    resetsAt: toIsoReset(result.reset),
  };
}

export async function getUsage(identifier: string, isPremium: boolean): Promise<RateLimitResult> {
  const limiter = isPremium ? PREMIUM_LIMITER : FREE_LIMITER;
  const key = normalizeIdentifier(identifier);
  const remaining = await limiter.getRemaining(key);

  return {
    allowed: remaining.remaining > 0,
    remaining: Math.max(0, remaining.remaining),
    limit: remaining.limit,
    resetsAt: toIsoReset(remaining.reset),
  };
}
