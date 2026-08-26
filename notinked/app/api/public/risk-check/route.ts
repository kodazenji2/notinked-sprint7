import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { checkContract } from "@/lib/checkContract";

/**
 * Public single-address check — lightweight, no auth, meant to be called
 * from other Ink dApps' frontends (e.g. Tydro/Nado showing a badge before
 * a user approves or deposits into a pool).
 *
 * Runs the SAME full check as the "Before You Ape" tab (registry +
 * verification status + deployment age) via checkContract() — previously
 * this endpoint only checked the registry, which meant the embedded
 * widget gave a weaker signal than the app itself. Fixed so both always
 * agree.
 *
 * GET /api/public/risk-check?address=0x...
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");

  if (!address || !isAddress(address)) {
    const res = NextResponse.json(
      { error: "Provide a valid EVM address as ?address=0x..." },
      { status: 400 }
    );
    res.headers.set("Access-Control-Allow-Origin", "*");
    return res;
  }

  try {
    const result = await checkContract(address);

    const res = NextResponse.json({
      address: result.address,
      risk: result.risk,
      reasons: result.reasons,
      isVerified: result.isVerified,
      ageInDays: result.ageInDays,
    });

    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Cache-Control", "public, max-age=300");

    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Check failed";
    const res = NextResponse.json({ error: message }, { status: 500 });
    res.headers.set("Access-Control-Allow-Origin", "*");
    return res;
  }
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return res;
}
