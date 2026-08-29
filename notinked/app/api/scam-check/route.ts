import { NextRequest, NextResponse } from "next/server";
import { checkMessageForScam, extractAddresses } from "@/lib/groqClient";
import { checkContract, type ContractCheckResult } from "@/lib/checkContract";
import { checkAndIncrement } from "@/lib/rateLimit";

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const realIp = req.headers.get("x-real-ip") ?? "";
  const cloudflare = req.headers.get("cf-connecting-ip") ?? "";

  const candidate = [forwarded, realIp, cloudflare]
    .flatMap((value) => value.split(",").map((part) => part.trim()))
    .find((value) => value.length > 0);

  return candidate ?? "anonymous";
}

export async function POST(req: NextRequest) {
  try {
    const { text, identifier, isPremium } = await req.json();

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json({ error: "Missing message text" }, { status: 400 });
    }

    const ip = getClientIp(req);
    const walletLike = typeof identifier === "string" && /^0x[a-fA-F0-9]{40}$/.test(identifier.trim());
    const id = walletLike ? identifier.trim().toLowerCase() : ip;

    const limit = await checkAndIncrement(id, Boolean(isPremium));

    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: "Daily check limit reached",
          limit: limit.limit,
          resetsAt: limit.resetsAt,
        },
        { status: 429 }
      );
    }

    const mentionedAddresses = (await Promise.all(
      extractAddresses(text).map(async (address) => {
        try {
          return await checkContract(address);
        } catch {
          return null;
        }
      })
    )).filter((entry): entry is ContractCheckResult => entry !== null);
    const result = await checkMessageForScam(
      text,
      mentionedAddresses.flatMap((entry) => [entry.address, ...entry.reasons])
    );

    return NextResponse.json({
      ...result,
      mentionedAddresses,
      remaining: limit.remaining,
      limit: limit.limit,
      resetsAt: limit.resetsAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scam check failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
