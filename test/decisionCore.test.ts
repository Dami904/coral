import { describe, expect, it } from "vitest";
import { handleGatewayQuery, handleJobQuery, resumeAfterApproval } from "../src/decisionCore.js";
import type {
  ChainPort,
  HiredAgentId,
  IncomingPaymentPort,
  IncomingPaymentVerification,
  IntelligencePort,
  JobRecord,
  MemoryPort,
  PaymentOutcome,
  PendingResolution,
  ResumableChainPort,
} from "../src/types.js";
import { CacheWriteFailedAfterPaymentError, IntelligenceCheckFailedAfterPaymentError } from "../src/types.js";

const CONTRACT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const HIRED_AGENT_ID: HiredAgentId = "sibyl-conviction-check";
const VENDOR: `0x${string}` = "0x000000000000000000000000000000000000ea";
const PRICE = 250_000n;
const STALE_WINDOW_MS = 60 * 60 * 1000;
const NOW = new Date("2026-08-26T12:00:00.000Z");

function makeMemory(
  recallResult: JobRecord | null,
  opts: {
    rememberError?: Error;
    consumedTxHashes?: `0x${string}`[];
    pendingEscalation?: { requestId: bigint; fromBlock: bigint } | null;
  } = {},
): MemoryPort & {
  calls: string[];
  remembered: { hiredAgentId: HiredAgentId; input: string; record: JobRecord }[];
  events: { kind: string; body: Record<string, unknown>; ref: { category: string; name: string } }[];
  consumedPayments: { txHash: `0x${string}`; body: Record<string, unknown> }[];
  pendingEscalationsSet: { hiredAgentId: HiredAgentId; input: string; requestId: bigint; fromBlock: bigint }[];
  pendingEscalationsCleared: string[];
} {
  const calls: string[] = [];
  const remembered: { hiredAgentId: HiredAgentId; input: string; record: JobRecord }[] = [];
  const events: { kind: string; body: Record<string, unknown>; ref: { category: string; name: string } }[] = [];
  const consumedPayments: { txHash: `0x${string}`; body: Record<string, unknown> }[] = [];
  const consumedTxHashes = new Set(opts.consumedTxHashes ?? []);
  const pendingEscalationsSet: { hiredAgentId: HiredAgentId; input: string; requestId: bigint; fromBlock: bigint }[] = [];
  const pendingEscalationsCleared: string[] = [];
  let pendingEscalation = opts.pendingEscalation ?? null;
  return {
    calls,
    remembered,
    events,
    consumedPayments,
    pendingEscalationsSet,
    pendingEscalationsCleared,
    async recallJob(hiredAgentId, input) {
      calls.push("recall");
      expect(input).toBe(CONTRACT);
      return recallResult;
    },
    async rememberJob(hiredAgentId, input, record) {
      calls.push("remember");
      if (opts.rememberError) throw opts.rememberError;
      remembered.push({ hiredAgentId, input, record });
    },
    async recordEvent(kind, body, ref) {
      calls.push("recordEvent");
      events.push({ kind, body, ref });
    },
    async wasPaymentConsumed(txHash) {
      calls.push("wasPaymentConsumed");
      return consumedTxHashes.has(txHash);
    },
    async markPaymentConsumed(txHash, body) {
      calls.push("markPaymentConsumed");
      consumedTxHashes.add(txHash);
      consumedPayments.push({ txHash, body });
    },
    async getPendingEscalation() {
      calls.push("getPendingEscalation");
      return pendingEscalation;
    },
    async setPendingEscalation(hiredAgentId, input, requestId, fromBlock) {
      calls.push("setPendingEscalation");
      pendingEscalation = { requestId, fromBlock };
      pendingEscalationsSet.push({ hiredAgentId, input, requestId, fromBlock });
    },
    async clearPendingEscalation(hiredAgentId, input) {
      calls.push("clearPendingEscalation");
      pendingEscalation = null;
      pendingEscalationsCleared.push(input);
    },
  };
}

