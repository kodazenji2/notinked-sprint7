import { NextRequest, NextResponse } from "next/server";
import { checkContract } from "@/lib/checkContract";

export async function POST(req: NextRequest) {
  try {
    const { address } = await req.json();

    if (!address || typeof address !== "string") {
      return NextResponse.json({ error: "Missing contract address" }, { status: 400 });
    }

    const result = await checkContract(address);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Contract check failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
