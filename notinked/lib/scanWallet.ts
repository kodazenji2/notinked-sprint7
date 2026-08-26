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
const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const INK_CHAIN = {
  id: 57073,
  name: "Ink",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
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

const APPROVAL_FOR_ALL_EVENT_ABI = [
  {
    type: "event",
    name: "ApprovalForAll",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
      },
      {
        name: "operator",
        type: "address",
        indexed: true,
      },
      {
        name: "approved",
        type: "bool",
        indexed: false,
      },
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
  data?: string;
}

/**
 * PRIMARY ERC20 discovery method — queries Ink's Blockscout explorer.
 *
 * Uses Blockscout's Etherscan-compatible legacy logs endpoint.
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
      data: log.data,
    });
  }

  return logs;
}

/**
 * PRIMARY NFT discovery method — queries Ink's Blockscout explorer
 * for ERC721/ERC1155 ApprovalForAll events.
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
      data: log.data,
    });
  }

  return logs;
}

// Fallback scan depth if the explorer API is unavailable.
const FALLBACK_CHUNK_SIZE = 10_000n;
const FALLBACK_MAX_CHUNKS = 50;

/**
 * FALLBACK ERC20 discovery — direct RPC log scanning.
 *
 * This is intentionally bounded.
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
      logs.push({
        address: log.address,
        spenderTopic: log.topics[2] as string,
        blockNumber: log.blockNumber!.toString(),
        transactionHash: log.transactionHash as string,
        data: log.data as string,
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

  for (let i = 0; i < FALLBACK_MAX
