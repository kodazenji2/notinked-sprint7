import { NextRequest, NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { addRiskEntry } from "@/lib/riskRegistry";

const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export async function POST(req: NextRequest) {
    let body: {
        address?: string;
        category?: "drainer" | "phishing" | "rug" | "unlimited-approval-abuse" | "other";
        reason?: string;
        txHash?: string;
        reporterId?: string;
    };

    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.address || !isAddress(body.address)) {
        return NextResponse.json({ error: "Provide a valid EVM address" }, { status: 400 });
    }
    if (!body.txHash || !TX_HASH_PATTERN.test(body.txHash)) {
        return NextResponse.json(
            { error: "txHash must be a 0x-prefixed 64-hex-character transaction hash" },
            { status: 400 }
        );
    }
    if (!body.reason?.trim()) {
        return NextResponse.json({ error: "A reason is required" }, { status: 400 });
    }

    const entry = await addRiskEntry({
        address: body.address as Address,
        category: body.category ?? "other",
        reason: body.reason.trim(),
        source: "community report",
        txHash: body.txHash,
        addedAt: new Date().toISOString(),
    }, body.reporterId?.trim() || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anonymous");

    return NextResponse.json({
        status: entry.status,
        reporterCount: entry.reporterCount,
        confirmationsRemaining: Math.max(0, 3 - entry.reporterCount),
        entry,
    });
}