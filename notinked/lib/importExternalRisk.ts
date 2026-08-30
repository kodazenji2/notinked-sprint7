/**
 * One-off script to populate the risk registry from external trusted sources.
 *
 * Run manually: npx ts-node -O '{"module":"commonjs"}' lib/importExternalRisk.ts
 *
 * Sources:
 * - ScamSniffer (scamsniffer/scam-database on GitHub): a community-maintained
 *   list of known scam and drainer addresses
 * - Chainabuse: if a public API or bulk export is available
 *
 * GoPlus is NOT integrated because their live /supported_chains endpoint
 * does not include Ink (chain ID 57073) — verified against 45 supported chains.
 *
 * Strategy:
 * 1. Fetch address list from ScamSniffer
 * 2. For each candidate: check Ink activity via Blockscout
 * 3. If activity found: run checkContract() to cross-verify risk
 * 4. Add to registry based on corroboration logic
 * 5. Log summary for manual review
 */

import { isAddress } from "viem";
import { addRiskEntry, type RiskEntry } from "./riskRegistry";
import { checkContract } from "./checkContract";

const EXPLORER_BASE = "https://explorer.inkonchain.com/api/v2";

interface ScamSnifferAddress {
    address: string;
    category: string; // e.g., "phishing", "drainer", "honeypot"
}

interface ImportSummary {
    sourcesCandidates: { scamSniffer: number; chainabuse: number };
    inkActivityChecks: { found: number; notFound: number };
    contractChecks: { red: number; yellow: number; green: number };
    registryAdds: { confirmed: number; pending: number };
    errors: string[];
    notes: string[];
}

const summary: ImportSummary = {
    sourcesCandidates: { scamSniffer: 0, chainabuse: 0 },
    inkActivityChecks: { found: 0, notFound: 0 },
    contractChecks: { red: 0, yellow: 0, green: 0 },
    registryAdds: { confirmed: 0, pending: 0 },
    errors: [],
    notes: [],
};

async function fetchScamSnifferDatabase(): Promise<ScamSnifferAddress[]> {
    console.log(
        "[ScamSniffer] Fetching repository structure from api.github.com..."
    );

    try {
        const candidatePaths = [
            "https://api.github.com/repos/scamsniffer/scam-database/contents",
            "https://api.github.com/repos/scamsniffer/scam-database/contents/blacklist",
        ];

        const files: Array<{ name: string; path: string; type: string }> = [];

        for (const url of candidatePaths) {
            const repoRes = await fetch(url);
            if (!repoRes.ok) {
                continue;
            }

            const contents = (await repoRes.json()) as Array<{
                name: string;
                path: string;
                type: string;
            }>;

            for (const item of contents) {
                if (item.type === "file") {
                    files.push(item);
                }
            }
        }

        const addressFile = files.find(
            (f) =>
                f.name.toLowerCase().includes("address") ||
                f.name.toLowerCase().includes("blacklist") ||
                f.name.toLowerCase().includes("combined") ||
                f.name.toLowerCase().includes("all")
        );

        if (!addressFile) {
            summary.notes.push(
                "ScamSniffer: No address/blacklist dataset found in repo root or blacklist directory"
            );
            return [];
        }

        console.log(`[ScamSniffer] Found file: ${addressFile.path}`);

        const fileRes = await fetch(
            `https://raw.githubusercontent.com/scamsniffer/scam-database/main/${addressFile.path}`
        );
        if (!fileRes.ok) {
            throw new Error(
                `Failed to fetch ${addressFile.path}: ${fileRes.status}`
            );
        }

        const content = await fileRes.text();
        const candidates: ScamSnifferAddress[] = [];
        const seen = new Set<string>();

        try {
            const json = JSON.parse(content);
            const items = Array.isArray(json) ? json : [json];

            for (const item of items) {
                if (typeof item === "string" && isAddress(item)) {
                    const normalized = item.toLowerCase();
                    if (!seen.has(normalized)) {
                        seen.add(normalized);
                        candidates.push({
                            address: item,
                            category: "external-source",
                        });
                    }
                } else if (
                    item &&
                    typeof item === "object" &&
                    "address" in item &&
                    isAddress(String((item as any).address))
                ) {
                    const normalized = String((item as any).address).toLowerCase();
                    if (!seen.has(normalized)) {
                        seen.add(normalized);
                        candidates.push({
                            address: String((item as any).address),
                            category: String((item as any).category || "external-source"),
                        });
                    }
                }
            }
        } catch {
            const lines = content
                .split(/[\n,]+/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0);

            for (const line of lines) {
                if (isAddress(line)) {
                    const normalized = line.toLowerCase();
                    if (!seen.has(normalized)) {
                        seen.add(normalized);
                        candidates.push({
                            address: line,
                            category: "external-source",
                        });
                    }
                }
            }
        }

        console.log(`[ScamSniffer] Parsed ${candidates.length} candidate addresses`);
        summary.sourcesCandidates.scamSniffer = candidates.length;
        return candidates;
    } catch (err) {
        const msg =
            err instanceof Error ? err.message : String(err);
        summary.errors.push(`ScamSniffer fetch failed: ${msg}`);
        console.error(`[ScamSniffer] Error: ${msg}`);
        return [];
    }
}

