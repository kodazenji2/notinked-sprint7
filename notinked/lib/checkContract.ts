import { createPublicClient, http, isAddress } from "viem";
import { autoFlagIfRisky, isKnownRisk } from "./riskRegistry";

/**
 * Pre-ape contract checker — checks a contract BEFORE you interact with it,
 * as opposed to scanWallet.ts which audits approvals you already gave.
 *
 * Uses Ink's own Blockscout explorer API (explorer.inkonchain.com) since
 * it's guaranteed to support Ink (it IS Ink's explorer), unlike third-party
 * security APIs (GoPlus, etc.) whose Ink coverage isn't confirmed as of
 * this writing. Free, no API key needed.
 *
 * Honest scope limit: this checks verification status, deployment age,
 * and our own risk registry. It does NOT do deep bytecode analysis
 * (hidden mint functions, honeypot sell-tax detection, blacklist logic) —
 * that needs either a specialized security API with confirmed Ink support,
 * or custom bytecode analysis. Flag this as a known gap, not a silent one.
 */

const EXPLORER_BASE = "https://explorer.inkonchain.com/api/v2";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6d4" as const;
const INK_CLIENT = createPublicClient({
  chain: {
    id: 57073,
    name: "Ink",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.nodeflare.app/ink/public"] } },
  },
  transport: http(),
});
const DANGEROUS_FUNCTIONS = ["mint", "blacklist", "pause", "setFee", "excludeFromFee", "setMaxTx", "blockAccount", "freeze"];
const KNOWN_REAL_DEPLOYMENTS = new Set(["0x4200000000000000000000000000000000000006".toLowerCase()]);

export type ContractRisk = "red" | "yellow" | "green";

export interface ContractCheckResult {
  address: string;
  isContract: boolean;
  isVerified: boolean | null; // null = couldn't determine
  contractName: string | null;
  deployedAt: string | null; // ISO date
  ageInDays: number | null;
  isKnownRisk: boolean;
  risk: ContractRisk;
  reasons: string[];
  isProxy?: boolean | null;
  proxyAdmin?: string | null;
  dangerousFunctions?: string[];
  topHolderPercent?: number | null;
  possibleNameSpoof?: boolean | null;
  deployerAddress: string | null;
  ownershipStatus: "renounced" | "owned" | "no-owner-function" | "unknown";
  currentOwner: string | null;
}

