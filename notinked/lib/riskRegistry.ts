import type { Address } from "viem";
import { redis } from "./redisClient";

export interface RiskEntry {
  address: Address;
  category: "drainer" | "phishing" | "rug" | "unlimited-approval-abuse" | "other";
  reason: string;
  source: string;
  status: "pending" | "confirmed";
  txHash: string;
  reporterCount: number;
  reporterIds: string[];
  addedAt: string;
}

export const REGISTRY_VERSION = "0.1.0";
export const RISK_INDEX_KEY = "risk:index";
export const RISK_REGISTRY: RiskEntry[] = [];

const toRiskKey = (address: string): string => `risk:${address.toLowerCase()}`;

export async function clearRiskRegistry(): Promise<void> {
  const addresses = (await redis.smembers<string>(RISK_INDEX_KEY)) ?? [];

  if (addresses.length === 0) {
    return;
  }

  const keys = addresses.map((address) => toRiskKey(address));
  if (keys.length > 0) {
    await redis.del(...keys, RISK_INDEX_KEY);
  }
}

export async function listRiskEntries(): Promise<RiskEntry[]> {
  const addresses = (await redis.smembers<string>(RISK_INDEX_KEY)) ?? [];
  if (addresses.length === 0) return [];

  const entries = await redis.mget<RiskEntry | null>(addresses.map((address) => toRiskKey(address)));
  return (entries ?? []).filter((entry): entry is RiskEntry => Boolean(entry));
}

export async function addRiskEntry(
  entry: Omit<RiskEntry, "status" | "reporterCount" | "reporterIds">,
  reporterId = entry.source
): Promise<RiskEntry> {
  const normalizedAddress = entry.address.toLowerCase() as Address;
  const key = toRiskKey(normalizedAddress);
  const existing = await redis.get<RiskEntry | null>(key);

  if (!existing) {
    const pendingEntry: RiskEntry = {
      ...entry,
      address: normalizedAddress,
      status: "pending",
      reporterCount: 1,
      reporterIds: [reporterId],
    };

    await redis.set(key, pendingEntry);
    await redis.sadd(RISK_INDEX_KEY, normalizedAddress);
    return pendingEntry;
  }

  if (existing.status === "pending") {
    const reporterIds = Array.from(new Set([...(existing.reporterIds ?? []), reporterId]));
    const nextCount = reporterIds.length;
    const updated: RiskEntry = {
      ...existing,
      address: normalizedAddress,
      reporterIds,
      reporterCount: nextCount,
      status: nextCount >= 3 ? "confirmed" : "pending",
      txHash: existing.txHash || entry.txHash,
      reason: existing.reason || entry.reason,
      source: existing.source || entry.source,
      addedAt: existing.addedAt || entry.addedAt,
    };

    await redis.set(key, updated);
    return updated;
  }

  return existing;
}

export async function autoFlagIfRisky(
  address: string,
  risk: "red" | "yellow" | "green",
  reasons: string[],
  txHash?: string,
  reporterId?: string
): Promise<RiskEntry | undefined> {
  if (
    risk === "green" ||
    !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    !txHash ||
    !/^0x[0-9a-fA-F]{64}$/.test(txHash)
  ) return undefined;

  return addRiskEntry({
    address: address as Address,
    category: "other",
    reason: reasons.join(" ") || `Automatically detected ${risk} risk.`,
    source: "automated detection",
    txHash,
    addedAt: new Date().toISOString(),
  }, reporterId ?? "automated detection");
}

export async function isKnownRisk(address: string): Promise<RiskEntry | undefined> {
  const entry = await redis.get<RiskEntry | null>(toRiskKey(address));
  return entry && entry.status === "confirmed" ? entry : undefined;
}
