import { isAddress } from "viem";

/**
 * Nado Points integration.
 *
 * ⚠️ UNVERIFIED ASSUMPTION, same category as everything else built
 * against a third-party API in this project: the exact endpoint path
 * and response field names below are best-effort based on documented
 * API structure (api.prod.nado.xyz/rewards/v1, a `nado_points` query
 * type), but have NOT been tested against a live response from this
 * environment (no network access here). Test against a real wallet
 * before trusting this in production — same pattern as the Blockscout
 * integration earlier in this project, where the first version's field
 * assumptions were wrong and had to be corrected against real data.
 */

const NADO_API_BASE = "https://api.prod.nado.xyz/rewards/v1";

export interface NadoPointsResult {
  address: string;
  hasNadoActivity: boolean;
  currentEpochPoints: number | null;
  allTimePoints: number | null;
  rank: number | null;
  tier: string | null; // "Breeze" through "Tornado"
}

export async function checkNadoPoints(addressInput: string): Promise<NadoPointsResult> {
  if (!isAddress(addressInput)) {
    throw new Error("Not a valid EVM address");
  }
  const address = addressInput;

  try {
    const res = await fetch(`${NADO_API_BASE}/nado_points?address=${address}`);

    if (res.status === 404) {
      // ⚠️ This branch is ambiguous by design right now, and that's a
      // real problem: a 404 could mean "this wallet has no Nado
      // activity" OR "this URL/endpoint structure is wrong entirely."
      // Confirmed via live testing: at least one wallet with verified
      // real on-chain Nado contract interactions (per checkActivity.ts)
      // hit this exact branch — meaning the second explanation
      // (wrong URL) is the more likely one right now, not genuinely
      // zero activity. Surfacing the raw status/body here instead of
      // silently returning a clean "no activity" result, so this
      // doesn't keep masking a URL bug as a data fact.
      const body = await res.text();
      throw new Error(
        `Nado API returned 404 for ${NADO_API_BASE}/nado_points?address=${address} — this may mean the endpoint path is wrong, not that the wallet has no activity. Raw response: ${body.slice(0, 200)}`
      );
    }

    if (!res.ok) {
      throw new Error(`Nado API returned ${res.status}`);
    }

    const data = await res.json();

    return {
      address,
      hasNadoActivity: true,
      currentEpochPoints: data.current_epoch_points ?? data.epoch_points ?? null,
      allTimePoints: data.all_time_points ?? data.total_points ?? null,
      rank: data.rank ?? null,
      tier: data.tier ?? null,
    };
  } catch (err) {
    throw new Error(
      `Could not reach Nado's Rewards API: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

/**
 * Rough estimator only — NOT a precise calculator.
 *
 * Per Nado's own official documentation, the exact scoring formula is
 * intentionally undisclosed: individual share depends on relative
 * activity vs. the whole protocol, PLUS proprietary fee-tier and
 * "toxicity" adjustments (anti-wash-trading measures) that are not
 * public. This function only models the ONE piece that IS publicly
 * documented — the weekly pool size scaling from a 300k floor toward a
 * 950k cap as protocol-wide average daily volume rises — and estimates
 * a rough proportional share from simulated volume. It cannot and does
 * not account for toxicity penalties, fee tier, or the real relative
 * activity of every other participant that week.
 *
 * This exists to give directional intuition ("more relative volume
 * generally means a larger share of a larger pool"), not a number
 * anyone should treat as a prediction of actual rewards.
 */
export function estimateNadoPointsShare(
  simulatedWeeklyVolumeUsd: number,
  protocolAvgDailyVolumeUsd: number
): { estimatedPoolSize: number; roughEstimatedShare: number } {
  const POOL_FLOOR = 300_000;
  const POOL_CAP = 950_000;

  // Simple, clearly-approximate scaling toward the cap as average daily
  // volume rises — the real curve "accelerates at higher volume levels"
  // per Nado's docs, which isn't quantified publicly, so this uses a
  // basic square-root curve as a rough stand-in, not the real formula.
  const volumeScaleFactor = Math.min(1, Math.sqrt(protocolAvgDailyVolumeUsd / 50_000_000));
  const estimatedPoolSize = POOL_FLOOR + (POOL_CAP - POOL_FLOOR) * volumeScaleFactor;

  const protocolWeeklyVolume = protocolAvgDailyVolumeUsd * 7;
  const roughEstimatedShare = protocolWeeklyVolume > 0
    ? (simulatedWeeklyVolumeUsd / (protocolWeeklyVolume + simulatedWeeklyVolumeUsd)) * estimatedPoolSize
    : 0;

  return { estimatedPoolSize, roughEstimatedShare };
}
