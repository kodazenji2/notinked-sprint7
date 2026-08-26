import { createPublicClient, http, isAddress, type Address } from "viem";
import { isKnownRisk } from "./riskRegistry";

/**
 * Ink mainnet config.
 *
 * Multicall3 (0xcA11bde...) is confirmed deployed on Ink at the standard
 * address — added explicitly since viem's default Ink config doesn't
 * include it yet (see wevm/viem discussion #3413).
 */
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const INK_CHAIN = {
  id: 57073,
  name: "Ink",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.nodeflare.app/ink/public"] } },
  contracts: {
    multicall3: {
      address: MULTICALL3_ADDRESS,
    },
  },
} as const;

const client = createPublicClient({
  chain: INK_CHAIN,
  transport: http(),
});

// keccak256("Approval(address,address,uint256)") — the standard ERC20
// Approval event topic, same hash on every EVM chain.
const APPROVAL_TOPIC0 = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

const ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const MAX_UINT256 = 2n ** 256n - 1n;
const UNLIMITED_THRESHOLD = MAX_UINT256 / 2n;

const EXPLORER_LEGACY_API = "https://explorer.inkonchain.com/api";

// Risk data lives in lib/riskRegistry.ts — the same source served publicly
// at /api/public/risk-list.

export type ApprovalRisk = "red" | "yellow" | "green";

export interface ApprovalResult {
  spender: Address;
  tokenAddress: Address;
  currentAllowance: string; // live value, not the historical Approval event value
  isUnlimited: boolean;
  isKnownRisk: boolean;
  risk: ApprovalRisk;
  reason: string;
  lastApprovalTxHash: string;
  lastApprovalBlock: string;
}

export interface ScanResult {
  wallet: Address;
  approvals: ApprovalResult[];
  discoveryMethod: string;
  error?: string;
}

