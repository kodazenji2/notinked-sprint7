import type { Address } from "viem";

/**
 * Open, public risk registry for Ink chain addresses.
 *
 * This is the piece other Ink builders (Tydro, Nado, or anyone else) can
 * depend on directly via /api/public/risk-list, instead of maintaining
 * their own scam-address list. Keep entries factual and sourced — this
 * becomes a public trust surface, not just internal config.
 *
 * TODO before real launch: move this to a real datastore with a
 * contribution/review process instead of a hardcoded array, and pull in
 * a live feed (GoPlus Security API or similar) as a second source.
 */

export interface RiskEntry {
  address: Address;
  category: "drainer" | "phishing" | "rug" | "unlimited-approval-abuse" | "other";
  reason: string;
  source: string;
  status: "pending" | "confirmed";
  txHash: string;
  reporterCount: number;
  reporterIds: string[];
  addedAt: string; // ISO date
}

export const REGISTRY_VERSION = "0.1.0";

export const RISK_REGISTRY: RiskEntry[] = [
  // Seed with real, sourced entries before launch. Example shape:
  // {
  //   address: "0x0000000000000000000000000000000000dEaD",
  //   category: "drainer",
  //   reason: "Reported wallet-drainer contract, multiple victim reports",
  //   source: "community report",
  //   addedAt: "2026-08-24",
  // },
];

export function addRiskEntry(
  entry: Omit<RiskEntry, "status" | "reporterCount" | "reporterIds">,
  reporterId = entry.source
): RiskEntry {
  const existing = RISK_REGISTRY.find(
    (registered) => registered.address.toLowerCase() === entry.address.toLowerCase()
  );

  if (!existing) {
    const pendingEntry: RiskEntry = {
      ...entry,
      status: "pending",
      reporterCount: 1,
      reporterIds: [reporterId],
    };
    RISK_REGISTRY.push(pendingEntry);
    return pendingEntry;
  }

  if (existing.status === "pending") {
    if (!existing.reporterIds.includes(reporterId)) {
      existing.reporterIds.push(reporterId);
      existing.reporterCount = existing.reporterIds.length;
    }
    if (existing.reporterCount >= 3) {
      existing.status = "confirmed";
    }
  }

  return existing;
}

export function autoFlagIfRisky(
  address: string,
  risk: "red" | "yellow" | "green",
  reasons: string[],
  txHash?: string,
  reporterId?: string
): RiskEntry | undefined {
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

export function isKnownRisk(address: string): RiskEntry | undefined {
  return RISK_REGISTRY.find(
    (e) => e.status === "confirmed" && e.address.toLowerCase() === address.toLowerCase()
  );
}
