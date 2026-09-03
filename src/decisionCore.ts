import {
  CacheWriteFailedAfterPaymentError,
  IntelligenceCheckFailedAfterPaymentError,
  type ChainPort,
  type GatewayPaymentOutcome,
  type HandleOutcome,
  type IncomingPaymentPort,
  type IntelligencePort,
  type MemoryPort,
  type PendingResolution,
  type ResumableChainPort,
} from "./types.js";

/**
 * Best-effort journal write for use inside an already-failing path: never
 * lets a broken logger mask the original error. Falls back to stderr so
 * the failure is still visible somewhere.
 */
async function recordEventBestEffort(
  memory: MemoryPort,
  kind: string,
  body: Record<string, unknown>,
  ref: { category: string; name: string },
): Promise<void> {
  try {
    await memory.recordEvent(kind, body, ref);
  } catch (err) {
    console.error("recordEvent failed while reconciling a prior failure; logging to stderr instead", {
      kind,
      body,
      ref,
      err,
    });
  }
}

export type HandleTokenQueryDeps = {
  memory: MemoryPort;
  chain: ChainPort;
  intelligence: IntelligencePort;
  payTo: `0x${string}`;
  priceUsdc6dp: bigint;
  staleWindowMs: number;
  /** Injected for deterministic tests; defaults to the real clock. */
  now?: () => Date;
};

type FinishAfterPaymentDeps = {
  memory: MemoryPort;
  intelligence: IntelligencePort;
  now?: () => Date;
};

const CATEGORY = "token_verdict";

/**
 * Shared tail for both a first-touch payment (handleTokenQuery's "sent"
 * branch) and a resumed escalated payment (resumeAfterApproval, once
 * approved): run the intelligence check, cache the tier, journal the
 * outcome. Kept in one place so the two hardened failure paths below stay
 * single-sourced instead of duplicated between the two callers.
 */
async function finishAfterPayment(
  contract: string,
  txHash: `0x${string}`,
  deps: FinishAfterPaymentDeps,
  ref: { category: string; name: string },
  requester?: string,
): Promise<HandleOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const requesterField = requester ? { requester } : {};

  // Journal the payment fact BEFORE the intelligence call, so a failure
  // below still leaves a reconciliable record instead of a silent
  // paid-but-uncached gap (docs/API_NOTES.md).
  let intel: Awaited<ReturnType<IntelligencePort["checkToken"]>>;
  try {
    intel = await deps.intelligence.checkToken(contract, txHash);
  } catch (err) {
    await recordEventBestEffort(
      deps.memory,
      "decision",
      { cache_hit: false, paid: true, tx_hash: txHash, intel_error: String(err), ...requesterField },
      ref,
    );
    throw new IntelligenceCheckFailedAfterPaymentError(contract, txHash, err);
  }

  try {
    await deps.memory.rememberTokenVerdict(contract, {
      tier: intel.tier,
      raw_response: intel.raw,
      checked_at: now.toISOString(),
      source_endpoint: intel.sourceEndpoint,
    });
  } catch (err) {
    await recordEventBestEffort(
      deps.memory,
      "decision",
      { cache_hit: false, paid: true, tx_hash: txHash, tier: intel.tier, cache_write_error: String(err), ...requesterField },
      ref,
    );
    throw new CacheWriteFailedAfterPaymentError(contract, txHash, err);
  }

  await deps.memory.recordEvent(
    "decision",
    { cache_hit: false, paid: true, tx_hash: txHash, tier: intel.tier, ...requesterField },
    ref,
  );
  return { outcome: "paid", tier: intel.tier, txHash };
}

/**
 * The critical path: PLAN.md's `handle()`. Every branch journals exactly
 * one event, and memory is always consulted before any chain call — the
 * cold-start-recall / deletion-test gate this whole project is judged on
 * depends on that ordering being real, not just documented.
 *
 * `requester` is optional and purely descriptive — never used for any
 * decision (cache/policy/payment logic is identical regardless of who's
 * asking). Ping's poll loop passes the sender's address; the free HTTP
 * path has no caller identity to offer and omits it. See
 * MemoryPort.recordEvent's journal — this is the "who asked" field
 * PLAN.md's original data-model sketch proposed but the code never grew
 * until now.
 */
export async function handleTokenQuery(
  contract: string,
  deps: HandleTokenQueryDeps,
  requester?: string,
): Promise<HandleOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const ref = { category: CATEGORY, name: contract };
  const requesterField = requester ? { requester } : {};

  const cached = await deps.memory.recallTokenVerdict(contract);
  if (cached && now.getTime() - Date.parse(cached.checked_at) < deps.staleWindowMs) {
    await deps.memory.recordEvent("decision", { cache_hit: true, paid: false, ...requesterField }, ref);
    return { outcome: "cache_hit", tier: cached.tier, checkedAt: cached.checked_at };
  }

  // An earlier call for this contract may already have escalated and be
  // awaiting ownerApprove/ownerReject — SpendGuard's own rate/budget rules
  // don't count a pending request until it's approved, so without this
  // check a repeat query (Ping or the free HTTP path) would create a new
  // on-chain proposal every time instead of pointing back at the one
  // already in flight. See MemoryPort.getPendingEscalation.
  const existingPending = await deps.memory.getPendingEscalation(contract);
  if (existingPending) {
    await deps.memory.recordEvent(
      "decision",
      {
        cache_hit: false,
        paid: false,
        pending_request_id: existingPending.requestId.toString(),
        already_pending: true,
        ...requesterField,
      },
      ref,
    );
    return { outcome: "pending_approval", requestId: existingPending.requestId, fromBlock: existingPending.fromBlock };
  }

  const payment = await deps.chain.requestPayment(deps.payTo, deps.priceUsdc6dp);

  if (payment.kind === "blocked") {
    await deps.memory.recordEvent(
      "decision",
      { cache_hit: false, paid: false, blocked_reason: payment.reason, ...requesterField },
      ref,
    );
    return { outcome: "blocked", reason: payment.reason };
  }

  if (payment.kind === "pending") {
    await deps.memory.setPendingEscalation(contract, payment.requestId, payment.blockNumber);
    await deps.memory.recordEvent(
      "decision",
      { cache_hit: false, paid: false, pending_request_id: payment.requestId.toString(), ...requesterField },
      ref,
    );
    return { outcome: "pending_approval", requestId: payment.requestId, fromBlock: payment.blockNumber };
  }

  // payment.kind === "sent": funds moved.
  return finishAfterPayment(contract, payment.txHash, deps, ref, requester);
}