function makeChain(
  outcome: PaymentOutcome | Error,
): ChainPort & { calls: string[]; requestedAmount: bigint | null } {
  const calls: string[] = [];
  let requestedAmount: bigint | null = null;
  return {
    calls,
    get requestedAmount() {
      return requestedAmount;
    },
    async requestPayment(payTo, amount) {
      calls.push("requestPayment");
      expect(payTo).toBe(VENDOR);
      requestedAmount = amount;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

function makeIntelligence(
  result: { output: string; raw: unknown; sourceEndpoint: string } | Error,
): IntelligencePort & { calls: string[]; receivedTxHash: `0x${string}` | null } {
  const calls: string[] = [];
  let receivedTxHash: `0x${string}` | null = null;
  return {
    calls,
    get receivedTxHash() {
      return receivedTxHash;
    },
    async invoke(input, paymentTxHash) {
      calls.push("invoke");
      expect(input).toBe(CONTRACT);
      receivedTxHash = paymentTxHash;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function makeIncomingPayment(
  result: IncomingPaymentVerification,
): IncomingPaymentPort & { calls: { txHash: `0x${string}`; minAmount: bigint }[] } {
  const calls: { txHash: `0x${string}`; minAmount: bigint }[] = [];
  return {
    calls,
    async verifyPayment(txHash, minAmount) {
      calls.push({ txHash, minAmount });
      return result;
    },
  };
}

describe("handleJobQuery", () => {
  it("returns the cached tier and never touches the chain when the cache is fresh", async () => {
    const cached: JobRecord = {
      hiredAgentId: HIRED_AGENT_ID,
      output: "safe",
      raw_response: { ok: true },
      checked_at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
      source_endpoint: "/api/evaluate",
    };
    const memory = makeMemory(cached);
    const chain = makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "should never be called" });
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "cache_hit", output: "safe", checkedAt: cached.checked_at });
    expect(chain.calls).toEqual([]);
    expect(intelligence.calls).toEqual([]);
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0]).toMatchObject({ body: { cache_hit: true, paid: false } });
  });

  it("treats a stale cache entry as a miss and requests payment", async () => {
    const stale: JobRecord = {
      hiredAgentId: HIRED_AGENT_ID,
      output: "safe",
      raw_response: {},
      checked_at: new Date(NOW.getTime() - 2 * STALE_WINDOW_MS).toISOString(),
      source_endpoint: "/api/evaluate",
    };
    const memory = makeMemory(stale);
    const chain = makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: "0xaa" });
    const intelligence = makeIntelligence({ output: "safe", raw: {}, sourceEndpoint: "/api/evaluate" });

    const result = await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    expect(chain.calls).toEqual(["requestPayment"]);
    expect(result.outcome).toBe("paid");
  });

  it("checks memory before ever calling the chain (non-negotiable invariant)", async () => {
    const memory = makeMemory(null);
    const chain = makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: "0xaa" });
    const intelligence = makeIntelligence({ output: "safe", raw: {}, sourceEndpoint: "/api/evaluate" });

    await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    const recallIndex = memory.calls.indexOf("recall");
    const paymentIndex = chain.calls.indexOf("requestPayment");
    expect(recallIndex).toBeGreaterThanOrEqual(0);
    expect(paymentIndex).toBeGreaterThan(-1);
    // recall happened (on the memory log) strictly before requestPayment could have run
    expect(recallIndex).toBe(0);
  });

  it("requests exactly the configured price for the vendor address on a cache miss", async () => {
    const memory = makeMemory(null);
    const chain = makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: "0xaa" });
    const intelligence = makeIntelligence({ output: "safe", raw: {}, sourceEndpoint: "/api/evaluate" });

    await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    expect(chain.requestedAmount).toBe(PRICE);
  });

  it("on a blocked payment: returns blocked, records the reason, never calls intelligence or caches anything", async () => {
    const memory = makeMemory(null);
    const chain = makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "budget-window" });
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "blocked", reason: "budget-window" });
    expect(intelligence.calls).toEqual([]);
    expect(memory.remembered).toEqual([]);
    expect(memory.events[0]).toMatchObject({ body: { cache_hit: false, paid: false, blocked_reason: "budget-window" } });
  });

  it("on an escalated (pending) payment: returns pending_approval, does not cache or check intelligence yet", async () => {
    const memory = makeMemory(null);
    const chain = makeChain({ kind: "pending", payTo: VENDOR, amount: PRICE, requestId: 7n, txHash: "0xaa", blockNumber: 42n });
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "pending_approval", requestId: 7n, fromBlock: 42n });
    expect(intelligence.calls).toEqual([]);
    expect(memory.remembered).toEqual([]);
    expect(memory.events[0]).toMatchObject({
      body: { cache_hit: false, paid: false, pending_request_id: "7" },
    });
    expect(memory.pendingEscalationsSet).toEqual([{ hiredAgentId: HIRED_AGENT_ID, input: CONTRACT, requestId: 7n, fromBlock: 42n }]);
  });

  it("on a contract with an already-pending escalation: returns it directly and never proposes a second one", async () => {
    // Regression coverage for a real bug found running scripts/live-http-server.ts
    // live: a repeat query used to fire a brand-new requestPayment every
    // time, and SpendGuard's own rate/budget rules don't count an
    // unapproved pending request (test/SpendGuard.t.sol's
    // PendingDoesNotConsumeBudgetOrRateUntilApproved), so nothing on-chain
    // stopped unbounded repeat-escalation spam without this check.
    const memory = makeMemory(null, { pendingEscalation: { requestId: 99n, fromBlock: 500n } });
    const chain = makeChain(new Error("should never be called — an existing pending escalation must short-circuit before this"));
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "pending_approval", requestId: 99n, fromBlock: 500n });
    expect(chain.calls).toEqual([]);
    expect(intelligence.calls).toEqual([]);
    expect(memory.events[0]).toMatchObject({
      body: { cache_hit: false, paid: false, pending_request_id: "99", already_pending: true },
    });
  });

  it("on a sent payment: checks intelligence, caches the tier, and journals the paid event", async () => {
    const memory = makeMemory(null);
    const chain = makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: "0xbeef" });
    const intelligence = makeIntelligence({ output: "unsafe", raw: { flagged: true }, sourceEndpoint: "/api/evaluate" });

    const result = await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "paid", output: "unsafe", txHash: "0xbeef" });
    expect(intelligence.receivedTxHash).toBe("0xbeef");
    expect(memory.remembered).toEqual([
      {
        hiredAgentId: HIRED_AGENT_ID,
        input: CONTRACT,
        record: {
          hiredAgentId: HIRED_AGENT_ID,
          output: "unsafe",
          raw_response: { flagged: true },
          checked_at: NOW.toISOString(),
          source_endpoint: "/api/evaluate",
        },
      },
    ]);
    expect(memory.events.at(-1)).toMatchObject({
      body: { cache_hit: false, paid: true, tx_hash: "0xbeef", output: "unsafe" },
    });
    expect(memory.events.at(-1)?.body).not.toHaveProperty("requester");
  });

  it("threads an optional requester into the journal event when the caller provides one, omits it otherwise", async () => {
    const REQUESTER = "0x00000000000000000000000000000000c0ffee";
    const memory = makeMemory(null);
    const chain = makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: "0xbeef" });
    const intelligence = makeIntelligence({ output: "safe", raw: {}, sourceEndpoint: "/api/evaluate" });

    await handleJobQuery(
      HIRED_AGENT_ID,
      CONTRACT,
      { memory, chain, intelligence, payTo: VENDOR, priceUsdc6dp: PRICE, staleWindowMs: STALE_WINDOW_MS, now: () => NOW },
      REQUESTER,
    );

    expect(memory.events.at(-1)?.body).toMatchObject({ requester: REQUESTER });
  });

  it("on a sent payment whose intelligence check then fails: journals the tx before throwing, writes no cache entry", async () => {
    const memory = makeMemory(null);
    const chain = makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: "0xbeef" });
    const boom = new Error("endpoint timed out");
    const intelligence = makeIntelligence(boom);

    await expect(
      handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
        memory,
        chain,
        intelligence,
        payTo: VENDOR,
        priceUsdc6dp: PRICE,
        staleWindowMs: STALE_WINDOW_MS,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(IntelligenceCheckFailedAfterPaymentError);

    expect(memory.remembered).toEqual([]);
    expect(memory.events[0]).toMatchObject({
      body: { cache_hit: false, paid: true, tx_hash: "0xbeef" },
    });
    expect((memory.events[0]?.body["intel_error"] as string)).toContain("endpoint timed out");
  });

  it("on a sent payment whose cache write then fails: journals the tx (with tier) before throwing", async () => {
    // Regression guard: an earlier version only logged-before-throw for an
    // intelligence-check failure, not for rememberJob itself —
    // the more important case, since that's the write that actually
    // prevents a re-pay next time. Delete the try/catch around
    // rememberJob in decisionCore.ts and this test fails: the
    // rejection changes to a bare "boom" instead of
    // CacheWriteFailedAfterPaymentError, and no event is recorded.
    const boom = new Error("SQLite disk full");
    const memory = makeMemory(null, { rememberError: boom });
    const chain = makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: "0xbeef" });
    const intelligence = makeIntelligence({ output: "safe", raw: {}, sourceEndpoint: "/api/evaluate" });

    await expect(
      handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
        memory,
        chain,
        intelligence,
        payTo: VENDOR,
        priceUsdc6dp: PRICE,
        staleWindowMs: STALE_WINDOW_MS,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(CacheWriteFailedAfterPaymentError);

    expect(memory.remembered).toEqual([]);
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0]).toMatchObject({
      body: { cache_hit: false, paid: true, tx_hash: "0xbeef", output: "safe" },
    });
    expect((memory.events[0]?.body["cache_write_error"] as string)).toContain("SQLite disk full");
  });

  it("every branch records exactly one journal event, tagged to the queried contract", async () => {
    const memory = makeMemory(null);
    const chain = makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "max-per-payment" });
    const intelligence = makeIntelligence(new Error("should never be called"));

    await handleJobQuery(HIRED_AGENT_ID, CONTRACT, {
      memory,
      chain,
      intelligence,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      now: () => NOW,
    });

    expect(memory.events).toHaveLength(1);
    expect(memory.events[0]?.ref).toEqual({ category: HIRED_AGENT_ID, name: CONTRACT });
  });
});

