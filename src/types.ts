/**
 * Opaque label identifying which hired agent a job's output came from —
 * e.g. "sibyl-conviction-check". The core never interprets this string; it
 * only uses it to partition the cache (so two different hired agents'
 * answers for what looks like "the same" input never collide) and to know
 * which IntelligencePort instance a given deployment/offering is talking
 * to. See docs/API_NOTES.md's generalization note.
 */
export type HiredAgentId = string;

/**
 * Generalizes what used to be TokenVerdictRecord: caches the (input,
 * output) pair from a job hired from ANY agent, not just Sibyl's
 * token-conviction check — the only real integration wired up today, but
 * no longer the only one the core can support. `output` was `tier`
 * before this generalization: same value, generic name, since not every
 * hired agent's result is a "conviction tier." See docs/API_NOTES.md and
 * docs/LIMITATIONS.md.
 */
export type JobRecord = {
  hiredAgentId: HiredAgentId;
  output: string;
  raw_response: unknown;
  checked_at: string;
  source_endpoint: string;
};

export type PaymentOutcome =
  | { kind: "sent"; payTo: `0x${string}`; amount: bigint; txHash: `0x${string}` }
  | {
      kind: "pending";
      payTo: `0x${string}`;
      amount: bigint;
      requestId: bigint;
      txHash: `0x${string}`;
      /** Block the PaymentPending event was mined in — the starting point
       * for later scanning for PaymentApproved/PaymentRejected, since a
       * resume never re-reads current contract state (see ResumableChainPort). */
      blockNumber: bigint;
    }
  | { kind: "blocked"; payTo: `0x${string}`; amount: bigint; reason: string };

/**
 * The decision core never talks to Sibyl Memory or the chain directly — it
 * only sees these three ports. Real adapters live in src/memory, src/chain,
 * src/intelligence; tests use fakes. This is what makes the non-negotiable
 * "memory checked before payment" invariant something a unit test can prove
 * instead of just something the code review has to notice.
 */
export interface MemoryPort {
  recallJob(hiredAgentId: HiredAgentId, input: string): Promise<JobRecord | null>;
  rememberJob(hiredAgentId: HiredAgentId, input: string, record: JobRecord): Promise<void>;
  recordEvent(
    kind: string,
    body: Record<string, unknown>,
    ref: { category: string; name: string },
  ): Promise<void>;
  /**
   * Replay-protection ledger for gateway (Direction B) payments: has this
   * inbound payment tx already funded an earlier check? Keyed by tx hash
   * so the same payment can never be redeemed twice. Deleting Sibyl
   * Memory erases this ledger along with everything else — deliberately,
   * so the double-spend guarantee depends on memory the same way the
   * cache does. See PLAN.md's "Gateway direction" entry.
   */
  wasPaymentConsumed(txHash: `0x${string}`): Promise<boolean>;
  /** Marks a payment tx consumed. Called before the paid work it funds
   * runs, not after — see PLAN.md for why (closes a race, at the cost of
   * a downstream failure burning the payment with no refund path). */
  markPaymentConsumed(txHash: `0x${string}`, body: Record<string, unknown>): Promise<void>;
  /**
   * Escalation-request de-dup: does this contract already have an
   * unresolved pending escalation in flight? Checked in decisionCore
   * before ever calling chain.requestPayment, so a repeat query (over
   * Ping or the free HTTP path) for a contract whose price crossed
   * humanApprovalThreshold doesn't create a second on-chain
   * PaymentPending proposal while the first still awaits
   * ownerApprove/ownerReject. This has no on-chain backstop of its own —
   * SpendGuard's rate/budget rules don't count a pending request until
   * it's approved (test/SpendGuard.t.sol:
   * test_RequestPayment_PendingDoesNotConsumeBudgetOrRateUntilApproved) —
   * so memory is the only thing preventing unbounded repeat-escalation
   * spam here. Deleting Sibyl Memory erases this guard along with
   * everything else, same as the other two ledgers above.
   */
  getPendingEscalation(hiredAgentId: HiredAgentId, input: string): Promise<{ requestId: bigint; fromBlock: bigint } | null>;
  /** Records a freshly-proposed escalation. Called right after
   * chain.requestPayment returns "pending", before returning to the
   * caller. */
  setPendingEscalation(hiredAgentId: HiredAgentId, input: string, requestId: bigint, fromBlock: bigint): Promise<void>;
  /** Clears the record once resumeAfterApproval resolves it either way
   * (approved-and-completed, or rejected) — a still-pending resolution
   * leaves it in place. */
  clearPendingEscalation(hiredAgentId: HiredAgentId, input: string): Promise<void>;
}

