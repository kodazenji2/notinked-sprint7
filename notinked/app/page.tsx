"use client";

import { useState } from "react";
import type { ScanResult } from "@/lib/scanWallet";
import type { ContractCheckResult } from "@/lib/checkContract";

const RISK_STYLES = {
  red: { bg: "bg-danger/10", border: "border-danger/40", text: "text-danger", dot: "bg-danger" },
  yellow: { bg: "bg-warn/10", border: "border-warn/40", text: "text-warn", dot: "bg-warn" },
  green: { bg: "bg-primary/10", border: "border-primary/40", text: "text-primary", dot: "bg-primary" },
} as const;

type Tab = "wallet" | "contract" | "message";

interface MessageCheckResult {
  risk: "red" | "yellow" | "green";
  score: number;
  reasons: string[];
  summary: string;
  remaining: number;
  limit: number;
  resetsAt: string;
  mentionedAddresses?: ContractCheckResult[];
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("contract");

  return (
    <main className="max-w-xl mx-auto px-5 py-16">
      <div className="text-center mb-8">
        <div className="text-primary text-xs font-mono tracking-widest uppercase mb-3">
          Ink Chain · Wallet Safety
        </div>
        <div className="mb-2">
          <div className="card inline-flex items-center gap-3">
            <div className="mark">
              <div className="wordmark text-3xl font-bold">
                <span className="not strike">not</span>
                <span className="inked">Inked</span>
              </div>
            </div>
          </div>
        </div>
        <p className="text-muted text-sm">Check before you get inked.</p>
        <a href="/ink-activity-checker" className="inline-block text-primary text-xs mt-3 hover:underline">
          Check INK farmer activity
        </a>
      </div>

      <div className="flex gap-1 mb-8 bg-ink2 rounded-lg p-1">
        <button
          onClick={() => setTab("contract")}
          className={`flex-1 text-xs sm:text-sm py-2 rounded-md transition ${tab === "contract" ? "bg-primary/15 text-text font-semibold" : "text-muted"
            }`}
        >
          Before You Ape
        </button>
        <button
          onClick={() => setTab("wallet")}
          className={`flex-1 text-xs sm:text-sm py-2 rounded-md transition ${tab === "wallet" ? "bg-primary/15 text-text font-semibold" : "text-muted"
            }`}
        >
          Wallet Scan
        </button>
        <button
          onClick={() => setTab("message")}
          className={`flex-1 text-xs sm:text-sm py-2 rounded-md transition ${tab === "message" ? "bg-primary/15 text-text font-semibold" : "text-muted"
            }`}
        >
          Message Check
        </button>
      </div>

      {tab === "contract" && <ContractChecker />}
      {tab === "wallet" && <WalletScanner />}
      {tab === "message" && <MessageChecker />}
    </main>
  );
}

