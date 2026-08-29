import { afterEach, describe, expect, it } from "vitest";
import { addRiskEntry, clearRiskRegistry, isKnownRisk, listRiskEntries, RISK_REGISTRY } from "./riskRegistry";

const makeAddress = (suffix: string) => `0x${"0".repeat(24)}${suffix}` as const;
const makeTxHash = (suffix: string) => `0x${suffix.repeat(64).slice(0, 64)}`;

afterEach(async () => {
  RISK_REGISTRY.length = 0;
  await clearRiskRegistry();
});

describe("risk registry consensus", () => {
  it("confirms an address after three distinct reporters", async () => {
    const address = makeAddress("0001");
    const txHash = makeTxHash("a");
    const entry = {
      address,
      category: "other" as const,
      reason: "Suspicious activity",
      source: "community report",
      txHash,
      addedAt: new Date().toISOString(),
    };

    expect((await addRiskEntry(entry, "reporter-1")).status).toBe("pending");
    expect((await addRiskEntry(entry, "reporter-2")).reporterCount).toBe(2);
    expect((await addRiskEntry(entry, "reporter-2")).status).toBe("pending");
    expect((await addRiskEntry(entry, "reporter-3")).status).toBe("confirmed");
  }, 20000);

  it("does not modify confirmed entries", async () => {
    const address = makeAddress("0002");
    const txHash = makeTxHash("a");
    const entry = {
      address,
      category: "other" as const,
      reason: "Original reason",
      source: "community report",
      txHash,
      addedAt: new Date().toISOString(),
    };

    await addRiskEntry(entry, "reporter-1");
    await addRiskEntry(entry, "reporter-2");
    const confirmed = await addRiskEntry(entry, "reporter-3");
    const unchanged = await addRiskEntry({ ...entry, reason: "Changed reason", txHash: makeTxHash("b") }, "reporter-4");

    expect(unchanged).toEqual(confirmed);
  }, 20000);

  it("persists known risks to Redis and exposes them through the public registry list", async () => {
    const address = makeAddress("0003");
    const txHash = makeTxHash("a");

    await addRiskEntry({
      address,
      category: "phishing",
      reason: "Suspicious phishing activity",
      source: "community report",
      txHash,
      addedAt: new Date().toISOString(),
    }, "reporter-1");

    await addRiskEntry({
      address,
      category: "phishing",
      reason: "Suspicious phishing activity",
      source: "community report",
      txHash,
      addedAt: new Date().toISOString(),
    }, "reporter-2");

    await addRiskEntry({
      address,
      category: "phishing",
      reason: "Suspicious phishing activity",
      source: "community report",
      txHash,
      addedAt: new Date().toISOString(),
    }, "reporter-3");

    expect(await isKnownRisk(address)).toBeTruthy();
    expect((await listRiskEntries()).length).toBeGreaterThan(0);
  }, 20000);
});