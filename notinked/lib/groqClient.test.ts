import { describe, expect, it } from "vitest";
import { extractAddresses, extractUrls } from "./groqClient";

describe("message extraction", () => {
    it("extracts unique URLs and wallet addresses", () => {
        const address = `0x${"1".repeat(40)}`;
        const text = `Visit https://example.com and https://example.com, then check ${address}.`;

        expect(extractUrls(text)).toEqual(["https://example.com"]);
        expect(extractAddresses(text)).toEqual([address]);
    });
});