export interface ChainPort {
  requestPayment(payTo: `0x${string}`, amount: bigint): Promise<PaymentOutcome>;
}

export type PendingResolution =
  | { kind: "still_pending" }
  | { kind: "approved"; txHash: `0x${string}`; amount: bigint; payTo: `0x${string}` }
  | { kind: "rejected"; txHash: `0x${string}` };

/**
 * Additive over ChainPort — decisionCore's existing "sent"/"pending"/
 * "blocked" contract (and every test built against it) is untouched.
 * checkPendingResolution must resolve by scanning PaymentApproved/
 * PaymentRejected event logs from fromBlock onward, never by reading
 * SpendGuard.pending(requestId) — that read has a documented history of
 * returning stale data on Base Sepolia's public multi-node RPC immediately
 * after a write (see docs/API_NOTES.md's Day 8 note). "still_pending" here
 * just means "not visible on-chain yet," which is always safe to report —
 * the next poll cycle tries again — unlike trusting a stale read as a
 * final answer.
 */
export interface ResumableChainPort extends ChainPort {
  checkPendingResolution(requestId: bigint, fromBlock: bigint): Promise<PendingResolution>;
}

/**
 * A hired agent Coral can pay for a job — Sibyl's x402 /api/evaluate
 * endpoint is the one real implementation today (X402IntelligenceClient),
 * but the interface itself no longer assumes Sibyl's specific shape: not
 * every hired agent's input is a contract address or its output a
 * "tier." `paymentTxHash` is the SpendGuard payment's mined tx hash — the
 * real client relays it via the X-PAYMENT-TX header per
 * docs/API_NOTES.md's directTx flow. The payment has already happened by
 * the time this is called; this port only ever proves the payment, never
 * initiates one.
 */
export interface IntelligencePort {
  invoke(
    input: string,
    paymentTxHash: `0x${string}`,
  ): Promise<{ output: string; raw: unknown; sourceEndpoint: string }>;
}

export type HandleOutcome =
  | { outcome: "cache_hit"; output: string; checkedAt: string }
  | { outcome: "paid"; output: string; txHash: `0x${string}` }
  | { outcome: "pending_approval"; requestId: bigint; fromBlock: bigint }
  | { outcome: "blocked"; reason: string };

/**
 * A caller's claimed inbound payment, checked against the real mined
 * receipt for the tx hash they supplied — never trusted on the claim
 * alone, and never inferred from a balance read (a snapshot can't prove
 * *this specific* transfer happened). "valid" reports the actual sender
 * and amount observed on-chain, which may exceed the required minimum.
 */
export type IncomingPaymentVerification =
  | { kind: "valid"; payer: `0x${string}`; amount: bigint }
  | { kind: "insufficient"; amount: bigint }
  | { kind: "wrong_recipient" }
  | { kind: "not_found" };

export interface IncomingPaymentPort {
  /** minAmount is the gateway fee this deployment requires; the payTo
   * address is baked into the adapter (see SpendGuardIncomingPaymentVerifier
   * — it's always the deployed SpendGuard contract's own address). */
  verifyPayment(txHash: `0x${string}`, minAmount: bigint): Promise<IncomingPaymentVerification>;
}

/** Gateway-specific failure outcomes for a rejected/reused payment claim —
 * distinct from HandleOutcome, which only ever runs once payment is
 * verified. handleGatewayQuery's return type is the union of both. */
export type GatewayPaymentOutcome =
  | { outcome: "payment_not_found" }
  | { outcome: "payment_wrong_recipient" }
  | { outcome: "payment_insufficient"; amount: bigint; required: bigint }
  | { outcome: "payment_already_used" };