/** Stateful fake: returns each entry of `sequence` in order on successive
 * calls (clamped to the last entry once exhausted), simulating a request
 * that stays still_pending for a few polls before resolving. No existing
 * fake in this file needed this — every other port fake resolves the same
 * way on every call. */
function makeResumableChain(
  sequence: PendingResolution[],
): ResumableChainPort & { calls: { requestId: bigint; fromBlock: bigint }[] } {
  const calls: { requestId: bigint; fromBlock: bigint }[] = [];
  let i = 0;
  return {
    calls,
    async requestPayment() {
      throw new Error("resumeAfterApproval must never call requestPayment again");
    },
    async checkPendingResolution(requestId, fromBlock) {
      calls.push({ requestId, fromBlock });
      const entry = sequence[Math.min(i, sequence.length - 1)];
      i++;
      if (!entry) throw new Error("makeResumableChain: empty sequence");
      return entry;
    },
  };
}

describe("resumeAfterApproval", () => {
  it("returns still_pending and never touches intelligence or memory while unresolved", async () => {
    const memory = makeMemory(null);
    const chain = makeResumableChain([{ kind: "still_pending" }]);
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await resumeAfterApproval(HIRED_AGENT_ID, CONTRACT, 7n, 10n, { memory, intelligence, chain, now: () => NOW });

    expect(result).toEqual({ outcome: "still_pending" });
    expect(intelligence.calls).toEqual([]);
    expect(memory.remembered).toEqual([]);
    expect(chain.calls).toEqual([{ requestId: 7n, fromBlock: 10n }]);
    expect(memory.pendingEscalationsCleared).toEqual([]);
  });

  it("on rejected: returns rejected, journals it, never calls intelligence, clears the pending-escalation record", async () => {
    const memory = makeMemory(null);
    const chain = makeResumableChain([{ kind: "rejected", txHash: "0xrej" }]);
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await resumeAfterApproval(HIRED_AGENT_ID, CONTRACT, 9n, 10n, { memory, intelligence, chain, now: () => NOW });

    expect(result).toEqual({ outcome: "rejected" });
    expect(intelligence.calls).toEqual([]);
    expect(memory.events).toHaveLength(1);
    expect(memory.events[0]).toMatchObject({
      body: { cache_hit: false, paid: false, pending_request_id: "9", rejected: true, tx_hash: "0xrej" },
    });
    expect(memory.pendingEscalationsCleared).toEqual([CONTRACT]);
  });

  it("on approved: finishes exactly like a first-touch payment — checks intelligence and caches the tier", async () => {
    const memory = makeMemory(null);
    const chain = makeResumableChain([
      { kind: "approved", txHash: "0xapproved", amount: 300_000n, payTo: VENDOR },
    ]);
    const intelligence = makeIntelligence({ output: "high_conviction", raw: {}, sourceEndpoint: "/api/evaluate" });

    const result = await resumeAfterApproval(HIRED_AGENT_ID, CONTRACT, 11n, 10n, { memory, intelligence, chain, now: () => NOW });

    expect(result).toEqual({ outcome: "paid", output: "high_conviction", txHash: "0xapproved" });
    expect(intelligence.receivedTxHash).toBe("0xapproved");
    expect(memory.remembered).toEqual([
      {
        hiredAgentId: HIRED_AGENT_ID,
        input: CONTRACT,
        record: {
          hiredAgentId: HIRED_AGENT_ID,
          output: "high_conviction",
          raw_response: {},
          checked_at: NOW.toISOString(),
          source_endpoint: "/api/evaluate",
        },
      },
    ]);
    expect(memory.pendingEscalationsCleared).toEqual([CONTRACT]);
  });

  it("never re-requests payment, even when it would resolve to approved — checkPendingResolution is the only call made", async () => {
    const memory = makeMemory(null);
    const chain = makeResumableChain([{ kind: "still_pending" }, { kind: "still_pending" }]);
    const intelligence = makeIntelligence(new Error("should never be called"));

    await resumeAfterApproval(HIRED_AGENT_ID, CONTRACT, 7n, 10n, { memory, intelligence, chain, now: () => NOW });
    await resumeAfterApproval(HIRED_AGENT_ID, CONTRACT, 7n, 10n, { memory, intelligence, chain, now: () => NOW });

    expect(chain.calls).toHaveLength(2);
  });
});

