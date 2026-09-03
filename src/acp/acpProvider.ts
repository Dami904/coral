import type { HandleOutcome } from "../types.js";

const CONTRACT_RE = /^0x[a-fA-F0-9]{40}$/;

export type AcpRequirement = { token: `0x${string}` };
export type ParsedRequirement = { ok: true; requirement: AcpRequirement } | { ok: false; reason: string };

/**
 * The buyer's first "requirement" message on a job carries a JSON string
 * whose shape is entirely undefined by the ACP SDK itself (verified
 * reading events/types.ts's AgentMessage — `content: string`, nothing
 * more structured) — Coral defines and owns this shape: `{"token":"0x..."}`.
 * Kept as a pure function so the validation logic (and every edge case
 * below) is unit-testable without a live ACP job.
 */
export function parseAcpRequirement(content: string): ParsedRequirement {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return { ok: false, reason: `requirement is not valid JSON: ${String(err)}` };
  }
  if (typeof data !== "object" || data === null || !("token" in data)) {
    return { ok: false, reason: 'requirement must be a JSON object with a "token" field' };
  }
  const token = data.token;
  if (typeof token !== "string" || !CONTRACT_RE.test(token)) {
    return { ok: false, reason: '"token" must be a 0x-prefixed 20-byte contract address' };
  }
  return { ok: true, requirement: { token: token.toLowerCase() as `0x${string}` } };
}

/**
 * The job's on-chain USDC amount is a human-readable decimal (AssetToken.usdc's
 * own `amount: number` — confirmed reading assetToken.js: it feeds straight
 * into viem's parseUnits, never divided/scaled again), not the raw 6-decimal
 * integer this codebase uses everywhere else (GATEWAY_FEE_USDC_6DP,
 * PRICE_USDC_6DP). Converting in one named place so this unit mismatch can
 * never silently reappear as a 1,000,000x pricing bug.
 */
export function usdc6dpToDollars(amountUsdc6dp: bigint): number {
  return Number(amountUsdc6dp) / 1_000_000;
}

/**
 * The job's on-chain deliverable (session.submit — a plain string, per
 * jobSession.ts) for a resolved check. Only ever called for cache_hit/paid
 * outcomes — pending_approval/blocked don't produce a deliverable at all
 * (see live-acp-provider.ts's handling of those instead).
 */
export function formatAcpDeliverable(outcome: Extract<HandleOutcome, { outcome: "cache_hit" | "paid" }>): string {
  // `outcome.output` is the core's generic field name; the deliverable
  // itself keeps `tier` — this deployment's one real hired agent (Sibyl)
  // really is a conviction tier, and there's no reason to break that
  // wire-facing label just because the core underneath it generalized.
  return JSON.stringify({
    tier: outcome.output,
    note: "Conviction tier, not a safety/scam verdict.",
  });
}