export type PingMessage = {
  from: `0x${string}`;
  to: `0x${string}` | "broadcast";
  content: string;
  block: bigint;
  transactionHash: `0x${string}`;
  isBroadcast: boolean;
  /**
   * Per docs/API_NOTES.md: true means "we've sent this sender something
   * since this message's block," not "this exact message was answered."
   * null for broadcasts (no single sender to reply to).
   */
  replied: boolean | null;
  replyBlock: number | null;
};

export interface PingPort {
  /** Messages received at or after fromBlock, annotated with reply status. */
  getInboxWithStatus(fromBlock: bigint): Promise<PingMessage[]>;
  sendReply(to: `0x${string}`, content: string): Promise<{ txHash: `0x${string}` }>;
}

/** What the poll loop replies with — decisionCore's HandleOutcome plus the
 * cases that only make sense at the Ping layer (no address found in the
 * message; the decision core itself threw; a previously-escalated request
 * was auto-detected as approved/rejected on a later poll cycle). */
export type PollReplyOutcome =
  | HandleOutcome
  | GatewayPaymentOutcome
  | { outcome: "no_contract_found" }
  | { outcome: "error"; message: string }
  | { outcome: "resumed"; output: string; txHash: `0x${string}` }
  | { outcome: "resumed_rejected"; requestId: bigint };

export class IntelligenceCheckFailedAfterPaymentError extends Error {
  constructor(
    public readonly hiredAgentId: HiredAgentId,
    public readonly input: string,
    public readonly txHash: `0x${string}`,
    cause: unknown,
  ) {
    super(
      `payment to ${hiredAgentId} for ${input} succeeded (tx ${txHash}) but the intelligence check failed ` +
        `afterward; no cache entry was written — see docs/API_NOTES.md's "dangerous ordering" note`,
      { cause },
    );
    this.name = "IntelligenceCheckFailedAfterPaymentError";
  }
}

export class CacheWriteFailedAfterPaymentError extends Error {
  constructor(
    public readonly hiredAgentId: HiredAgentId,
    public readonly input: string,
    public readonly txHash: `0x${string}`,
    cause: unknown,
  ) {
    super(
      `payment to ${hiredAgentId} for ${input} succeeded (tx ${txHash}) and the intelligence check succeeded, ` +
        `but writing the result to memory failed afterward; the next lookup for this input will pay again ` +
        `unless a human reconciles it — see docs/API_NOTES.md's "dangerous ordering" note`,
      { cause },
    );
    this.name = "CacheWriteFailedAfterPaymentError";
  }
}

/**
 * A retry landed a 409 ("hash already used") on something other than the
 * first attempt — the original request almost certainly succeeded
 * server-side but its response was lost before this process saw it. The
 * payment is real and spent; there is no verdict payload left to recover
 * from this call. Distinct from the plain 409 thrown by X402IntelligenceClient
 * on a genuine first-attempt reuse, which is a real client error, not this.
 */
export class IntelligenceResultUnrecoverableError extends Error {
  constructor(
    public readonly hiredAgentId: HiredAgentId,
    public readonly input: string,
    public readonly paymentTxHash: `0x${string}`,
  ) {
    super(
      `payment to ${hiredAgentId} for ${input} (tx ${paymentTxHash}) appears to have already been relayed to ` +
        `the intelligence endpoint on an earlier attempt, but this process never saw a response — the ` +
        `payment cannot be recovered by retrying with the same hash again`,
    );
    this.name = "IntelligenceResultUnrecoverableError";
  }
}

/**
 * A chain write's outcome could not be confirmed after exhausting retry
 * polling on the transaction's own hash — never resend with a fresh nonce
 * from here (risk of a genuine double-send if the original lands late).
 * Resuming requires a human checking the hash on Basescan.
 */
export class TransactionStatusUnknownError extends Error {
  constructor(
    public readonly txHash: `0x${string}`,
    cause: unknown,
  ) {
    super(
      `transaction ${txHash} status could not be confirmed after exhausting retries — do not resend; ` +
        `check ${txHash} on Basescan before taking any further action`,
      { cause },
    );
    this.name = "TransactionStatusUnknownError";
  }
}
