import { describe, expect, it } from "vitest";
import { formatAcpDeliverable, parseAcpRequirement, usdc6dpToDollars } from "../../src/acp/acpProvider.js";

const CONTRACT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

describe("parseAcpRequirement", () => {
  it("accepts a well-formed requirement, lowercasing the token", () => {
    const mixedCase = "0x" + CONTRACT.slice(2).toUpperCase();
    const result = parseAcpRequirement(JSON.stringify({ token: mixedCase }));
    expect(result).toEqual({ ok: true, requirement: { token: CONTRACT } });
  });

  it("rejects non-JSON content", () => {
    const result = parseAcpRequirement("not json");
    expect(result.ok).toBe(false);
  });

  it("rejects a JSON array (not an object)", () => {
    const result = parseAcpRequirement(JSON.stringify([CONTRACT]));
    expect(result.ok).toBe(false);
  });

  it("rejects an object missing the token field", () => {
    const result = parseAcpRequirement(JSON.stringify({ foo: "bar" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("token");
  });

  it("rejects a malformed token address", () => {
    const result = parseAcpRequirement(JSON.stringify({ token: "not-an-address" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a token that's the wrong length", () => {
    const result = parseAcpRequirement(JSON.stringify({ token: "0xdead" }));
    expect(result.ok).toBe(false);
  });
});

describe("usdc6dpToDollars", () => {
  it("converts the repo's raw 6dp convention to AssetToken.usdc's expected human-decimal units", () => {
    // Regression coverage: AssetToken.usdc(amount, chainId) feeds `amount`
    // straight into viem's parseUnits with no further scaling (confirmed
    // reading assetToken.js) — passing a raw 6dp bigint through unconverted
    // would set a job's budget a million times too high.
    expect(usdc6dpToDollars(500_000n)).toBe(0.5);
    expect(usdc6dpToDollars(250_000n)).toBe(0.25);
    expect(usdc6dpToDollars(1_000_000n)).toBe(1);
  });

  it("handles zero", () => {
    expect(usdc6dpToDollars(0n)).toBe(0);
  });
});

describe("formatAcpDeliverable", () => {
  it("serializes a cache_hit outcome's output as the job deliverable's tier field", () => {
    // Input uses the core's generic `output` field; the deliverable JSON
    // keeps `tier` — proving the internal->external edge mapping, not just
    // that both sides got renamed identically.
    const deliverable = formatAcpDeliverable({ outcome: "cache_hit", output: "high_conviction", checkedAt: "2026-01-01T00:00:00.000Z" });
    expect(JSON.parse(deliverable)).toEqual({ tier: "high_conviction", note: "Conviction tier, not a safety/scam verdict." });
  });

  it("serializes a paid outcome's output the same way, dropping the tx hash from the deliverable itself", () => {
    const deliverable = formatAcpDeliverable({ outcome: "paid", output: "low_conviction", txHash: "0xaa" });
    expect(JSON.parse(deliverable)).toEqual({ tier: "low_conviction", note: "Conviction tier, not a safety/scam verdict." });
  });
});
