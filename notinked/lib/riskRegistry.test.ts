import { afterEach, describe, expect, it } from "vitest";
import { addRiskEntry, RISK_REGISTRY } from "./riskRegistry";

const address = "0x0000000000000000000000000000000000000001" as const;
const txHash = `0x${"a".repeat(64)}`;

afterEach(() => {
  RISK_REGISTRY.length = 0;
});

describe("risk registry consensus", () => {
  it("confirms an address after three distinct reporters", () => {
    const entry = {
      address,
      category: "other" as const,
      reason: "Suspicious activity",
      source: "community report",
      txHash,
      addedAt: new Date().toISOString(),
    };

    expect(addRiskEntry(entry, "reporter-1").status).toBe("pending");
    expect(addRiskEntry(entry, "reporter-2").reporterCount).toBe(2);
    expect(addRiskEntry(entry, "reporter-2").status).toBe("pending");
    expect(addRiskEntry(entry, "reporter-3").status).toBe("confirmed");
  });

  it("does not modify confirmed entries", () => {
    const entry = {
      address,
      category: "other" as const,
      reason: "Original reason",
      source: "community report",
      txHash,
      addedAt: new Date().toISOString(),
    };

    addRiskEntry(entry, "reporter-1");
    addRiskEntry(entry, "reporter-2");
    const confirmed = addRiskEntry(entry, "reporter-3");
    const unchanged = addRiskEntry({ ...entry, reason: "Changed reason", txHash: `0x${"b".repeat(64)}` }, "reporter-4");

    expect(unchanged).toEqual(confirmed);
  });
});