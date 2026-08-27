import { isAddress } from "viem";

/**
 * On-chain activity snapshot — NOT an official INK points calculator.
 *
 * Kraken has not published a formal on-chain points formula as of this
 * writing; only Kraken Pro (centralized exchange) trading is a confirmed
 * points source. Nado trading and Tydro liquidity provision are confirmed
 * airdrop-eligibility categories, but their exact weighting is
 * unpublished. This shows verifiable on-chain facts only — treat it as
 * informational, not a guarantee of any allocation.
 *
 * Runs server-side (this file, via the API route) rather than
 * client-side like the original standalone HTML version — that version
 * hit the browser's CORS restrictions calling Blockscout directly,
 * which is the likely cause of the identical-results bug seen there.
 * Server-side fetches aren't subject to CORS.
 */

const EXPLORER_BASE = "https://explorer.inkonchain.com/api/v2";

const KNOWN_PROTOCOLS: Record<string, string> = {
  // Nado mainnet contracts from the official deployment documentation.
  "0xd218103918c19d0a10cf35300e4cfafbd444c5fe": "Nado",
  "0xf8599d58d1137fc56ecdd9c16ee139c8bdf96da1": "Nado",
  "0xfcd94770b95fd9cc67143132bb172eb17a0907fe": "Nado",
  "0x05ec92d78ed421f3d3ada77ffde167106565974e": "Nado",
  "0x68798229f88251b31d534733d6c4098318c9dff8": "Nado",
  // TydroInkPoints token address from the supplied project brief.
  "0x40abd730cc9da34a8ee9823feabdba35e50c4ac7": "Tydro",
};

export interface ActivityCheckResult {
  wallet: string;
  txCount: number;
  uniqueContractsTouched: number;
  isPartialContractCount: boolean; // true if we only saw a page of tx history, not full history
  walletAgeDays: number | null;
  daysSinceLastActive: number | null;
  protocolInteractions: Record<string, number>; // name -> count, only for KNOWN_PROTOCOLS entries
}

export async function checkActivity(walletInput: string): Promise<ActivityCheckResult> {
  if (!isAddress(walletInput)) {
    throw new Error("Not a valid EVM address");
  }
  const wallet = walletInput;

  const addrRes = await fetch(`${EXPLORER_BASE}/addresses/${wallet}`);
  if (!addrRes.ok) {
    throw new Error(
      addrRes.status === 404
        ? "No on-chain activity found for this address on Ink."
        : `Explorer returned ${addrRes.status}`
    );
  }
  // Confirmed via live testing: this endpoint does NOT include a
  // transactions_count field (earlier assumption was wrong). Try
  // Blockscout's separate /counters endpoint instead, which is the
  // documented location for this in Blockscout v2 — but treat even
  // that as unconfirmed until tested, and fall back honestly if it
  // doesn't exist either.
  const addrData = await addrRes.json();

  let realTxTotal: number | null = null;
  try {
    const countersRes = await fetch(`${EXPLORER_BASE}/addresses/${wallet}/counters`);
    if (countersRes.ok) {
      const countersData = await countersRes.json();
      if (countersData.transactions_count) {
        realTxTotal = parseInt(countersData.transactions_count, 10);
      }
    }
  } catch {
    // Counters endpoint unavailable or shaped differently — fall through
    // to the honest "we only know what we can see" behavior below.
  }

  const txRes = await fetch(`${EXPLORER_BASE}/addresses/${wallet}/transactions`);
  const txData = txRes.ok ? await txRes.json() : { items: [] };
  const txList: any[] = txData.items || [];

  // If we couldn't get a real total, we genuinely don't know the true
  // count — showing txList.length as if it were the total would be
  // misleading (that's the exact bug just found). Report what we
  // actually know instead.
  const txCount = realTxTotal ?? txList.length;
  const isPartialData = realTxTotal === null || txList.length < (realTxTotal ?? 0);

  const uniqueContracts = new Set<string>();
  const protocolInteractions: Record<string, number> = {};
  let firstTxDate: Date | null = null;
  let lastTxDate: Date | null = null;

  for (const tx of txList) {
    const counterparty = tx.to?.hash ? (tx.to.hash as string).toLowerCase() : null;
    if (counterparty && counterparty !== wallet.toLowerCase()) {
      uniqueContracts.add(counterparty);

      const protocolName = KNOWN_PROTOCOLS[counterparty];
      if (protocolName) {
        protocolInteractions[protocolName] = (protocolInteractions[protocolName] || 0) + 1;
      }
    }
    if (tx.timestamp) {
      const ts = new Date(tx.timestamp);
      if (!firstTxDate || ts < firstTxDate) firstTxDate = ts;
      if (!lastTxDate || ts > lastTxDate) lastTxDate = ts;
    }
  }

  const walletAgeDays = firstTxDate
    ? Math.floor((Date.now() - (firstTxDate as Date).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const daysSinceLastActive = lastTxDate
    ? Math.floor((Date.now() - (lastTxDate as Date).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    wallet,
    txCount,
    uniqueContractsTouched: uniqueContracts.size,
    isPartialContractCount: isPartialData,
    walletAgeDays,
    daysSinceLastActive,
    protocolInteractions,
  };
}
