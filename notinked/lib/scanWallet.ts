import { createPublicClient, http, isAddress, type Address } from "viem";
import { autoFlagIfRisky, isKnownRisk } from "./riskRegistry";
import { checkContract, type ContractCheckResult } from "./checkContract";

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
const APPROVAL_FOR_ALL_TOPIC0 = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";

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
  nftApprovals: NftApprovalResult[];
  historicalApprovalCount: number;
  historicalNftApprovalCount: number;
  discoveryMethod: string;
  error?: string;
}

export interface NftApprovalResult {
  operator: Address;
  collectionAddress: Address;
  approved: boolean;
  isKnownRisk: boolean;
  risk: ApprovalRisk;
  reason: string;
  lastApprovalTxHash: string;
  lastApprovalBlock: string;
}

function addressFromTopic(topic: string): Address {
  // Topics are 32-byte, address is the last 20 bytes (40 hex chars)
  return `0x${topic.slice(-40)}` as Address;
}

/**
 * DISCOVERY step — instead of scanning raw chain logs ourselves in chunks
 * (which is bounded and slow), this queries Ink's own Blockscout explorer,
 * which already indexes every log on the chain in its own database.
 * Revoke.cash's own chain-support requirements confirm this is a standard,
 * accepted approach: they explicitly accept "a block explorer with an
 * exposed API compatible with Etherscan's API (such as Blockscout)" as
 * sufficient for full historical log discovery — no custom indexer needed,
 * since Blockscout already IS one.
 *
 * Uses Blockscout's Etherscan-compatible legacy API (module=logs,
 * action=getLogs), searching by topic (the Approval event + owner address)
 * rather than by contract address, so it finds approvals across every
 * token the wallet has ever interacted with in one request.
 */
async function discoverApprovalLogs(wallet: Address) {
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
  const data = await res.json();

  if (data.status !== "1" || !Array.isArray(data.result)) {
    // status "0" with an empty/no-records message just means no approvals found — not an error
    if (typeof data.message === "string" && data.message.toLowerCase().includes("no records")) {
      return [];
    }
    throw new Error(data.message || "Unexpected response from explorer log search");
  }

  return data.result as Array<{
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
  }>;
}

