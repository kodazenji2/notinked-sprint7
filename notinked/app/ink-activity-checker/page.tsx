"use client";

import { useState } from "react";
import type { ActivityCheckResult } from "../../lib/checkActivity";
import type { NadoPointsResult } from "../../lib/checkNadoActivity";

export default function ActivityCheckerPage() {
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ActivityCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nadoResult, setNadoResult] = useState<NadoPointsResult | null>(null);
  const [nadoError, setNadoError] = useState<string | null>(null);

  async function handleCheck() {
    setLoading(true);
    setError(null);
    setResult(null);
    setNadoResult(null);
    setNadoError(null);

    const activityPromise = fetch("/api/activity-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    });
    const nadoPromise = fetch("/api/nado-check", {
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

    // Runs independently — a wallet with no Nado activity isn't an
    // error, and a Nado outage shouldn't block the main activity result.
    try {
      const nadoRes = await nadoPromise;
      const nadoData = await nadoRes.json();
      if (nadoRes.ok) {
        setNadoResult(nadoData);
      } else {
        setNadoError(nadoData.error || "Could not reach Nado's API");
      }
    } catch (e) {
      setNadoError(e instanceof Error ? e.message : "Could not reach Nado's API");
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

          {nadoError && (
            <div className="text-xs text-muted text-center mt-4">
              Nado points check unavailable: {nadoError}
            </div>
          )}

          {nadoResult && (
            <NadoSection
              nado={nadoResult}
              onChainNadoInteractions={result?.protocolInteractions?.["Nado"] ?? 0}
            />
          )}
        </div>
      )}
    </main>
  );
}

function NadoSection({
  nado,
  onChainNadoInteractions,
}: {
  nado: NadoPointsResult;
  onChainNadoInteractions: number;
}) {
  const [simulatedVolume, setSimulatedVolume] = useState(500);
  const [protocolVolume, setProtocolVolume] = useState(5_000);

  // Rough client-side mirror of estimateNadoPointsShare from
  // lib/checkNadoActivity.ts — kept in the UI so the slider updates
  // instantly without a round-trip per drag.
  const POOL_FLOOR = 300_000;
  const POOL_CAP = 950_000;
  const scaleFactor = Math.min(1, Math.sqrt(protocolVolume / 50_000_000));
  const estimatedPool = POOL_FLOOR + (POOL_CAP - POOL_FLOOR) * scaleFactor;
  const weeklyProtocolVolume = protocolVolume * 7;
  const roughShare = weeklyProtocolVolume > 0
    ? (simulatedVolume / (weeklyProtocolVolume + simulatedVolume)) * estimatedPool
    : 0;

  // Two independent sources, reconciled explicitly instead of shown
  // side-by-side unexplained:
  //  - onChainNadoInteractions: confirmed real transactions with known
  //    Nado contracts, from Ink's own explorer (checkActivity.ts)
  //  - nado.hasNadoActivity: whether Nado's own Points API returned
  //    data for this wallet (checkNadoActivity.ts)
  // These can legitimately disagree — the API is unverified and may be
  // using a wrong endpoint (see code comments in checkNadoActivity.ts),
  // or points may not be calculated yet for very recent activity. A
  // flat "no activity found" when we ALREADY know real interactions
  // happened would be actively misleading, not just imprecise.
  const hasOnChainActivity = onChainNadoInteractions > 0;

  return (
    <div className="mt-6">
      <div className="text-xs text-muted uppercase tracking-wide mb-2">Nado</div>

      {nado.hasNadoActivity ? (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <Stat label="Current epoch points" value={nado.currentEpochPoints?.toString() ?? "—"} />
          <Stat label="All-time points" value={nado.allTimePoints?.toString() ?? "—"} />
          <Stat label="Rank" value={nado.rank ? `#${nado.rank}` : "—"} />
          <Stat label="Tier" value={nado.tier ?? "—"} />
        </div>
      ) : hasOnChainActivity ? (
        <div className="text-sm text-warn mb-4 leading-relaxed">
          Confirmed {onChainNadoInteractions} on-chain interaction{onChainNadoInteractions === 1 ? "" : "s"} with
          Nado contracts (via Ink's explorer) — but Nado's own Points API didn't return matching
          data for this wallet. This isn't "no activity": it likely means points haven't been
          calculated for this activity yet, or there's a mismatch worth checking directly at{" "}
          <span className="font-mono">app.nado.xyz/points</span>.
        </div>
      ) : (
        <div className="text-sm text-muted mb-4">
          No on-chain Nado interactions found, and no points data returned — this wallet
          doesn't appear to have Nado activity.
        </div>
      )}

      <div className="bg-ink2 border border-white/10 rounded-lg p-4">
        <div className="text-xs text-muted uppercase tracking-wide mb-1">Rough Points Estimator</div>
        <p className="text-xs text-muted mb-4 leading-relaxed">
          Nado's exact scoring formula (fee tier, anti-wash-trading adjustments, real relative
          share) is intentionally undisclosed. This slider only models the ONE publicly
          documented mechanic — the weekly pool scaling from 300K toward 950K points as
          protocol volume rises — using simplified math. Treat this as directional intuition
          only, not a prediction.
        </p>

        <label className="block text-xs text-muted mb-1">
          Your simulated weekly volume: ${simulatedVolume.toLocaleString()}
        </label>
        <input
          type="range"
          min={0}
          max={2_000_000}
          step={10_000}
          value={simulatedVolume}
          onChange={(e) => setSimulatedVolume(Number(e.target.value))}
          className="w-full mb-4 accent-primary"
        />

        <label className="block text-xs text-muted mb-1">
          Estimated protocol-wide avg daily volume: ${protocolVolume.toLocaleString()}
        </label>
        <input
          type="range"
          min={1_000_000}
          max={200_000_000}
          step={1_000_000}
          value={protocolVolume}
          onChange={(e) => setProtocolVolume(Number(e.target.value))}
          className="w-full mb-4 accent-primary"
        />

        <div className="flex justify-between items-center pt-3 border-t border-white/10">
          <span className="text-xs text-muted">Rough estimated weekly share</span>
          <span className="text-lg font-bold font-mono">
            ~{roughShare.toLocaleString(undefined, { maximumFractionDigits: 0 })} pts
          </span>
        </div>
      </div>
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