function ContractChecker() {
  const [address, setAddress] = useState("");
  const [txHash, setTxHash] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ContractCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);

  async function handleCheck() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/contract-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
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

  async function handleReport() {
    setError(null);
    setReportMessage(null);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, txHash, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Report failed");
      setReportMessage(
        data.status === "pending"
          ? `Report received — needs ${data.confirmationsRemaining} more confirmations before it's flagged publicly`
          : "Confirmed as risky"
      );
      setTxHash("");
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  return (
    <div>
      <p className="text-xs text-muted mb-4">
        Paste a contract or token address before you interact with it.
      </p>
      <div className="flex gap-2 mb-8">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x... contract address"
          className="flex-1 bg-ink2 border border-white/10 rounded-lg px-4 py-3 text-sm font-mono outline-none focus:border-primary/60"
        />
        <button
          onClick={handleCheck}
          disabled={loading || !address}
          className="bg-primary text-ink font-semibold px-5 py-3 rounded-lg text-sm hover:bg-primaryDim disabled:opacity-40"
        >
          {loading ? "Checking…" : "Check"}
        </button>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/40 text-danger text-sm rounded-lg px-4 py-3 mb-6">
          {error}
        </div>
      )}

      {reportMessage && <div className="text-safe text-sm mt-4">{reportMessage}</div>}

      {result && (
        <div>
          <div className={`rounded-lg border ${RISK_STYLES[result.risk].bg} ${RISK_STYLES[result.risk].border} px-4 py-4`}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full ${RISK_STYLES[result.risk].dot}`} />
              <span className={`text-xs font-semibold uppercase ${RISK_STYLES[result.risk].text}`}>
                {result.risk}
              </span>
              {result.contractName && (
                <span className="text-xs text-muted font-mono">· {result.contractName}</span>
              )}
            </div>
            <ul className="text-sm space-y-1 list-disc list-inside">
              {result.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted font-mono">
              <span>proxy: {result.isProxy === null ? "unknown" : result.isProxy ? "detected" : "no"}</span>
              <span>proxy admin: {result.proxyAdmin ?? "unknown"}</span>
              <span>top holder: {result.topHolderPercent === null || result.topHolderPercent === undefined ? "unknown" : `${result.topHolderPercent.toFixed(1)}%`}</span>
              <span>name spoof: {result.possibleNameSpoof === null ? "unknown" : result.possibleNameSpoof ? "possible" : "no"}</span>
            </div>
            {result.dangerousFunctions && result.dangerousFunctions.length > 0 && (
              <div className="text-xs text-warn mt-3">Potentially dangerous functions: {result.dangerousFunctions.join(", ")}</div>
            )}
          </div>

          <div className="border-t border-white/10 pt-6 mt-6">
            <div className="text-xs font-semibold uppercase tracking-wide mb-3">Report malicious activity</div>
            <input
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="Transaction hash of the malicious action"
              required
              className="w-full bg-ink2 border border-white/10 rounded-lg px-4 py-3 text-sm font-mono outline-none focus:border-safe/50 mb-3"
            />
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this address malicious?"
              required
              rows={3}
              className="w-full bg-ink2 border border-white/10 rounded-lg px-4 py-3 text-sm outline-none focus:border-safe/50 resize-none mb-3"
            />
            <button
              onClick={handleReport}
              disabled={!address || !txHash || !reason.trim()}
              className="bg-white/10 text-white font-semibold px-5 py-2.5 rounded-lg text-sm disabled:opacity-40"
            >
              Submit report
            </button>
            {reportMessage && <div className="text-safe text-sm mt-4">{reportMessage}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function WalletScanner() {
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleScan() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scan failed");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p className="text-xs text-muted mb-4">
        Full approval history, verified live — Checks all you've ever approved and
        whether it's still active right now.
      </p>
      <div className="flex gap-2 mb-8">
        <input
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          placeholder="0x... wallet address"
          className="flex-1 bg-ink2 border border-white/10 rounded-lg px-4 py-3 text-sm font-mono outline-none focus:border-primary/60"
        />
        <button
          onClick={handleScan}
          disabled={loading || !wallet}
          className="bg-primary text-ink font-semibold px-5 py-3 rounded-lg text-sm hover:bg-primaryDim disabled:opacity-40"
        >
          {loading ? "Scanning…" : "Scan"}
        </button>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/40 text-danger text-sm rounded-lg px-4 py-3 mb-6">
          {error}
        </div>
      )}

      {result && (
        <div>
          <div className="text-xs text-muted font-mono mb-4">
            {result.approvals.length} active approval
            {result.approvals.length === 1 ? "" : "s"} found · {result.historicalApprovalCount} historical event
            {result.historicalApprovalCount === 1 ? "" : "s"} checked
          </div>

          {result.approvals.length === 0 && (
            <div className="text-sm text-muted text-center py-10">
              {result.historicalApprovalCount > 0
                ? `No currently active approvals found. ${result.historicalApprovalCount} historical approval event${result.historicalApprovalCount === 1 ? " was" : "s were"} discovered, but each allowance was revoked, spent, or could not be verified.`
                : "No approval history found for this wallet."}
            </div>
          )}

          <div className="flex flex-col gap-3">
            {result.approvals.map((a, i) => {
              const s = RISK_STYLES[a.risk];
              return (
                <div key={i} className={`rounded-lg border ${s.bg} ${s.border} px-4 py-3`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                    <span className={`text-xs font-semibold uppercase ${s.text}`}>
                      {a.risk}
                    </span>
                  </div>
                  <div className="text-sm mb-1">{a.reason}</div>
                  <div className="text-xs text-muted font-mono break-all mb-1">
                    current allowance: {a.isUnlimited ? "unlimited" : a.currentAllowance}
                    <span className="text-muted/60"> (live)</span>
                  </div>
                  <div className="text-xs text-muted font-mono break-all">
                    spender: {a.spender}
                  </div>
                  <div className="text-xs text-muted font-mono break-all">
                    token: {a.tokenAddress}
                  </div>
                </div>
              );
            })}
          </div>

          {result.nftApprovals.length > 0 && (
            <div className="mt-6">
              <div className="text-xs text-muted font-mono mb-4">
                {result.nftApprovals.length} active NFT approval{result.nftApprovals.length === 1 ? "" : "s"}
              </div>
              <div className="flex flex-col gap-3">
                {result.nftApprovals.map((approval, i) => {
                  const s = RISK_STYLES[approval.risk];
                  return (
                    <div key={i} className={`rounded-lg border ${s.bg} ${s.border} px-4 py-3`}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                        <span className={`text-xs font-semibold uppercase ${s.text}`}>{approval.risk}</span>
                      </div>
                      <div className="text-sm mb-1">{approval.reason}</div>
                      <div className="text-xs text-muted font-mono break-all">operator: {approval.operator}</div>
                      <div className="text-xs text-muted font-mono break-all">collection: {approval.collectionAddress}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageChecker() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MessageCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitInfo, setLimitInfo] = useState<{ remaining: number; limit: number } | null>(
    null
  );

  async function handleCheck() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/scam-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, identifier: "anonymous", isPremium: false }),
      });
      const data = await res.json();

      if (res.status === 429) {
        setError(
          `Daily limit reached (${data.limit}/day). Resets at ${new Date(
            data.resetsAt
          ).toLocaleTimeString()}.`
        );
        return;
      }
      if (!res.ok) throw new Error(data.error || "Check failed");

      setResult(data);
      setLimitInfo({ remaining: data.remaining, limit: data.limit });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste a suspicious DM, airdrop offer, or link..."
        rows={5}
        className="w-full bg-ink2 border border-white/10 rounded-lg px-4 py-3 text-sm outline-none focus:border-primary/60 mb-3 resize-none"
      />
      <div className="flex items-center justify-between mb-8">
        <span className="text-xs text-muted font-mono">
          {limitInfo ? `${limitInfo.remaining}/${limitInfo.limit} checks left today` : "5 free checks/day"}
        </span>
        <button
          onClick={handleCheck}
          disabled={loading || !text.trim()}
          className="bg-primary text-ink font-semibold px-5 py-2.5 rounded-lg text-sm hover:bg-primaryDim disabled:opacity-40"
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
        <div className={`rounded-lg border ${RISK_STYLES[result.risk].bg} ${RISK_STYLES[result.risk].border} px-4 py-4`}>
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full ${RISK_STYLES[result.risk].dot}`} />
            <span className={`text-xs font-semibold uppercase ${RISK_STYLES[result.risk].text}`}>
              {result.risk} · score {result.score}/100
            </span>
          </div>
          <div className="text-sm mb-3">{result.summary}</div>
          {result.reasons.length > 0 && (
            <ul className="text-xs text-muted space-y-1 list-disc list-inside">
              {result.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {result.mentionedAddresses && result.mentionedAddresses.length > 0 && (
            <div className="mt-4 border-t border-white/10 pt-3">
              <div className="text-xs text-muted font-mono mb-2">Addresses checked</div>
              {result.mentionedAddresses.map((address) => (
                <div key={address.address} className="text-xs mb-2">
                  <span className={RISK_STYLES[address.risk].text}>{address.risk}</span>{" "}
                  <span className="font-mono break-all">{address.address}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
