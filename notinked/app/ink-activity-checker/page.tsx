"use client";

import { useState } from "react";
import type { ActivityCheckResult } from "../../lib/checkActivity";
import type { TydroRewardsResult } from "../../lib/checkTydroRewards";
import { estimateAirdropValue } from "../../lib/estimateAirdropValue";

export default function ActivityCheckerPage() {
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ActivityCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tydroResult, setTydroResult] = useState<TydroRewardsResult | null>(null);
  const [tydroError, setTydroError] = useState<string | null>(null);

  async function handleCheck() {
    setLoading(true);
    setError(null);
    setResult(null);
    setTydroResult(null);
    setTydroError(null);

    const activityPromise = fetch("/api/activity-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    });
    const tydroPromise = fetch("/api/tydro-rewards-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    });

    try {
      const res = await activityPromise;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Check failed");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }

    try {
      const tydroRes = await tydroPromise;
      const tydroData = await tydroRes.json();
      if (tydroRes.ok) {
        setTydroResult(tydroData);
      } else {
        setTydroError(tydroData.error || "Could not reach Merkl's API");
      }
    } catch (e) {
      setTydroError(e instanceof Error ? e.message : "Could not reach Merkl's API");
    }

    setLoading(false);
  }

  const protocolEntries = result ? Object.entries(result.protocolInteractions) : [];

  return (
    <main className="max-w-xl mx-auto px-5 py-16">
      <div className="text-center mb-8">
        <div className="text-primary text-xs font-mono tracking-widest uppercase mb-3">
          Ink Chain · Unofficial
        </div>
        <h1 className="text-3xl font-bold mb-2">Wallet Activity</h1>
        <p className="text-muted text-sm">
          See how active this wallet is across Inkonchain's protocols used by farmers.
        </p>
        <a href="/" className="inline-block text-primary text-xs mt-3 hover:underline">
          Check out NotInked safety tools
        </a>
      </div>

      <div className="bg-warn/10 border border-warn/40 text-warn text-xs rounded-lg px-4 py-3 mb-8 leading-relaxed">
        This shows verifiable on-chain activity, NOT official $INK points. Only Kraken Pro
        trading is a confirmed points source as of this writing. Nado and Tydro activity are
        confirmed airdrop-eligibility categories, but exact weighting is unpublished. Treat
        this as informational, not a guarantee of any allocation.
      </div>

      <div className="flex gap-2 mb-8">
        <input
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="0x... your wallet address"
          className="flex-1 bg-ink2 border border-white/10 rounded-lg px-4 py-3 text-sm font-mono outline-none focus:border-primary/50"
        />
        <button
          onClick={handleCheck}
          disabled={loading || !wallet}
          className="bg-primary text-ink font-semibold px-5 py-3 rounded-lg text-sm disabled:opacity-40"
        >
          {loading ? "Checking…" : "Check"}
        </button>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/40 text-danger text-sm rounded-lg px-4 py-3 mb-6">
          {error}
        </div>
      )}

      {result && (
        <div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Stat label="Total transactions" value={result.txCount.toString()} />
            <Stat
              label="Unique contracts touched"
              value={`${result.uniqueContractsTouched}${result.isPartialContractCount ? "+" : ""}`}
            />
            <Stat
              label="Wallet age on Ink"
              value={result.walletAgeDays !== null ? `${result.walletAgeDays}d` : "—"}
            />
            <Stat
              label="Last active"
              value={result.daysSinceLastActive !== null ? `${result.daysSinceLastActive}d ago` : "—"}
            />
          </div>

          {protocolEntries.length > 0 ? (
            <div className="bg-ink2 border border-white/10 rounded-lg p-4">
              <div className="text-xs text-muted uppercase tracking-wide mb-2">
                Confirmed-eligible protocol activity
              </div>
              {protocolEntries.map(([name, count]) => (
                <div key={name} className="flex justify-between text-sm py-1">
                  <span>{name}</span>
                  <span className="font-mono text-muted">{count} interactions</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted text-center py-4">
              No Nado or Tydro interactions were found in the indexed transaction history.
            </div>
          )}

          {result.isPartialContractCount && (
            <div className="text-xs text-muted mt-3 text-center">
              Contract count is based on the most recent page of transaction history, not
              the full total.
            </div>
          )}

          {tydroError && (
            <div className="text-xs text-muted text-center mt-4">
              Tydro rewards check unavailable: {tydroError}
            </div>
          )}

          {tydroResult && <TydroSection tydro={tydroResult} />}

          <ValueEstimatorSection
            seedPoints={tydroResult?.rewards.length ? Number(tydroResult.rewards[0].amount) : undefined}
          />
        </div>
      )}
    </main>
  );
}

function TydroSection({ tydro }: { tydro: TydroRewardsResult }) {
  return (
    <div className="mt-6">
      <div className="text-xs text-muted uppercase tracking-wide mb-2">
        Tydro &amp; Ink Rewards (via Merkl)
      </div>

      {tydro.hasRewards ? (
        <div className="bg-ink2 border border-white/10 rounded-lg p-4">
          {tydro.rewards.map((r, i) => (
            <div key={i} className="flex justify-between text-sm py-1">
              <span>{r.campaignName ?? r.token.symbol}</span>
              <span className="font-mono text-muted">
                {(Number(r.amount) / 10 ** r.token.decimals).toLocaleString(undefined, {
                  maximumFractionDigits: 4,
                })}{" "}
                {r.token.symbol}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted">No Merkl-distributed rewards found for this wallet on Ink.</div>
      )}
    </div>
  );
}

function ValueEstimatorSection({ seedPoints }: { seedPoints?: number }) {
  const [yourPoints, setYourPoints] = useState(seedPoints ?? 1000);
  const [totalPointsSupply, setTotalPointsSupply] = useState(410_378); // Tydro Season 1 total, per public data
  const [airdropTokenSupply, setAirdropTokenSupply] = useState(10_000_000);
  const [assumedFdvUsd, setAssumedFdvUsd] = useState(500_000_000);
  const [totalTokenSupply, setTotalTokenSupply] = useState(1_000_000_000);

  const estimate = estimateAirdropValue({
    yourPoints,
    totalPointsSupply,
    airdropTokenSupply,
    assumedFdvUsd,
    totalTokenSupply,
  });

  return (
    <div className="mt-8">
      <div className="text-xs text-muted uppercase tracking-wide mb-2">
        Ink Rewards Value Estimator
      </div>
      <p className="text-xs text-muted mb-4 leading-relaxed">
        This is a projection tool, not a prediction. Treat this as "what if" exploration only.
      </p>

      <div className="bg-ink2 border border-white/10 rounded-lg p-4 space-y-3">
        <NumberField label="Your points" value={yourPoints} onChange={setYourPoints} />
        <NumberField
          label="Total points supply (season)"
          value={totalPointsSupply}
          onChange={setTotalPointsSupply}
        />
        <NumberField
          label="Airdrop token supply for this pool"
          value={airdropTokenSupply}
          onChange={setAirdropTokenSupply}
        />
        <NumberField
          label="Assumed FDV (USD)"
          value={assumedFdvUsd}
          onChange={setAssumedFdvUsd}
        />
        <NumberField
          label="Total $INK token supply"
          value={totalTokenSupply}
          onChange={setTotalTokenSupply}
        />

        <div className="pt-3 border-t border-white/10 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted">Your share of pool</span>
            <span className="font-mono">{(estimate.yourShareOfPool * 100).toFixed(4)}%</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted">Estimated token allocation</span>
            <span className="font-mono">
              {estimate.estimatedTokenAllocation.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted">Assumed token price</span>
            <span className="font-mono">${estimate.assumedTokenPriceUsd.toFixed(4)}</span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-white/10">
            <span className="text-xs text-muted">Estimated value</span>
            <span className="text-lg font-bold font-mono">
              ${estimate.estimatedValueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-muted mb-1">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-ink border border-white/10 rounded-md px-3 py-2 text-sm font-mono"
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink2 border border-white/10 rounded-lg p-4">
      <div className="text-xs text-muted uppercase tracking-wide mb-1">{label}</div>
      <div className="text-2xl font-bold font-mono">{value}</div>
    </div>
  );
}