const OWNABLE_ABI = [
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Live on-chain read of the standard OpenZeppelin Ownable owner()
 * function. A convention, not a guarantee — some contracts intentionally
 * avoid implementing it, or use a different pattern (AccessControl roles,
 * multisig-only, etc.), which is why "no-owner-function" is a distinct,
 * non-alarming result rather than being lumped in with "unknown"/error.
 */
async function checkOwnership(
  address: `0x${string}`
): Promise<{ status: "renounced" | "owned" | "no-owner-function"; owner: string | null }> {
  try {
    const owner = await INK_CLIENT.readContract({
      address,
      abi: OWNABLE_ABI,
      functionName: "owner",
    });
    if (owner.toLowerCase() === ZERO_ADDRESS) {
      return { status: "renounced", owner: owner as string };
    }
    return { status: "owned", owner: owner as string };
  } catch {
    return { status: "no-owner-function", owner: null };
  }
}

const NEW_CONTRACT_THRESHOLD_DAYS = 7;
const CONTRACT_CHECK_CACHE_TTL_MS = 30_000;
const contractCheckCache = new Map<string, { expiresAt: number; result: ContractCheckResult }>();

async function checkContractUncached(addressInput: string): Promise<ContractCheckResult> {
  if (!isAddress(addressInput)) {
    throw new Error("Not a valid EVM address");
  }
  const address = addressInput;
  const reasons: string[] = [];

  // 1. Check our own open risk registry first (cheap, no network call)
  const registryHit = isKnownRisk(address);
  if (registryHit) {
    return {
      address,
      isContract: true,
      isVerified: null,
      contractName: null,
      deployedAt: null,
      ageInDays: null,
      isKnownRisk: true,
      risk: "red",
      reasons: [registryHit.reason],
      isProxy: null,
      proxyAdmin: null,
      dangerousFunctions: [],
      topHolderPercent: null,
      possibleNameSpoof: null,
      deployerAddress: null,
      ownershipStatus: "unknown",
      currentOwner: null,
    };
  }

  // 2. Check verification + basic contract info via Blockscout
  let isContract = false;
  let isVerified: boolean | null = null;
  let contractName: string | null = null;
  let contractSymbol: string | null = null;
  let contractAbi: unknown = null;
  let isProxy: boolean | null = null;
  let proxyAdmin: string | null = null;
  let dangerousFunctions: string[] = [];

  try {
    const res = await fetch(`${EXPLORER_BASE}/smart-contracts/${address}`);
    if (res.ok) {
      const data = await res.json();
      isContract = true;
      isVerified = Boolean(data.is_verified);
      contractName = data.name ?? null;
      contractSymbol = data.symbol ?? null;
      contractAbi = data.abi;
      isProxy = Boolean(data.proxy_type) || (Array.isArray(data.implementations) && data.implementations.length > 0);
      if (isVerified && Array.isArray(contractAbi)) {
        dangerousFunctions = Array.from(new Set(contractAbi
          .filter((item): item is { type: string; name?: string } => item?.type === "function" && typeof item.name === "string")
          .map((item) => item.name!)
          .filter((name) => DANGEROUS_FUNCTIONS.some((dangerous) => name.toLowerCase() === dangerous.toLowerCase()))));
      }
    } else if (res.status === 404) {
      // Could be an unverified contract or a plain wallet — check address endpoint next
      isContract = false;
    }
  } catch {
    reasons.push("Could not reach Ink explorer to check verification status.");
  }

  // 3. Get creation info (age + deployer) via the address endpoint
  let deployedAt: string | null = null;
  let ageInDays: number | null = null;
  let deployerAddress: string | null = null;

  try {
    const res = await fetch(`${EXPLORER_BASE}/addresses/${address}`);
    if (res.ok) {
      const data = await res.json();
      isContract = isContract || Boolean(data.is_contract);
      deployerAddress = data.creator_address_hash ?? null;

      const creationTransactionHash = data.creation_transaction_hash ?? data.creation_tx_hash;
      if (creationTransactionHash) {
        const txRes = await fetch(`${EXPLORER_BASE}/transactions/${creationTransactionHash}`);
        if (txRes.ok) {
          const txData = await txRes.json();
          if (txData.timestamp) {
            deployedAt = txData.timestamp;
            const deployedDate = new Date(txData.timestamp);
            ageInDays = Math.floor((Date.now() - deployedDate.getTime()) / (1000 * 60 * 60 * 24));
          }
        }
      }
    }
  } catch {
    reasons.push("Could not reach Ink explorer to check deployment age.");
  }

  if (isContract) {
    try {
      const slotValue = await INK_CLIENT.getStorageAt({ address: address as `0x${string}`, slot: EIP1967_ADMIN_SLOT });
      if (slotValue && !/^0x0{64}$/i.test(slotValue)) {
        proxyAdmin = `0x${slotValue.slice(-40)}`;
        isProxy = true;
      }
    } catch {
      reasons.push("Proxy admin could not be determined from the EIP-1967 storage slot.");
    }
  }

  let ownershipStatus: "renounced" | "owned" | "no-owner-function" | "unknown" = "unknown";
  let currentOwner: string | null = null;
  if (isContract) {
    const ownership = await checkOwnership(address as `0x${string}`);
    ownershipStatus = ownership.status;
    currentOwner = ownership.owner;
  }

  if (!isContract) {
    return {
      address,
      isContract: false,
      isVerified: null,
      contractName: null,
      deployedAt: null,
      ageInDays: null,
      isKnownRisk: false,
      risk: "green",
      reasons: ["This address is a regular wallet, not a contract, nothing to check here."],
      isProxy: null,
      proxyAdmin: null,
      dangerousFunctions: [],
      topHolderPercent: null,
      possibleNameSpoof: null,
      deployerAddress: null,
      ownershipStatus: "unknown",
      currentOwner: null,
    };
  }

  // 4. Build risk verdict
  let risk: ContractRisk = "green";

  if (isVerified === false) {
    risk = "yellow";
    reasons.push("Contract source code is not verified. Risk level: Medium.");
  } else if (isVerified === true) {
    reasons.push(contractName ? `Verified contract: ${contractName}.` : "Contract source is verified.");
  } else {
    reasons.push("Could not determine verification status.");
  }

  if (isProxy) {
    reasons.push(proxyAdmin
      ? `Proxy detected. Admin ${proxyAdmin} can swap the implementation, so ownership checks on this proxy may not reflect logic control.`
      : "Proxy detected. The admin can swap the implementation, so ownership checks on this proxy may not reflect logic control.");
  }

  if (deployerAddress) {
    reasons.push(`Deployed by ${deployerAddress}.`);
  }

  if (ownershipStatus === "renounced") {
    reasons.push("Ownership renounced — no address currently holds owner-only privileges.");
  } else if (ownershipStatus === "owned") {
    reasons.push(`Ownership NOT renounced — ${currentOwner} still holds owner-only privileges.`);
    if (isVerified === false || (ageInDays !== null && ageInDays < NEW_CONTRACT_THRESHOLD_DAYS)) {
      risk = risk === "green" ? "yellow" : risk;
      reasons.push("Combined with the above, someone can still act on this contract with elevated privileges while its behavior can't be fully verified or hasn't been tested by time.");
    }
  } else if (ownershipStatus === "no-owner-function") {
    reasons.push("No standard owner() function found — either uses a different access-control pattern, or ownership information isn't available this way.");
  }

  if (dangerousFunctions.length > 0) {
    reasons.push(`Verified ABI exposes potentially dangerous functions: ${dangerousFunctions.join(", ")}. The ABI alone does not prove these functions are owner-restricted; review their implementation before interacting.`);
    risk = risk === "green" ? "yellow" : risk;
  }

  let topHolderPercent: number | null = null;
  try {
    const tokenRes = await fetch(`${EXPLORER_BASE}/tokens/${address}`);
    if (tokenRes.ok) {
      const tokenData = await tokenRes.json();
      contractSymbol = contractSymbol ?? tokenData.symbol ?? null;
      const totalSupply = Number(tokenData.total_supply);
      const holdersRes = await fetch(`${EXPLORER_BASE}/tokens/${address}/holders?items_count=1`);
      if (holdersRes.ok && Number.isFinite(totalSupply) && totalSupply > 0) {
        const holdersData = await holdersRes.json();
        const topValue = Number(holdersData.items?.[0]?.value);
        if (Number.isFinite(topValue)) {
          topHolderPercent = (topValue / totalSupply) * 100;
          if (topHolderPercent > 50) {
            risk = "yellow";
            reasons.push(`Top holder controls ${topHolderPercent.toFixed(1)}% of supply — a concentration risk.`);
          }
        }
      }
    }
  } catch {
    // Holder concentration is supplementary and unavailable for non-token contracts.
  }

  const spoofSymbols = new Set(["USDC", "USDT", "WETH", "DAI"]);
  const possibleNameSpoof = ageInDays !== null && ageInDays < 30 &&
    spoofSymbols.has((contractSymbol ?? contractName ?? "").toUpperCase()) &&
    !KNOWN_REAL_DEPLOYMENTS.has(address.toLowerCase());
  if (possibleNameSpoof) {
    risk = "yellow";
    reasons.push(`Possible name spoof: this young contract uses the well-known symbol ${contractSymbol ?? contractName}.`);
  }

  if (ageInDays !== null && ageInDays < NEW_CONTRACT_THRESHOLD_DAYS) {
    risk = risk === "green" ? "yellow" : risk;
    reasons.push(`Deployed only ${ageInDays} day${ageInDays === 1 ? "" : "s"} ago — very new contracts carry more risk.`);
  } else if (ageInDays !== null) {
    reasons.push(`Deployed ${ageInDays} days ago.`);
  }

  if (reasons.length === 0) {
    reasons.push("No red flags found in verification status or deployment age.");
  }

  if (risk !== "green") autoFlagIfRisky(address, risk, reasons);

  return {
    address,
    isContract: true,
    isVerified,
    contractName,
    deployedAt,
    ageInDays,
    isKnownRisk: false,
    risk,
    reasons,
    isProxy,
    proxyAdmin,
    dangerousFunctions,
    topHolderPercent,
    possibleNameSpoof,
    deployerAddress,
    ownershipStatus,
    currentOwner,
  };
}

export async function checkContract(addressInput: string): Promise<ContractCheckResult> {
  const key = addressInput.toLowerCase();
  const cached = contractCheckCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await checkContractUncached(addressInput);
  contractCheckCache.set(key, { expiresAt: Date.now() + CONTRACT_CHECK_CACHE_TTL_MS, result });
  return result;
}