async function discoverNftApprovalLogs(wallet: Address) {
  const ownerTopic = `0x${"0".repeat(24)}${wallet.slice(2).toLowerCase()}`;
  const url = new URL(EXPLORER_LEGACY_API);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", "0");
  url.searchParams.set("toBlock", "latest");
  url.searchParams.set("topic0", APPROVAL_FOR_ALL_TOPIC0);
  url.searchParams.set("topic1", ownerTopic);
  url.searchParams.set("topic0_1_opr", "and");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Explorer NFT log search failed (${res.status})`);
  const data = await res.json();
  if (data.status !== "1" || !Array.isArray(data.result)) {
    if (typeof data.message === "string" && data.message.toLowerCase().includes("no records")) return [];
    throw new Error(data.message || "Unexpected response from explorer NFT log search");
  }
  return data.result as Array<{ address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }>;
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

  // --- STEP 1: DISCOVERY (via Blockscout's already-indexed logs) ---
  const [logsResult, nftLogsResult] = await Promise.allSettled([
    discoverApprovalLogs(wallet),
    discoverNftApprovalLogs(wallet),
  ]);
  if (logsResult.status === "rejected") throw logsResult.reason;
  const logs = logsResult.value;
  const nftLogs = nftLogsResult.status === "fulfilled" ? nftLogsResult.value : [];

  const pairs = new Map<string, { tokenAddress: Address; spender: Address; lastTxHash: string; lastBlock: string }>();
  for (const log of logs) {
    if (!log.topics || log.topics.length < 3) continue;
    const spender = addressFromTopic(log.topics[2]);
    const tokenAddress = log.address as Address;
    const blockNumber = BigInt(log.blockNumber).toString();
    const key = `${tokenAddress}-${spender}`;
    const existing = pairs.get(key);
    if (!existing || BigInt(blockNumber) > BigInt(existing.lastBlock)) {
      pairs.set(key, {
        tokenAddress,
        spender,
        lastTxHash: log.transactionHash,
        lastBlock: blockNumber,
      });
    }
  }

  const pairList = Array.from(pairs.values());

  // --- STEP 2: VERIFICATION (live, batched via Multicall3) ---
  const multicallResults = pairList.length === 0 ? [] : await client.multicall({
    contracts: pairList.map((p) => ({
      address: p.tokenAddress,
      abi: ALLOWANCE_ABI,
      functionName: "allowance",
      args: [wallet, p.spender],
    })),
    allowFailure: true,
  });

  const rawApprovals = pairList
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
    .filter((a): a is ApprovalResult => a !== null);

  const operators = new Set([
    ...rawApprovals.map((approval) => approval.spender),
    ...nftLogs.filter((log) => log.topics?.length >= 3).map((log) => addressFromTopic(log.topics[2])),
  ]);
  const contractChecks = new Map<string, ContractCheckResult>();
  await Promise.all(Array.from(operators).map(async (operator) => {
    try {
      contractChecks.set(operator.toLowerCase(), await checkContract(operator));
    } catch {
      // A failed enrichment must not hide the approval itself.
    }
  }));

  const approvals = rawApprovals.map((approval) => {
    const contractCheck = contractChecks.get(approval.spender.toLowerCase());
    if (!contractCheck) return approval;
    const reasons = [...new Set([...contractCheck.reasons, approval.reason])];
    const risk: ApprovalRisk = contractCheck.risk === "red" || approval.risk === "red"
      ? "red"
      : contractCheck.risk === "yellow" || approval.risk === "yellow" ? "yellow" : "green";
    const enriched = { ...approval, risk, isKnownRisk: approval.isKnownRisk || contractCheck.isKnownRisk, reason: reasons.join(" ") };
    if (risk !== "green") autoFlagIfRisky(approval.spender, risk, reasons);
    return enriched;
  }).sort((a, b) => {
    const order = { red: 0, yellow: 1, green: 2 };
    return order[a.risk] - order[b.risk];
  });

  const nftApprovals = new Map<string, NftApprovalResult>();
  for (const log of nftLogs) {
    if (!log.topics || log.topics.length < 3) continue;
    const operator = addressFromTopic(log.topics[2]);
    const key = `${log.address.toLowerCase()}-${operator.toLowerCase()}`;
    const block = BigInt(log.blockNumber);
    const existing = nftApprovals.get(key);
    if (existing && BigInt(existing.lastApprovalBlock) >= block) continue;
    const approved = BigInt(log.data) !== 0n;
    const contractCheck = contractChecks.get(operator.toLowerCase());
    const registryHit = isKnownRisk(operator);
    const risk: ApprovalRisk = registryHit || contractCheck?.risk === "red"
      ? "red" : contractCheck?.risk === "yellow" ? "yellow" : "green";
    const reason = [...new Set([
      "Blanket NFT collection approval — this operator can transfer NFTs from this collection.",
      ...(contractCheck?.reasons ?? []),
    ])].join(" ");
    nftApprovals.set(key, {
      operator,
      collectionAddress: log.address as Address,
      approved,
      isKnownRisk: Boolean(registryHit || contractCheck?.isKnownRisk),
      risk,
      reason,
      lastApprovalTxHash: log.transactionHash,
      lastApprovalBlock: block.toString(),
    });
  }
  const activeNftApprovals = Array.from(nftApprovals.values()).filter((approval) => approval.approved);

  return {
    wallet,
    approvals,
    nftApprovals: activeNftApprovals,
    historicalApprovalCount: logs.length,
    historicalNftApprovalCount: nftLogs.length,
    discoveryMethod: "Ink explorer (Blockscout) indexed log search — full history",
  };
}
