import { NextRequest, NextResponse } from "next/server";
import { scanWalletApprovals } from "@/lib/scanWallet";
import { withCache } from "@/lib/cache";

export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();

    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json({ error: "Missing wallet address" }, { status: 400 });
    }

    // Cache for 60 seconds — approvals don't change second-to-second, and
    // this avoids re-hitting Blockscout/RPC on repeated checks of the
    // same wallet in quick succession (e.g. someone refreshing, or our
    // own testing).
    const result = await withCache(
      `scan:${wallet.toLowerCase()}`,
      60,
      () => scanWalletApprovals(wallet)
    );

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scan failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
