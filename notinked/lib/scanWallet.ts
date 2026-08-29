import { createPublicClient, http, isAddress, type Address } from "viem";
import { autoFlagIfRisky, isKnownRisk } from "./riskRegistry";
import { checkContract, type ContractCheckResult } from "./checkContract";


const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const INK_CHAIN = {
  id: 57073,
  name: "Ink",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.nodeflare.app/ink/public"],
    },
  },
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
      {
        name: "owner",
        type: "address",
      },
      {
        name: "spender",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
] as const;

const MAX_UINT256 = 2n ** 256n - 1n;
const UNLIMITED_THRESHOLD = MAX_UINT256 / 2n;

const EXPLORER_LEGACY_API = "https://explorer.inkonchain.com/api";

// Risk data lives in lib/riskRegistry.ts
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
      {
        name: "owner",
        type: "address",
        indexed: true,
      },
      {
        name: "spender",
        type: "address",
        indexed: true,
      },
      {
        name: "value",
        type: "uint256",
        indexed: false,
      },
    ],
  },
] as const;

function addressFromTopic(topic: string): Address {
  return `0x${topic.slice(-40)}` as Address;
}

interface DiscoveredLog {
  address: string;
  spenderTopic: string;
  blockNumber: string;
  transactionHash: string;
}

/**
 * Discover ERC20 Approval logs through Ink's Blockscout explorer.
 */
async function discoverViaBlockscout(
  wallet: Address
): Promise<DiscoveredLog[]> {
  const ownerTopic =
    `0x${"0".repeat(24)}${wallet.slice(2).toLowerCase()}`;

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
    if (!log.topics || log.topics.length < 3) {
      continue;
    }

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
 * Discover NFT ApprovalForAll logs through Ink's Blockscout explorer.
 *
 * This keeps the previous NFT scan logic intact.
 */
async function discoverNftApprovalLogs(wallet: Address) {
  const ownerTopic =
    `0x${"0".repeat(24)}${wallet.slice(2).toLowerCase()}`;

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
      "Explorer NFT legacy API did not return JSON"
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
      data.message || "Unexpected response from explorer NFT log search"
    );
  }

  return data.result as Array<{
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
  }>;
}

/**
 * Fallback scan depth if Blockscout is unavailable.
 *
 * 10,000 blocks per request × 50 chunks = 500,000 blocks.
 */
const FALLBACK_CHUNK_SIZE = 10_000n;
const FALLBACK_MAX_CHUNKS = 50;

/**
 * Direct RPC fallback for ERC20 Approval events.
 *
 * This is bounded and therefore may not cover the wallet's entire history.
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
      args: {
        owner: wallet,
      },
      fromBlock,
      toBlock,
    });

    for (const log of chunkLogs) {
      if (!log.topics || log.topics.length < 3) {
        continue;
      }

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
 * Primary discovery method:
 *
 * 1. Blockscout
 * 2. Direct RPC fallback if Blockscout fails
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

    const {
      logs,
      reachedChainStart,
    } = await discoverViaRpc(wallet);

    const coverage = reachedChainStart
      ? "full history"
      : `partial history only — last ~${FALLBACK_MAX_CHUNKS * Number(FALLBACK_CHUNK_SIZE)
      } blocks`;

    return {
      logs,
      method:
        `Fallback direct RPC scan (Blockscout unavailable: ${reason}) — ${coverage}`,
    };
  }
}

/**
 * Scan wallet approvals.
 *
 * STEP 1:
 * Discover historical ERC20 approval events.
 *
 * STEP 2:
 * Discover historical NFT ApprovalForAll events.
 *
 * STEP 3:
 * Reduce ERC20 events to unique token/spender pairs.
 *
 * STEP 4:
 * Check current live allowance using Multicall3.
 *
 * STEP 5:
 * Enrich risky spenders with contract checks.
 *
 * STEP 6:
 * Keep active NFT approvals.
 */
