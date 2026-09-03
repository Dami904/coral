import type { GatewayPaymentOutcome, HandleOutcome, PingPort, PollReplyOutcome } from "../types.js";
import { defaultFormatReply, extractContractAddress, pollOnce, type GatewayRequest, type PollOnceResult } from "./pollOnce.js";

/** Mirrors decisionCore's ResumeOutcome structurally without importing it —
 * pollLoop stays dependent only on types.ts, same as the rest of this file. */
export type ResumePendingOutcome = HandleOutcome | { outcome: "still_pending" } | { outcome: "rejected" };

export type PollLoopConfig = {
  ping: PingPort;
  pollIntervalMs: number;
  startBlock: bigint;
  handle: (contract: string, requester: `0x${string}`) => Promise<HandleOutcome>;
  /**
   * Checks whether a previously-escalated payment has since been approved
   * or rejected on-chain and, if approved, finishes the intelligence-check
   * + cache-write tail (decisionCore's resumeAfterApproval, bound to a
   * ResumableChainPort). Omit to skip pending-request tracking entirely —
   * escalated payments will still show up via `handle`'s pending_approval
   * outcome, they just won't auto-resume once approved. `requester` is the
   * same address the original pending_approval reply is queued to
   * (tracked.replyTo below) — the original asker, forwarded for the
   * journal, same as `handle`'s.
   */
  resumePending?: (
    contract: string,
    requestId: bigint,
    fromBlock: bigint,
    requester: `0x${string}`,
  ) => Promise<ResumePendingOutcome>;
  extractContract?: (content: string) => string | null;
  formatReply?: (outcome: PollReplyOutcome) => string;
  onCycle?: (result: PollOnceResult) => void;
  /** Direction B (gateway) wiring — see PollOnceDeps. Both omitted keeps
   * the existing free-only behavior. */
  extractGatewayRequest?: (content: string) => GatewayRequest | null;
  handleGateway?: (contract: string, txHash: `0x${string}`) => Promise<HandleOutcome | GatewayPaymentOutcome>;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

type TrackedPending = { contract: string; replyTo: `0x${string}`; fromBlock: bigint };

/**
 * The recurring "Ping listener" from PLAN.md's architecture diagram: poll,
 * act, advance the cursor, sleep, repeat until aborted. The cursor lives
 * only for the process lifetime — no cross-restart persistence yet (see
 * docs/LIMITATIONS.md). Pending-escalation tracking (below) has the same
 * in-memory-only limitation, by the same deliberate choice not to widen
 * MemoryPort for poll-loop cursor state.
 */
export async function runPollLoop(config: PollLoopConfig, signal: AbortSignal): Promise<void> {
  let lastProcessedBlock = config.startBlock;
  const extractContract = config.extractContract ?? extractContractAddress;
  const formatReply = config.formatReply ?? defaultFormatReply;
  const pendingRequests = new Map<string, TrackedPending>();

  while (!signal.aborted) {
    const result = await pollOnce({
      ping: config.ping,
      lastProcessedBlock,
      extractContract,
      formatReply,
      handle: config.handle,
      ...(config.extractGatewayRequest ? { extractGatewayRequest: config.extractGatewayRequest } : {}),
      ...(config.handleGateway ? { handleGateway: config.handleGateway } : {}),
    });
    lastProcessedBlock = result.newLastProcessedBlock;

    for (const p of result.newlyPending) {
      pendingRequests.set(p.requestId.toString(), { contract: p.contract, replyTo: p.replyTo, fromBlock: p.fromBlock });
    }

    if (config.resumePending) {
      for (const [key, tracked] of pendingRequests) {
        const requestId = BigInt(key);
        try {
          const outcome = await config.resumePending(tracked.contract, requestId, tracked.fromBlock, tracked.replyTo);

          if (outcome.outcome === "still_pending") continue; // no reply — don't spam every cycle

          if (outcome.outcome === "rejected") {
            await config.ping.sendReply(tracked.replyTo, formatReply({ outcome: "resumed_rejected", requestId }));
            pendingRequests.delete(key);
            continue;
          }

          const replyOutcome: PollReplyOutcome =
            outcome.outcome === "paid" ? { outcome: "resumed", output: outcome.output, txHash: outcome.txHash } : outcome;
          await config.ping.sendReply(tracked.replyTo, formatReply(replyOutcome));
          pendingRequests.delete(key);
        } catch (err) {
          // Mirrors pollOnce's per-message isolation: one bad resume never
          // stops tracking the others, and stays in the map to retry next
          // cycle rather than silently dropping a real pending payment.
          console.error("resumePending failed; will retry on the next poll cycle", {
            requestId: key,
            contract: tracked.contract,
            err,
          });
        }
      }
    }

    config.onCycle?.(result);
    if (signal.aborted) break;
    await sleep(config.pollIntervalMs, signal);
  }
}