export type HandleGatewayQueryDeps = HandleTokenQueryDeps & {
  incomingPayment: IncomingPaymentPort;
  /** Required USDC (6dp) a caller must have sent to the gateway (the
   * deployed SpendGuard contract's own address) to redeem one check. */
  gatewayFeeUsdc6dp: bigint;
};

/**
 * Direction B: another agent pays *Coral* (not the other way around) for
 * the same conviction-tier lookup handleTokenQuery already does for
 * Coral's own use. Verifies + consumes the caller's claimed payment first
 * (replay-protected via MemoryPort — see PLAN.md's "Gateway direction"
 * entry), then delegates to the exact same handleTokenQuery path: a cache
 * hit is pure margin on the gateway fee, a miss has Coral pay Sibyl out
 * of the same SpendGuard treasury the fee just funded.
 */
export async function handleGatewayQuery(
  contract: string,
  paymentTxHash: `0x${string}`,
  deps: HandleGatewayQueryDeps,
): Promise<HandleOutcome | GatewayPaymentOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  const alreadyConsumed = await deps.memory.wasPaymentConsumed(paymentTxHash);
  if (alreadyConsumed) {
    return { outcome: "payment_already_used" };
  }

  const verification = await deps.incomingPayment.verifyPayment(paymentTxHash, deps.gatewayFeeUsdc6dp);
  if (verification.kind === "not_found") {
    return { outcome: "payment_not_found" };
  }
  if (verification.kind === "wrong_recipient") {
    return { outcome: "payment_wrong_recipient" };
  }
  if (verification.kind === "insufficient") {
    return { outcome: "payment_insufficient", amount: verification.amount, required: deps.gatewayFeeUsdc6dp };
  }

  // Mark consumed BEFORE doing any of the paid work below, closing the
  // replay window immediately — see PLAN.md for the accepted tradeoff
  // (a downstream failure burns this payment; a retry needs a fresh one).
  await deps.memory.markPaymentConsumed(paymentTxHash, {
    contract,
    payer: verification.payer,
    amount: verification.amount.toString(),
    consumed_at: now.toISOString(),
  });

  // The verified on-chain payer, not a self-reported identity — a
  // stronger "who asked" signal than a Ping sender address would be,
  // since it's the address that actually moved the funds.
  return handleTokenQuery(contract, deps, verification.payer);
}

export type ResumeAfterApprovalDeps = {
  memory: MemoryPort;
  intelligence: IntelligencePort;
  chain: ResumableChainPort;
  now?: () => Date;
};

export type ResumeOutcome = HandleOutcome | { outcome: "still_pending" } | { outcome: "rejected" };

/**
 * Called by the poll loop's pending-request tracking (src/ping/pollLoop.ts)
 * once a previously-escalated payment might have been approved/rejected
 * on-chain since it was proposed. Never calls chain.requestPayment again —
 * the payment either already happened (approved) or never will (rejected);
 * this only ever finishes the same intelligence-check + cache-write tail a
 * normal "sent" payment goes through, via finishAfterPayment.
 */
export async function resumeAfterApproval(
  contract: string,
  requestId: bigint,
  fromBlock: bigint,
  deps: ResumeAfterApprovalDeps,
  requester?: string,
): Promise<ResumeOutcome> {
  const ref = { category: CATEGORY, name: contract };
  const requesterField = requester ? { requester } : {};
  const resolution: PendingResolution = await deps.chain.checkPendingResolution(requestId, fromBlock);

  if (resolution.kind === "still_pending") {
    return { outcome: "still_pending" };
  }

  if (resolution.kind === "rejected") {
    await deps.memory.clearPendingEscalation(contract).catch((err: unknown) => {
      console.error("resumeAfterApproval: clearPendingEscalation failed after a rejection — logging, not throwing", { contract, err });
    });
    await recordEventBestEffort(
      deps.memory,
      "decision",
      { cache_hit: false, paid: false, pending_request_id: requestId.toString(), rejected: true, tx_hash: resolution.txHash, ...requesterField },
      ref,
    );
    return { outcome: "rejected" };
  }

  await deps.memory.clearPendingEscalation(contract).catch((err: unknown) => {
    console.error("resumeAfterApproval: clearPendingEscalation failed after approval — logging, not throwing", { contract, err });
  });
  return finishAfterPayment(contract, resolution.txHash, deps, ref, requester);
}