export async function scanWalletApprovals(
  walletInput: string
): Promise<ScanResult> {
  if (!isAddress(walletInput)) {
    throw new Error("Not a valid EVM address");
  }

  const wallet = walletInput as Address;

  // ------------------------------------------------------------
  // STEP 1 + STEP 2: DISCOVERY
  // ------------------------------------------------------------

  const [approvalDiscovery, nftLogsResult] =
    await Promise.allSettled([
      discoverApprovalLogs(wallet),
      discoverNftApprovalLogs(wallet),
    ]);

  if (approvalDiscovery.status === "rejected") {
    throw approvalDiscovery.reason;
  }

  const {
    logs,
    method,
  } = approvalDiscovery.value;

  const nftLogs =
    nftLogsResult.status === "fulfilled"
      ? nftLogsResult.value
      : [];

  // ------------------------------------------------------------
  // STEP 3: REDUCE ERC20 LOGS TO UNIQUE TOKEN/SPENDER PAIRS
  // ------------------------------------------------------------

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
    if (!log.spenderTopic) {
      continue;
    }

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

  // ------------------------------------------------------------
  // If there are no ERC20 approvals, still process NFT approvals.
  // ------------------------------------------------------------

  let rawApprovals: ApprovalResult[] = [];

  // ------------------------------------------------------------
  // STEP 4: LIVE ERC20 ALLOWANCE VERIFICATION
  // ------------------------------------------------------------

  if (pairList.length > 0) {
    const multicallResults = await client.multicall({
      contracts: pairList.map((p) => ({
        address: p.tokenAddress,
        abi: ALLOWANCE_ABI,
        functionName: "allowance",
        args: [wallet, p.spender],
      })),
      allowFailure: true,
    });

    rawApprovals = (
      await Promise.all(
        pairList.map(async (pair, i) => {
          const result = multicallResults[i];

          if (result.status !== "success") {
            return null;
          }

          const currentAllowance = result.result as bigint;

          // Fully revoked or fully spent.
          if (currentAllowance === 0n) {
            return null;
          }

          const isUnlimited =
            currentAllowance >= UNLIMITED_THRESHOLD;

          const riskEntry = await isKnownRisk(pair.spender);
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
      )
    ).filter(
      (a): a is ApprovalResult => a !== null
    );
  }

  // ------------------------------------------------------------
  // STEP 5: CONTRACT ENRICHMENT
  // ------------------------------------------------------------

  const operators = new Set([
    ...rawApprovals.map(
      (approval) => approval.spender
    ),

    ...nftLogs
      .filter(
        (log) =>
          log.topics &&
          log.topics.length >= 3
      )
      .map((log) =>
        addressFromTopic(log.topics[2])
      ),
  ]);

  const contractChecks = new Map<
    string,
    ContractCheckResult
  >();

  await Promise.all(
    Array.from(operators).map(
      async (operator) => {
        try {
          const result =
            await checkContract(operator);

          contractChecks.set(
            operator.toLowerCase(),
            result
          );
        } catch {
          // Failed enrichment must not hide the approval.
        }
      }
    )
  );

  // ------------------------------------------------------------
  // Enrich ERC20 approvals with contract risk.
  // ------------------------------------------------------------

  const approvals = (
    await Promise.all(
      rawApprovals.map(async (approval) => {
        const contractCheck =
          contractChecks.get(
            approval.spender.toLowerCase()
          );

        if (!contractCheck) {
          return approval;
        }

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
          await autoFlagIfRisky(
            approval.spender,
            risk,
            reasons
          );
        }

        return enriched;
      })
    )
  ).sort((a, b) => {
    const order = {
      red: 0,
      yellow: 1,
      green: 2,
    };

    return order[a.risk] - order[b.risk];
  });

  // ------------------------------------------------------------
  // STEP 6: NFT APPROVAL SCAN
  //
  // Kept from your previous implementation.
  // ------------------------------------------------------------

  const nftApprovals = new Map<
    string,
    NftApprovalResult
  >();

  for (const log of nftLogs) {
    if (
      !log.topics ||
      log.topics.length < 3
    ) {
      continue;
    }

    const operator = addressFromTopic(
      log.topics[2]
    );

    const key =
      `${log.address.toLowerCase()}-${operator.toLowerCase()}`;

    const block = BigInt(log.blockNumber);

    const existing =
      nftApprovals.get(key);

    if (
      existing &&
      BigInt(existing.lastApprovalBlock) >= block
    ) {
      continue;
    }

    // ApprovalForAll(bool approved) is encoded
    // in the event data.
    const approved =
      BigInt(log.data) !== 0n;

    const contractCheck =
      contractChecks.get(
        operator.toLowerCase()
      );

    const registryHit =
      await isKnownRisk(operator);

    const risk: ApprovalRisk =
      registryHit ||
        contractCheck?.risk === "red"
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
      collectionAddress:
        log.address as Address,
      approved,
      isKnownRisk: Boolean(
        registryHit ||
        contractCheck?.isKnownRisk
      ),
      risk,
      reason,
      lastApprovalTxHash:
        log.transactionHash,
      lastApprovalBlock:
        block.toString(),
    });
  }

  const activeNftApprovals =
    Array.from(
      nftApprovals.values()
    ).filter(
      (approval) => approval.approved
    );

  // ------------------------------------------------------------
  // FINAL RESULT
  // ------------------------------------------------------------

  return {
    wallet,
    approvals,
    nftApprovals: activeNftApprovals,
    historicalApprovalCount:
      logs.length,
    historicalNftApprovalCount:
      nftLogs.length,
    discoveryMethod: method,
  };
}
