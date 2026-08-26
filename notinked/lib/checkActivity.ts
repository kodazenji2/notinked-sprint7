import { isAddress } from "viem";



const EXPLORER_BASE = "https://explorer.inkonchain.com/api/v2";

// TODO: confirm Nado and Tydro's actual contract addresses (from their
// own docs or verified contracts on Ink's explorer) to enable
// protocol-specific interaction counts. Left as an empty, clearly-labeled
// gap rather than a guess.
const KNOWN_PROTOCOLS: Record<string, string> = {
  // "0x...": "Nado",
  // "0x...": "Tydro",
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
  const addrData = await addrRes.json();

  const txRes = await fetch(`${EXPLORER_BASE}/addresses/${wallet}/transactions`);
  const txData = txRes.ok ? await txRes.json() : { items: [] };
  const txList: any[] = txData.items || [];

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

  const txCount: number = addrData.transactions_count ?? txList.length;
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
    isPartialContractCount: txList.length < txCount,
    walletAgeDays,
    daysSinceLastActive,
    protocolInteractions,
  };
}
