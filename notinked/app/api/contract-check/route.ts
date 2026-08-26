import { NextRequest, NextResponse } from "next/server";
import { checkContract } from "@/lib/checkContract";
import { withCache } from "@/lib/cache";

export async function POST(req: NextRequest) {
  try {
    const { address } = await req.json();

    if (!address || typeof address !== "string") {
      return NextResponse.json({ error: "Missing contract address" }, { status: 400 });
    }

    // Cache for 5 minutes — verification/age/ownership status is stable
    // over short timeframes, and this is the endpoint the embeddable
    // widget calls too, so caching here reduces load from every site
    // embedding it, not just this app's own traffic.
    const result = await withCache(
      `contract:${address.toLowerCase()}`,
      300,
      () => checkContract(address)
    );

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Contract check failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