describe("handleGatewayQuery", () => {
  const TX_HASH: `0x${string}` = "0xpaid";
  const PAYER: `0x${string}` = "0x0000000000000000000000000000000000c411";
  const FEE = 500_000n;

  it("on an already-consumed payment: returns payment_already_used and never touches verification, chain, or intelligence", async () => {
    const memory = makeMemory(null, { consumedTxHashes: [TX_HASH] });
    const incomingPayment = makeIncomingPayment({ kind: "valid", payer: PAYER, amount: FEE });
    const chain = makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "should never be called" });
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await handleGatewayQuery(HIRED_AGENT_ID, CONTRACT, TX_HASH, {
      memory,
      chain,
      intelligence,
      incomingPayment,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      gatewayFeeUsdc6dp: FEE,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "payment_already_used" });
    expect(incomingPayment.calls).toEqual([]);
    expect(chain.calls).toEqual([]);
    expect(intelligence.calls).toEqual([]);
  });

  it("on a not-found payment: returns payment_not_found and never marks it consumed", async () => {
    const memory = makeMemory(null);
    const incomingPayment = makeIncomingPayment({ kind: "not_found" });
    const chain = makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "should never be called" });
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await handleGatewayQuery(HIRED_AGENT_ID, CONTRACT, TX_HASH, {
      memory,
      chain,
      intelligence,
      incomingPayment,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      gatewayFeeUsdc6dp: FEE,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "payment_not_found" });
    expect(memory.consumedPayments).toEqual([]);
    expect(chain.calls).toEqual([]);
  });

  it("on a payment sent to the wrong recipient: returns payment_wrong_recipient, never marks consumed", async () => {
    const memory = makeMemory(null);
    const incomingPayment = makeIncomingPayment({ kind: "wrong_recipient" });

    const result = await handleGatewayQuery(HIRED_AGENT_ID, CONTRACT, TX_HASH, {
      memory,
      chain: makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "n/a" }),
      intelligence: makeIntelligence(new Error("should never be called")),
      incomingPayment,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      gatewayFeeUsdc6dp: FEE,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "payment_wrong_recipient" });
    expect(memory.consumedPayments).toEqual([]);
  });

  it("on an insufficient payment: returns payment_insufficient with the observed and required amounts, never marks consumed", async () => {
    const memory = makeMemory(null);
    const incomingPayment = makeIncomingPayment({ kind: "insufficient", amount: 100_000n });

    const result = await handleGatewayQuery(HIRED_AGENT_ID, CONTRACT, TX_HASH, {
      memory,
      chain: makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "n/a" }),
      intelligence: makeIntelligence(new Error("should never be called")),
      incomingPayment,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      gatewayFeeUsdc6dp: FEE,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "payment_insufficient", amount: 100_000n, required: FEE });
    expect(memory.consumedPayments).toEqual([]);
  });

  it("on a valid payment with a cache hit: marks the payment consumed before delegating, and returns the cached tier without touching the chain", async () => {
    const cached: JobRecord = {
      hiredAgentId: HIRED_AGENT_ID,
      output: "safe",
      raw_response: {},
      checked_at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
      source_endpoint: "/api/evaluate",
    };
    const memory = makeMemory(cached);
    const incomingPayment = makeIncomingPayment({ kind: "valid", payer: PAYER, amount: FEE });
    const chain = makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "should never be called" });
    const intelligence = makeIntelligence(new Error("should never be called"));

    const result = await handleGatewayQuery(HIRED_AGENT_ID, CONTRACT, TX_HASH, {
      memory,
      chain,
      intelligence,
      incomingPayment,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      gatewayFeeUsdc6dp: FEE,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "cache_hit", output: "safe", checkedAt: cached.checked_at });
    expect(chain.calls).toEqual([]);
    expect(memory.consumedPayments).toEqual([
      { txHash: TX_HASH, body: { hiredAgentId: HIRED_AGENT_ID, input: CONTRACT, payer: PAYER, amount: FEE.toString(), consumed_at: NOW.toISOString() } },
    ]);
    // Consumed before the delegated handleJobQuery ran (recall is its first memory call).
    expect(memory.calls.indexOf("markPaymentConsumed")).toBeLessThan(memory.calls.indexOf("recall"));
  });

  it("on a valid payment with a cache miss: delegates to the same paid flow as handleJobQuery, still gated by SpendGuard", async () => {
    const memory = makeMemory(null);
    const incomingPayment = makeIncomingPayment({ kind: "valid", payer: PAYER, amount: FEE });
    const chain = makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: "0xbeef" });
    const intelligence = makeIntelligence({ output: "high_conviction", raw: {}, sourceEndpoint: "/api/evaluate" });

    const result = await handleGatewayQuery(HIRED_AGENT_ID, CONTRACT, TX_HASH, {
      memory,
      chain,
      intelligence,
      incomingPayment,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      gatewayFeeUsdc6dp: FEE,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "paid", output: "high_conviction", txHash: "0xbeef" });
    expect(chain.calls).toEqual(["requestPayment"]);
    expect(memory.consumedPayments).toHaveLength(1);
    // The verified on-chain payer (not a self-reported identity) flows
    // into the same decision journal handleJobQuery already writes to —
    // the gateway path gets "who asked" for free, from a stronger signal
    // than a Ping sender address would be.
    expect(memory.events.at(-1)?.body).toMatchObject({ requester: PAYER });
  });

  it("on a valid payment whose downstream check escalates: returns pending_approval, payment stays consumed (no refund path)", async () => {
    const memory = makeMemory(null);
    const incomingPayment = makeIncomingPayment({ kind: "valid", payer: PAYER, amount: FEE });
    const chain = makeChain({ kind: "pending", payTo: VENDOR, amount: PRICE, requestId: 9n, txHash: "0xaa", blockNumber: 5n });

    const result = await handleGatewayQuery(HIRED_AGENT_ID, CONTRACT, TX_HASH, {
      memory,
      chain,
      intelligence: makeIntelligence(new Error("should never be called")),
      incomingPayment,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      gatewayFeeUsdc6dp: FEE,
      now: () => NOW,
    });

    expect(result).toEqual({ outcome: "pending_approval", requestId: 9n, fromBlock: 5n });
    expect(memory.consumedPayments).toHaveLength(1);
  });

  it("passes the configured gateway fee, not the underlying Sibyl price, as the minimum to verifyPayment", async () => {
    const memory = makeMemory(null);
    const incomingPayment = makeIncomingPayment({ kind: "insufficient", amount: 1n });

    await handleGatewayQuery(HIRED_AGENT_ID, CONTRACT, TX_HASH, {
      memory,
      chain: makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "n/a" }),
      intelligence: makeIntelligence(new Error("should never be called")),
      incomingPayment,
      payTo: VENDOR,
      priceUsdc6dp: PRICE,
      staleWindowMs: STALE_WINDOW_MS,
      gatewayFeeUsdc6dp: FEE,
      now: () => NOW,
    });

    expect(incomingPayment.calls).toEqual([{ txHash: TX_HASH, minAmount: FEE }]);
  });
});
