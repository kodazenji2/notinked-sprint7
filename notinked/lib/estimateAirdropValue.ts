/**
 * Ink Rewards Value Estimator — a forward-looking projection tool, NOT
 * an activity-based predictor.
 *
 * This is deliberately built the same way real community tools (e.g.
 * nado-calculator.vercel.app) actually work: pure math on user-supplied
 * assumptions, with zero live API dependency for the calculation
 * itself. This is the one piece of "Nado/Tydro points tooling" that can
 * be built to real completeness — the activity-based prediction these
 * community tools DON'T attempt either, because the underlying scoring
 * formulas are intentionally undisclosed by the protocols themselves.
 * See lib/checkNadoActivity.ts and lib/checkTydroRewards.ts for the
 * real-data pieces this can be seeded from.
 */

export interface ValueEstimateInput {
  yourPoints: number;
  totalPointsSupply: number;
  airdropTokenSupply: number; // total $INK tokens allocated to this airdrop pool
  assumedFdvUsd: number; // fully diluted valuation assumption
  totalTokenSupply: number; // total $INK supply (for price-per-token math)
}

export interface ValueEstimateResult {
  yourShareOfPool: number; // 0-1
  estimatedTokenAllocation: number;
  assumedTokenPriceUsd: number;
  estimatedValueUsd: number;
}

export function estimateAirdropValue(input: ValueEstimateInput): ValueEstimateResult {
  const {
    yourPoints,
    totalPointsSupply,
    airdropTokenSupply,
    assumedFdvUsd,
    totalTokenSupply,
  } = input;

  const yourShareOfPool = totalPointsSupply > 0 ? yourPoints / totalPointsSupply : 0;
  const estimatedTokenAllocation = yourShareOfPool * airdropTokenSupply;
  const assumedTokenPriceUsd = totalTokenSupply > 0 ? assumedFdvUsd / totalTokenSupply : 0;
  const estimatedValueUsd = estimatedTokenAllocation * assumedTokenPriceUsd;

  return {
    yourShareOfPool,
    estimatedTokenAllocation,
    assumedTokenPriceUsd,
    estimatedValueUsd,
  };
}