async function checkChainabuseAvailability(): Promise<void> {
    console.log("[Chainabuse] Checking for public API...");

    try {
        const res = await fetch("https://www.chainabuse.com/api/", {
            method: "GET",
            timeout: 5000,
        } as any);

        if (res.ok || res.status === 401 || res.status === 403) {
            summary.notes.push(
                "Chainabuse: API endpoint exists but requires authentication or is rate-limited"
            );
            console.log(
                "[Chainabuse] API endpoint found but likely requires auth. Skipped for now."
            );
        }
    } catch (err) {
        summary.notes.push(
            "Chainabuse: No public API or bulk export currently available — manual integration not implemented"
        );
        console.log(
            "[Chainabuse] No public API found. Skipping for now (would require scraping or manual integration)."
        );
    }
}

async function checkInkActivity(address: string): Promise<boolean> {
    try {
        const res = await fetch(`${EXPLORER_BASE}/addresses/${address}`);
        if (!res.ok) {
            return false; // Address not found or error
        }

        const data = (await res.json()) as { transaction_count?: number };
        const txCount = data.transaction_count ?? 0;

        return txCount > 0;
    } catch {
        return false;
    }
}

async function processCandidate(
    candidate: ScamSnifferAddress
): Promise<void> {
    const { address } = candidate;

    // Step 1: Check Ink activity
    const hasActivity = await checkInkActivity(address);
    if (!hasActivity) {
        summary.inkActivityChecks.notFound++;
        return; // Skip if no Ink activity
    }

    summary.inkActivityChecks.found++;

    // Step 2: Run contract check
    let result;
    try {
        result = await checkContract(address);
    } catch (err) {
        summary.errors.push(
            `checkContract failed for ${address}: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
    }

    // Step 3: Record contract risk result
    if (result.risk === "red") {
        summary.contractChecks.red++;
    } else if (result.risk === "yellow") {
        summary.contractChecks.yellow++;
    } else {
        summary.contractChecks.green++;
    }

    // Step 4: Add to registry
    try {
        let status: "confirmed" | "pending";
        let reason: string;

        if (result.risk === "red" || result.risk === "yellow") {
            // Corroborate: ScamSniffer + checkContract agree
            status = "confirmed";
            reason = `ScamSniffer + on-chain check: ${result.reasons.join("; ")}`;
        } else {
            // Discrepancy: ScamSniffer flagged but checkContract is green
            status = "pending";
            reason = `ScamSniffer flagged but on-chain check is green (${result.reasons.join("; ")}) — requires manual review`;
        }

        await addRiskEntry(
            {
                address: address as any,
                category:
                    (candidate.category as any) || "other",
                reason,
                source: "scamsniffer",
                txHash: "", // No specific transaction, bulk import
                addedAt: new Date().toISOString(),
            },
            "scamsniffer-import"
        );

        if (status === "confirmed") {
            summary.registryAdds.confirmed++;
        } else {
            summary.registryAdds.pending++;
        }
    } catch (err) {
        summary.errors.push(
            `addRiskEntry failed for ${address}: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

async function main(): Promise<void> {
    console.log("=".repeat(60));
    console.log("External Risk Registry Import");
    console.log("=".repeat(60));
    console.log();

    // Step 1: Check Chainabuse availability
    await checkChainabuseAvailability();
    console.log();

    // Step 2: Fetch ScamSniffer candidates
    const candidates = await fetchScamSnifferDatabase();
    if (candidates.length === 0) {
        console.log(
            "No candidates found. Skipping processing."
        );
        printSummary();
        return;
    }

    console.log();
    console.log(
        `[Processing] Checking ${candidates.length} candidates for Ink activity...`
    );

    // Step 3: Process each candidate
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if ((i + 1) % 50 === 0) {
            console.log(`  ... ${i + 1}/${candidates.length}`);
        }
        await processCandidate(candidate);
    }

    console.log();
    printSummary();
}

function printSummary(): void {
    console.log("=".repeat(60));
    console.log("Import Summary");
    console.log("=".repeat(60));
    console.log();
    console.log(
        `Sources:
  - ScamSniffer: ${summary.sourcesCandidates.scamSniffer} candidates`
    );
    console.log();
    console.log(
        `Ink Activity Checks:
  - Found: ${summary.inkActivityChecks.found}
  - Not found (discarded): ${summary.inkActivityChecks.notFound}`
    );
    console.log();
    console.log(
        `Contract Risk Assessment (for addresses with Ink activity):
  - Red:    ${summary.contractChecks.red}
  - Yellow: ${summary.contractChecks.yellow}
  - Green:  ${summary.contractChecks.green}`
    );
    console.log();
    console.log(
        `Registry Additions:
  - Confirmed: ${summary.registryAdds.confirmed} (risk corroborated)
  - Pending:   ${summary.registryAdds.pending} (requires manual review)`
    );
    console.log();

    if (summary.notes.length > 0) {
        console.log("Notes:");
        for (const note of summary.notes) {
            console.log(`  • ${note}`);
        }
        console.log();
    }

    if (summary.errors.length > 0) {
        console.log("Errors (did not block processing):");
        for (const err of summary.errors) {
            console.log(`  • ${err}`);
        }
        console.log();
    }

    console.log("=".repeat(60));
}

// Run if executed directly
if (require.main === module) {
    main().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}

export { fetchScamSnifferDatabase, checkChainabuseAvailability, main };
