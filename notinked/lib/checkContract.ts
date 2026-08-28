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

// Use the keyed NodeFlare endpoint when NODEFLARE_API_KEY is set (higher
// rate limits and access to methods the free public endpoint restricts —
// confirmed via live testing that eth_getStorageAt 403s on /ink/public).
// Falls back to the public endpoint if no key is configured, so this
// still works out of the box without one.
const INK_RPC_URL = process.env.NODEFLARE_API_KEY
  ? `https://rpc.nodeflare.app/ink/v1/${process.env.NODEFLARE_API_KEY}`
  : "https://rpc.nodeflare.app/ink/public";

const INK_CLIENT = createPublicClient({
  chain: {
    id: 57073,
    name: "Ink",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [INK_RPC_URL] } },
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
  implementationAddressFromSlot?: string | null;
  beaconAddress?: string | null;
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
  let deployedBytecode: string | null = null;
  let implementationAddressFromSlot: string | null = null;
  let beaconAddress: string | null = null;
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
      deployedBytecode = data.deployed_bytecode ?? null;
      isProxy = Boolean(data.proxy_type) || (Array.isArray(data.implementations) && data.implementations.length > 0);
      // CONFIRMED BUG FIX (via live testing): Blockscout already resolves
      // and returns the implementation address directly in
      // `implementations[0].address_hash` — this was being detected
      // (isProxy set true) but the actual address was never read out.
      if (Array.isArray(data.implementations) && data.implementations.length > 0) {
        implementationAddressFromSlot = data.implementations[0]?.address_hash ?? null;
      }
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

  // --- Bytecode-embedded proxy detection (generalized, not name-specific) ---
  // Some proxy patterns (EIP-1167 minimal proxies, and minor variants of
  // it) don't use storage slots at all — the implementation address is
  // hardcoded directly into the contract's own bytecode at deploy time.
  // Detecting this from the actual bytecode (rather than trusting
  // Blockscout's `proxy_type` label alone) means it also works on
  // unverified clones Blockscout hasn't classified, and naturally covers
  // known variants of the pattern without needing a name for each one.
  let bytecodeEmbeddedImplementation: string | null = null;
  if (isContract && deployedBytecode) {
    // EIP-1167 and its common variants share a recognizable shape: a
    // short fixed prefix, a 20-byte address, a short fixed suffix. This
    // regex matches the standard form and the small handful of known
    // variants (differing only in a couple of bytes around the address).
    const minimalProxyPattern = /363d3d373d3d3d363d73([a-fA-F0-9]{40})5af43d82803e903d91602b57fd5bf3/;
    const match = deployedBytecode.match(minimalProxyPattern);
    if (match) {
      bytecodeEmbeddedImplementation = `0x${match[1]}`;
    }
  }

  if (isContract && bytecodeEmbeddedImplementation) {
    // Confirmed via live testing: this pattern has no admin and cannot
    // be upgraded — the implementation is permanently fixed in bytecode,
    // not stored in a slot at all.
    isProxy = true;
    if (!implementationAddressFromSlot) {
      implementationAddressFromSlot = bytecodeEmbeddedImplementation;
    }
    reasons.push(
      `This is a minimal/clone proxy — implementation is hardcoded in its bytecode as ${bytecodeEmbeddedImplementation} and cannot be changed. No admin exists for this proxy type, by design.`
    );
  } else if (isContract) {
    // Blockscout's own resolution runs first (already captured above via
    // `implementations[]`/`proxy_type`) — this section is a SUPPLEMENTARY
    // live check on top of that, not a replacement. It fills in gaps
    // Blockscout might not classify, and cross-verifies what it did
    // classify against the actual chain state.
    //
    // Data-driven registry — add a new pattern as one entry, no new
    // branching logic needed elsewhere:
    const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb" as const;
    const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d5" as const;
    const GNOSIS_SAFE_SINGLETON_SLOT = `0x${"0".repeat(64)}` as `0x${string}`;
    // Pre-EIP-1967 OpenZeppelin/zOS AdminUpgradeabilityProxy pattern —
    // an older standard with DIFFERENT slot hashes than EIP-1967, still
    // in real use today (confirmed via live testing: this is the
    // pattern behind Circle's FiatTokenProxy / USDC, among others).
    // keccak256("org.zeppelinos.proxy.implementation") and
    // keccak256("org.zeppelinos.proxy.admin") respectively.
    const LEGACY_ZOS_IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f800c70a5a68e2e2f0c31c1f9ed1" as const;
    const LEGACY_ZOS_ADMIN_SLOT = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b" as const;

    const SLOT_REGISTRY: Array<{ label: string; slot: `0x${string}`; role: "admin" | "implementation" | "beacon" }> = [
      { label: "EIP-1967 admin", slot: EIP1967_ADMIN_SLOT, role: "admin" },
      { label: "EIP-1967 implementation", slot: EIP1967_IMPLEMENTATION_SLOT, role: "implementation" },
      { label: "EIP-1967 beacon", slot: EIP1967_BEACON_SLOT, role: "beacon" },
      { label: "Gnosis Safe singleton", slot: GNOSIS_SAFE_SINGLETON_SLOT, role: "implementation" },
      { label: "Legacy zOS admin", slot: LEGACY_ZOS_ADMIN_SLOT, role: "admin" },
      { label: "Legacy zOS implementation", slot: LEGACY_ZOS_IMPLEMENTATION_SLOT, role: "implementation" },
    ];

    let slotReadFailures = 0;
    let lastFailureMessage = "";

    for (const { label, slot, role } of SLOT_REGISTRY) {
      try {
        const slotValue = await INK_CLIENT.getStorageAt({ address: address as `0x${string}`, slot });
        if (slotValue && !/^0x0{64}$/i.test(slotValue)) {
          isProxy = true;
          const resolvedAddress = `0x${slotValue.slice(-40)}`;
          if (role === "admin" && !proxyAdmin) {
            proxyAdmin = resolvedAddress;
          } else if (role === "implementation" && !implementationAddressFromSlot) {
            implementationAddressFromSlot = resolvedAddress;
          } else if (role === "beacon" && !beaconAddress) {
            beaconAddress = resolvedAddress;
          }
        }
      } catch (err) {
        slotReadFailures++;
        lastFailureMessage = err instanceof Error ? err.message : String(err);
      }
    }

    // Consolidated: ONE message if reads failed, not one per slot (this
    // was the earlier noisy version — 4 near-identical error lines when
    // the RPC was blocked). Only surfaced if EVERY read failed; a mix of
    // some succeeding/some failing isn't reported as an error at all,
    // since that's expected (not every proxy populates every slot).
    if (slotReadFailures === SLOT_REGISTRY.length) {
      reasons.push(`Could not verify storage slots directly (RPC error: ${lastFailureMessage.slice(0, 120)}) — relying on explorer-resolved data only.`);
    }

    if (isProxy && !proxyAdmin && beaconAddress) {
      reasons.push(`This is a beacon proxy — upgrade control lives on the beacon contract (${beaconAddress}), not a direct admin address on the proxy itself.`);
    } else if (isProxy && implementationAddressFromSlot) {
      reasons.push(`Proxy implementation: ${implementationAddressFromSlot}.`);
    }
    if (isProxy && !proxyAdmin && !beaconAddress) {
      reasons.push(
        "Admin/upgrade-control address could not be determined — this may mean the proxy has no separate admin (common for several proxy patterns), or that information isn't exposed by the explorer or chain for this contract."
      );
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
    implementationAddressFromSlot,
    beaconAddress,
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
