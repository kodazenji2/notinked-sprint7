import { NextRequest, NextResponse } from "next/server";
import { checkMessageForScam, extractAddresses } from "@/lib/groqClient";
import { checkContract, type ContractCheckResult } from "@/lib/checkContract";
import { checkAndIncrement } from "@/lib/rateLimit";
import { getOrCreateSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  try {
    const { text, identifier, sessionId, isPremium } = await req.json();

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json({ error: "Missing message text" }, { status: 400 });
    }

    // Prefer wallet address if valid, otherwise use session-based limiting
    const walletLike = typeof identifier === "string" && /^0x[a-fA-F0-9]{40}$/.test(identifier.trim());
    let limiterId: string;
    let responseSessionId: string | undefined;

    if (walletLike) {
      limiterId = identifier.trim().toLowerCase();
    } else {
      const session = await getOrCreateSession(sessionId);
      limiterId = session.id;
      responseSessionId = session.id;
    }

    const limit = await checkAndIncrement(limiterId, Boolean(isPremium));

    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: "Daily check limit reached",
          limit: limit.limit,
          resetsAt: limit.resetsAt,
          ...(responseSessionId && { sessionId: responseSessionId }),
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
      ...(responseSessionId && { sessionId: responseSessionId }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scam check failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
