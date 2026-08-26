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

// keccak256("Approval(address,address,uint256)")
const APPROVAL_TOPIC0 =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

// keccak256("ApprovalForAll(address,address,bool)")
const APPROVAL_FOR_ALL_TOPIC0 =
  "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";

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
  currentAllowance: string;
  isUnlimited: boolean;
  isKnownRisk: boolean;
  risk: ApprovalRisk;
  reason: string;
  lastApprovalTxHash: string;
  lastApprovalBlock: string;
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

export interface ScanResult {
  wallet: Address;
  approvals: ApprovalResult[];
  nftApprovals: NftApprovalResult[];
  historicalApprovalCount: number;
  historicalNftApprovalCount: number;
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

const APPROVAL_FOR_ALL_EVENT_ABI = [
  {
    type: "event",
    name: "ApprovalForAll",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "operator", type: "address", indexed: true },
      { name: "approved", type: "bool", indexed: false },
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
 * PRIMARY ERC20 discovery method — queries Ink's Blockscout explorer.
 */
async function discoverViaBlockscout(
  wallet: Address
): Promise<DiscoveredLog[]> {
  const ownerTopic = `0x${"0".repeat(24)}${wallet
    .slice(2)
    .toLowerCase()}`;

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
    throw new Error(
      "Explorer legacy API did not return JSON — likely not enabled on this instance"
    );
  }

  if (data.status !== "1" || !Array.isArray(data.result)) {
    const msg =
      typeof data.message === "string"
        ? data.message.toLowerCase()
        : "";

    if (
      msg.includes("no logs") ||
      msg.includes("no records") ||
      msg.includes("not found")
    ) {
      return [];
    }

    throw new Error(
      data.message || "Unexpected response from explorer log search"
    );
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

/**
 * NFT discovery through Blockscout.
 */
async function discoverNftViaBlockscout(
  wallet: Address
): Promise<DiscoveredLog[]> {
  const ownerTopic = `0x${"0".repeat(24)}${wallet
    .slice(2)
    .toLowerCase()}`;

  const url = new URL(EXPLORER_LEGACY_API);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", "0");
  url.searchParams.set("toBlock", "latest");
  url.searchParams.set("topic0", APPROVAL_FOR_ALL_TOPIC0);
  url.searchParams.set("topic1", ownerTopic);
  url.searchParams.set("topic0_1_opr", "and");

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(
      `Explorer NFT log search failed (${res.status})`
    );
  }

  let data: any;

  try {
    data = await res.json();
  } catch {
    throw new Error(
      "Explorer NFT legacy API did not return JSON — likely not enabled on this instance"
    );
  }

  if (data.status !== "1" || !Array.isArray(data.result)) {
    const msg =
      typeof data.message === "string"
        ? data.message.toLowerCase()
        : "";

    if (
      msg.includes("no logs") ||
      msg.includes("no records") ||
      msg.includes("not found")
    ) {
      return [];
    }

    throw new Error(
      data.message ||
        "Unexpected response from explorer NFT log search"
    );
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

// Fallback scan depth if the explorer API is unavailable.
const FALLBACK_CHUNK_SIZE = 10_000n;
const FALLBACK_MAX_CHUNKS = 50;

/**
 * FALLBACK ERC20 discovery — direct RPC log scanning.
 */
async function discoverViaRpc(
  wallet: Address
): Promise<{
  logs: DiscoveredLog[];
  reachedChainStart: boolean;
}> {
  const latestBlock = await client.getBlockNumber();

  let toBlock = latestBlock;
  let reachedChainStart = false;

  const logs: DiscoveredLog[] = [];

  for (let i = 0; i < FALLBACK_MAX_CHUNKS; i++) {
    const fromBlock =
      toBlock > FALLBACK_CHUNK_SIZE
        ? toBlock - FALLBACK_CHUNK_SIZE + 1n
        : 0n;

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

  return {
    logs,
    reachedChainStart,
  };
}

/**
 * FALLBACK NFT discovery — direct RPC log scanning.
 */
async function discoverNftViaRpc(
  wallet: Address
): Promise<{
  logs: DiscoveredLog[];
  reachedChainStart: boolean;
}> {
  const latestBlock = await client.getBlockNumber();

  let toBlock = latestBlock;
  let reachedChainStart = false;

  const logs: DiscoveredLog[] = [];

  for (let i = 0; i < FALLBACK_MAX_CHUNKS; i++) {
    const fromBlock =
      toBlock > FALLBACK_CHUNK_SIZE
        ? toBlock - FALLBACK_CHUNK_SIZE + 1n
        : 0n;

    const chunkLogs = await client.getLogs({
      event: APPROVAL_FOR_ALL_EVENT_ABI[0],
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

  return {
    logs,
    reachedChainStart,
  };
}

/**
 * ERC20 discovery:
 * Blockscout first, bounded RPC fallback.
 */
async function discoverApprovalLogs(
  wallet: Address
): Promise<{
  logs: DiscoveredLog[];
  method: string;
}> {
  try {
    const logs = await discoverViaBlockscout(wallet);

    return {
      logs,
      method:
        "Ink explorer (Blockscout) indexed log search — full history",
    };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "unknown error";

    const { logs, reachedChainStart } =
      await discoverViaRpc(wallet);

    const coverage = reachedChainStart
      ? "full history"
      : `partial history only — last ~${
          FALLBACK_MAX_CHUNKS * Number(FALLBACK_CHUNK_SIZE)
        } blocks`;

    return {
      logs,
      method: `Fallback direct RPC scan (Blockscout unavailable: ${reason}) — ${coverage}`,
    };
  }
}

/**
 * NFT discovery:
 * Blockscout first, bounded RPC fallback.
 */
async function discoverNftApprovalLogs(
  wallet: Address
): Promise<{
  logs: DiscoveredLog[];
  method: string;
}> {
  try {
    const logs = await discoverNftViaBlockscout(wallet);

    return {
      logs,
      method:
        "Ink explorer (Blockscout) indexed NFT approval log search — full history",
    };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "unknown error";

    const { logs, reachedChainStart } =
      await discoverNftViaRpc(wallet);

    const coverage = reachedChainStart
      ? "full history"
      : `partial history only — last ~${
          FALLBACK_MAX_CHUNKS * Number(FALLBACK_CHUNK_SIZE)
        } blocks`;

    return {
      logs,
      method: `Fallback direct RPC NFT scan (Blockscout unavailable: ${reason}) — ${coverage}`,
    };
  }
}

/**
 * Two-step approach:
 *
 * STEP 1 — DISCOVERY
 * Find historical ERC20 approvals and NFT ApprovalForAll events.
 *
 * STEP 2 — VERIFICATION
 * Read current ERC20 allowances live through Multicall3.
 *
 * NFT approvals are determined from the latest ApprovalForAll event
 * for each collection/operator pair.
 */
export async function scanWalletApprovals(
  walletInput: string
): Promise<ScanResult> {
  if (!isAddress(walletInput)) {
    throw new Error("Not a valid EVM address");
  }

  const wallet = walletInput as Address;

  // --- STEP 1: DISCOVERY ---
  const [erc20Discovery, nftDiscovery] =
    await Promise.all([
      discoverApprovalLogs(wallet),
      discoverNftApprovalLogs(wallet),
    ]);

  const logs = erc20Discovery.logs;
  const nftLogs = nftDiscovery.logs;

  // --- ERC20 PAIRS ---
  const pairs = new Map<
    string,
    {
      tokenAddress: Address;
      spender: Address;
      lastTxHash: string;
      lastBlock: string;
    }
  >();

  for (const log of logs) {
    const spender = addressFromTopic(log.spenderTopic);
    const tokenAddress = log.address as Address;

    const key = `${tokenAddress}-${spender}`;

    const existing = pairs.get(key);

    if (
      !existing ||
      BigInt(log.blockNumber) > BigInt(existing.lastBlock)
    ) {
      pairs.set(key, {
        tokenAddress,
        spender,
        lastTxHash: log.transactionHash,
        lastBlock: log.blockNumber,
      });
    }
  }

  const pairList = Array.from(pairs.values());

  // --- NFT OPERATORS ---
  const nftOperators = new Set<Address>();

  for (const log of nftLogs) {
    const operator = addressFromTopic(log.spenderTopic);
    nftOperators.add(operator);
  }

  // --- CONTRACT ENRICHMENT ---
  const operators = new Set<Address>([
    ...pairList.map((pair) => pair.spender),
    ...nftOperators,
  ]);

  const contractChecks = new Map<
    string,
    ContractCheckResult
  >();

  await Promise.all(
    Array.from(operators).map(async (operator) => {
      try {
        contractChecks.set(
          operator.toLowerCase(),
          await checkContract(operator)
        );
      } catch {
        // A failed enrichment must not hide the approval itself.
      }
    })
  );

  // --- STEP 2: LIVE ERC20 VERIFICATION ---
  const multicallResults =
    pairList.length === 0
      ? []
      : await client.multicall({
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

      if (currentAllowance === 0n) return null;

      const isUnlimited =
        currentAllowance >= UNLIMITED_THRESHOLD;

      const riskEntry = isKnownRisk(pair.spender);
      const isKnownRiskFlag = Boolean(riskEntry);

      let risk: ApprovalRisk = "green";
      let reason =
        "Limited approval to an unflagged address.";

      if (isKnownRiskFlag) {
        risk = "red";
        reason = riskEntry!.reason;
      } else if (isUnlimited) {
        risk = "yellow";
        reason =
          "Unlimited approval — this contract can move your full token balance at any time.";
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
    .filter(
      (a): a is ApprovalResult => a !== null
    );

  // --- ENRICH ERC20 APPROVALS ---
  const approvals = rawApprovals
    .map((approval) => {
      const contractCheck = contractChecks.get(
        approval.spender.toLowerCase()
      );

      if (!contractCheck) return approval;

      const reasons = [
        ...new Set([
          ...contractCheck.reasons,
          approval.reason,
        ]),
      ];

      const risk: ApprovalRisk =
        contractCheck.risk === "red" ||
        approval.risk === "red"
          ? "red"
          : contractCheck.risk === "yellow" ||
              approval.risk === "yellow"
            ? "yellow"
            : "green";

      const enriched = {
        ...approval,
        risk,
        isKnownRisk:
          approval.isKnownRisk ||
          contractCheck.isKnownRisk,
        reason: reasons.join(" "),
      };

      if (risk !== "green") {
        autoFlagIfRisky(
          approval.spender,
          risk,
          reasons
        );
      }

      return enriched;
    })
    .sort((a, b) => {
      const order = {
        red: 0,
        yellow: 1,
        green: 2,
      };

      return order[a.risk] - order[b.risk];
    });

  // --- NFT APPROVALS ---
  const nftApprovals = new Map<
    string,
    NftApprovalResult
  >();

  for (const log of nftLogs) {
    const operator = addressFromTopic(log.spenderTopic);

    const collectionAddress =
      log.address as Address;

    const key = `${collectionAddress.toLowerCase()}-${operator.toLowerCase()}`;

    const block = BigInt(log.blockNumber);

    const existing = nftApprovals.get(key);

    // Keep only the newest ApprovalForAll event.
    if (
      existing &&
      BigInt(existing.lastApprovalBlock) >= block
    ) {
      continue;
    }

    /**
     * ApprovalForAll(bool) is encoded in the event data.
     * 0 = revoked
     * non-zero = approved
     */
    let approved = false;

    try {
      approved = BigInt(log.data ?? "0x0") !== 0n;
    } catch {
      approved = false;
    }

    const contractCheck = contractChecks.get(
      operator.toLowerCase()
    );

    const registryHit = isKnownRisk(operator);

    const risk: ApprovalRisk =
      registryHit || contractCheck?.risk === "red"
        ? "red"
        : contractCheck?.risk === "yellow"
          ? "yellow"
          : "green";

    const reason = [
      ...new Set([
        "Blanket NFT collection approval — this operator can transfer NFTs from this collection.",
        ...(contractCheck?.reasons ?? []),
      ]),
    ].join(" ");

    nftApprovals.set(key, {
      operator,
      collectionAddress,
      approved,
      isKnownRisk: Boolean(
        registryHit || contractCheck?.isKnownRisk
      ),
      risk,
      reason,
      lastApprovalTxHash: log.transactionHash,
      lastApprovalBlock: block.toString(),
    });
  }

  // Only currently active NFT approvals are shown.
  const activeNftApprovals = Array.from(
    nftApprovals.values()
  ).filter((approval) => approval.approved);

  // Flag risky NFT operators too.
  for (const approval of activeNftApprovals) {
    if (approval.risk !== "green") {
      autoFlagIfRisky(
        approval.operator,
        approval.risk,
        [approval.reason]
      );
    }
  }

  // Keep the ERC20 discovery method as the primary method
  // shown to the UI, while also indicating NFT fallback status
  // if it differs.
  const discoveryMethod =
    erc20Discovery.method === nftDiscovery.method
      ? erc20Discovery.method
      : `${erc20Discovery.method}; NFT: ${nftDiscovery.method}`;

  return {
    wallet,
    approvals,
    nftApprovals: activeNftApprovals,
    historicalApprovalCount: logs.length,
    historicalNftApprovalCount: nftLogs.length,
    discoveryMethod,
  };
}
