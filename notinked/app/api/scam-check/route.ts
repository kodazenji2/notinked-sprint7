import { NextRequest, NextResponse } from "next/server";
import { checkMessageForScam, extractAddresses } from "@/lib/groqClient";
import { checkContract, type ContractCheckResult } from "@/lib/checkContract";
import { checkAndIncrement } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  try {
    const { text, identifier, isPremium } = await req.json();

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json({ error: "Missing message text" }, { status: 400 });
    }

    // `identifier` should be a stable per-user value — wallet address once
    // wallet-signature auth is added. Falling back to a placeholder here so
    // the route works before auth exists; replace before shipping.
    const id = typeof identifier === "string" && identifier ? identifier : "anonymous";

    const limit = checkAndIncrement(id, Boolean(isPremium));

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