const APPROVAL_EVENT_ABI = [
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "spender", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

function addressFromTopic(topic: string): Address {
  // Topics are 32-byte, address is the last 20 bytes (40 hex chars)
  return `0x${topic.slice(-40)}` as Address;
}

interface DiscoveredLog {
  address: string;
  spenderTopic: string;
  blockNumber: string;
  transactionHash: string;
}

/**
 * PRIMARY discovery method — queries Ink's own Blockscout explorer, which
 * already indexes every log on the chain. Revoke.cash's own chain-support
 * requirements confirm this is a standard, accepted approach: they
 * explicitly accept "a block explorer with an exposed API compatible with
 * Etherscan's API (such as Blockscout)" as sufficient for full historical
 * log discovery.
 *
 * ⚠️ UNVERIFIED ASSUMPTION, flagged honestly: this was built against
 * Blockscout's documented legacy API shape, but has not been confirmed
 * against Ink's actual live deployment from this environment (no network
 * access to explorer.inkonchain.com from here). Some newer Blockscout
 * instances only expose the REST v2 API and disable this legacy endpoint
 * entirely — if that's true for Ink, this will fail and the code below
 * falls back to a direct RPC scan rather than silently returning nothing.
 */
async function discoverViaBlockscout(wallet: Address): Promise<DiscoveredLog[]> {
  const ownerTopic = `0x${"0".repeat(24)}${wallet.slice(2).toLowerCase()}`;

  const url = new URL(EXPLORER_LEGACY_API);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", "0");
  url.searchParams.set("toBlock", "latest");
  url.searchParams.set("topic0", APPROVAL_TOPIC0);
  url.searchParams.set("topic1", ownerTopic);
  url.searchParams.set("topic0_1_opr", "and");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Explorer log search failed (${res.status})`);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    // The endpoint returned something that isn't JSON at all — most
    // likely this legacy API path isn't enabled on this Blockscout
    // instance. Treat as unavailable so the fallback kicks in, rather
    // than crashing the whole scan.
    throw new Error("Explorer legacy API did not return JSON — likely not enabled on this instance");
  }

  if (data.status !== "1" || !Array.isArray(data.result)) {
    // Confirmed via live testing against Ink's real explorer: the actual
    // wording for a legitimate empty result is "No logs found" (status
    // "0") — NOT "no records", which was the original guess and didn't
    // match, causing a valid empty result to be thrown as an error.
    const msg = typeof data.message === "string" ? data.message.toLowerCase() : "";
    if (msg.includes("no logs") || msg.includes("no records") || msg.includes("not found")) {
      return [];
    }
    throw new Error(data.message || "Unexpected response from explorer log search");
  }

  const logs: DiscoveredLog[] = [];
  for (const log of data.result) {
    if (!log.topics || log.topics.length < 3) continue;
    logs.push({
      address: log.address,
      spenderTopic: log.topics[2],
      blockNumber: BigInt(log.blockNumber).toString(),
      transactionHash: log.transactionHash,
    });
  }
  return logs;
}

// Fallback scan depth if the explorer API is unavailable — smaller and
// bounded, so it degrades gracefully instead of timing out. This does
// NOT provide full history; it's a safety net, not a replacement.
const FALLBACK_CHUNK_SIZE = 10_000n;
const FALLBACK_MAX_CHUNKS = 50; // 500,000 blocks ≈ ~6 days at Ink's ~1s block time

/**
 * FALLBACK discovery method — direct RPC log scanning, bounded and
 * chunked. Only runs if the Blockscout path above fails. Real, working,
 * but explicitly NOT full history — see FALLBACK_MAX_CHUNKS above.
 */
async function discoverViaRpc(wallet: Address): Promise<{ logs: DiscoveredLog[]; reachedChainStart: boolean }> {
  const latestBlock = await client.getBlockNumber();
  let toBlock = latestBlock;
  let reachedChainStart = false;
  const logs: DiscoveredLog[] = [];

  for (let i = 0; i < FALLBACK_MAX_CHUNKS; i++) {
    const fromBlock = toBlock > FALLBACK_CHUNK_SIZE ? toBlock - FALLBACK_CHUNK_SIZE + 1n : 0n;

    const chunkLogs = await client.getLogs({
      event: APPROVAL_EVENT_ABI[0],
      args: { owner: wallet },
      fromBlock,
      toBlock,
    });

    for (const log of chunkLogs) {
      logs.push({
        address: log.address,
        spenderTopic: log.topics[2] as string,
        blockNumber: log.blockNumber!.toString(),
        transactionHash: log.transactionHash as string,
      });
    }

    if (fromBlock === 0n) {
      reachedChainStart = true;
      break;
    }
    toBlock = fromBlock - 1n;
  }

  return { logs, reachedChainStart };
}

/**
 * Tries Blockscout first (potentially full history, one request). Falls
 * back to a bounded direct RPC scan if Blockscout's legacy API fails or
 * behaves unexpectedly — so an infrastructure gap shows up as a labeled
 * partial scan, not indistinguishable from "this wallet has zero
 * approvals."
 */
async function discoverApprovalLogs(
  wallet: Address
): Promise<{ logs: DiscoveredLog[]; method: string }> {
  try {
    const logs = await discoverViaBlockscout(wallet);
    return { logs, method: "Ink explorer (Blockscout) indexed log search — full history" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    const { logs, reachedChainStart } = await discoverViaRpc(wallet);
    const coverage = reachedChainStart
      ? "full history"
      : `partial history only — last ~${FALLBACK_MAX_CHUNKS * Number(FALLBACK_CHUNK_SIZE)} blocks`;
    return {
      logs,
      method: `Fallback direct RPC scan (Blockscout unavailable: ${reason}) — ${coverage}`,
    };
  }
}

/**
 * Two-step approach, matching how Revoke.cash (the established
 * open-source leader in this space) actually works:
 *
 * STEP 1 — DISCOVERY: find every (token, spender) pair this wallet has
 * ever approved, via Ink's Blockscout explorer (already-indexed, full
 * history, no chunking needed).
 *
 * STEP 2 — VERIFICATION: batch a LIVE allowance() read for every
 * discovered pair via Multicall3, in one RPC call. This is necessary
 * because an Approval event only shows the value that was SET, not what
 * remains after any partial transferFrom() spends since — trusting the
 * event value alone can show a stale or wrong number.
 */
export async function scanWalletApprovals(walletInput: string): Promise<ScanResult> {
  if (!isAddress(walletInput)) {
    throw new Error("Not a valid EVM address");
  }
  const wallet = walletInput as Address;

  // --- STEP 1: DISCOVERY (Blockscout, falls back to direct RPC) ---
  const { logs, method } = await discoverApprovalLogs(wallet);

  const pairs = new Map<string, { tokenAddress: Address; spender: Address; lastTxHash: string; lastBlock: string }>();
  for (const log of logs) {
    const spender = addressFromTopic(log.spenderTopic);
    const tokenAddress = log.address as Address;
    const key = `${tokenAddress}-${spender}`;
    const existing = pairs.get(key);
    if (!existing || BigInt(log.blockNumber) > BigInt(existing.lastBlock)) {
      pairs.set(key, {
        tokenAddress,
        spender,
        lastTxHash: log.transactionHash,
        lastBlock: log.blockNumber,
      });
    }
  }

  const pairList = Array.from(pairs.values());

  if (pairList.length === 0) {
    return {
      wallet,
      approvals: [],
      discoveryMethod: method,
    };
  }

  // --- STEP 2: VERIFICATION (live, batched via Multicall3) ---
  const multicallResults = await client.multicall({
    contracts: pairList.map((p) => ({
      address: p.tokenAddress,
      abi: ALLOWANCE_ABI,
      functionName: "allowance",
      args: [wallet, p.spender],
    })),
    allowFailure: true,
  });

  const approvals: ApprovalResult[] = pairList
    .map((pair, i) => {
      const result = multicallResults[i];
      if (result.status !== "success") return null;

      const currentAllowance = result.result as bigint;
      if (currentAllowance === 0n) return null; // fully spent or revoked since

      const isUnlimited = currentAllowance >= UNLIMITED_THRESHOLD;
      const riskEntry = isKnownRisk(pair.spender);
      const isKnownRiskFlag = Boolean(riskEntry);

      let risk: ApprovalRisk = "green";
      let reason = "Limited approval to an unflagged address.";

      if (isKnownRiskFlag) {
        risk = "red";
        reason = riskEntry!.reason;
      } else if (isUnlimited) {
        risk = "yellow";
        reason = "Unlimited approval — this contract can move your full token balance at any time.";
      }

      return {
        spender: pair.spender,
        tokenAddress: pair.tokenAddress,
        currentAllowance: currentAllowance.toString(),
        isUnlimited,
        isKnownRisk: isKnownRiskFlag,
        risk,
        reason,
        lastApprovalTxHash: pair.lastTxHash,
        lastApprovalBlock: pair.lastBlock,
      };
    })
    .filter((a): a is ApprovalResult => a !== null)
    .sort((a, b) => {
      const order = { red: 0, yellow: 1, green: 2 };
      return order[a.risk] - order[b.risk];
    });

  return {
    wallet,
    approvals,
    discoveryMethod: method,
  };
}
