import { NextResponse } from "next/server";
import { listRiskEntries, REGISTRY_VERSION } from "@/lib/riskRegistry";

/**
 * Public, open risk registry — the piece other Ink builders (Tydro, Nado,
 * or anyone else) can pull from directly instead of maintaining their own
 * scam-address list.
 *
 * No auth, no rate limit — this is meant to be freely embeddable
 * infrastructure. CORS is open for the same reason.
 */
export async function GET() {
  const entries = await listRiskEntries();

  const res = NextResponse.json({
    version: REGISTRY_VERSION,
    updatedEntryCount: entries.length,
    source: "NotInked — open risk registry for Ink chain",
    entries,
  });

  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Cache-Control", "public, max-age=300"); // 5 min cache, list changes infrequently

  return res;
}

export async function OPTIONS() {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return res;
}
