"use client";

import { useState } from "react";
import type { ActivityCheckResult } from "../../lib/checkActivity";

export default function ActivityCheckerPage() {
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ActivityCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCheck() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/activity-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Check failed");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const protocolEntries = result ? Object.entries(result.protocolInteractions) : [];

  return (
    <main className="max-w-xl mx-auto px-5 py-16">
      <div className="text-center mb-8">
        <div className="text-primary text-xs font-mono tracking-widest uppercase mb-3">
          Ink Chain · Unofficial
        </div>
        <h1 className="text-3xl font-bold mb-2">INK Farmer Activity</h1>
        <p className="text-muted text-sm">
          See how active this wallet is across Ink protocols used by farmers.
        </p>
      </div>

      <div className="bg-warn/10 border border-warn/40 text-warn text-xs rounded-lg px-4 py-3 mb-8 leading-relaxed">
        This shows verifiable on-chain activity, NOT official INK points. Only Kraken Pro
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
        </div>
      )}
    </main>
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
