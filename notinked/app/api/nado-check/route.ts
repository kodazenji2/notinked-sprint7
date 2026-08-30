import { NextRequest, NextResponse } from "next/server";
import { checkNadoPoints } from "@/lib/checkNadoActivity";

export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();

    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json({ error: "Missing wallet address" }, { status: 400 });
    }

    const result = await checkNadoPoints(wallet);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Nado check failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
