import { NextRequest, NextResponse } from "next/server";
import { checkActivity } from "@/lib/checkActivity";
import { withCache } from "@/lib/cache";

export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();

    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json({ error: "Missing wallet address" }, { status: 400 });
    }

    // Cache for 60 seconds — same reasoning as the scan route.
    const result = await withCache(
      `activity:${wallet.toLowerCase()}`,
      60,
      () => checkActivity(wallet)
    );

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Activity check failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
