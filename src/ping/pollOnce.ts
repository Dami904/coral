import type { GatewayPaymentOutcome, HandleOutcome, PingPort, PollReplyOutcome } from "../types.js";

export type GatewayRequest = { contract: string; txHash: `0x${string}` };

export type PollOnceDeps = {
  ping: PingPort;
  lastProcessedBlock: bigint;
  extractContract: (content: string) => string | null;
  formatReply: (outcome: PollReplyOutcome) => string;
  handle: (contract: string) => Promise<HandleOutcome>;
  /**
   * Direction B (gateway): present only on a deployment that accepts paid
   * inbound requests. Checked before the free `handle` path on every
   * message — a message carrying both a contract address and a payment tx
   * hash is always treated as a gateway request, never silently downgraded
   * to the free one. Omit both to keep the existing free-only behavior
   * (the default; every existing caller of pollOnce is unaffected).
   */
  extractGatewayRequest?: (content: string) => GatewayRequest | null;
  handleGateway?: (contract: string, txHash: `0x${string}`) => Promise<HandleOutcome | GatewayPaymentOutcome>;
};

/** An escalated payment proposed this cycle — tracked cross-cycle by
 * runPollLoop the same way lastProcessedBlock is, so a later cycle can
 * detect it was approved/rejected and resume/notify. */
export type NewlyPendingRequest = {
  requestId: bigint;
  contract: string;
  replyTo: `0x${string}`;
  fromBlock: bigint;
};

export type PollOnceResult = {
  processed: number;
  newLastProcessedBlock: bigint;
  newlyPending: NewlyPendingRequest[];
};

/**
 * One poll cycle: fetch everything since lastProcessedBlock, reply to
 * whatever's actionable, advance the cursor past everything we saw
 * (including broadcasts and already-replied messages, so we never
 * re-scan them). Never lets one message's failure stop the others —
 * each is caught and replied to independently.
 */
export async function pollOnce(deps: PollOnceDeps): Promise<PollOnceResult> {
  const inbox = await deps.ping.getInboxWithStatus(deps.lastProcessedBlock);

  let newLastProcessedBlock = deps.lastProcessedBlock;
  let processed = 0;
  const newlyPending: NewlyPendingRequest[] = [];

  for (const msg of inbox) {
    if (msg.block > newLastProcessedBlock) newLastProcessedBlock = msg.block;
    if (msg.isBroadcast) continue;
    if (msg.replied) continue;

    const gatewayRequest = deps.extractGatewayRequest?.(msg.content) ?? null;
    if (gatewayRequest && deps.handleGateway) {
      try {
        const outcome = await deps.handleGateway(gatewayRequest.contract, gatewayRequest.txHash);
        await deps.ping.sendReply(msg.from, deps.formatReply(outcome));
        if (outcome.outcome === "pending_approval") {
          newlyPending.push({
            requestId: outcome.requestId,
            contract: gatewayRequest.contract,
            replyTo: msg.from,
            fromBlock: outcome.fromBlock,
          });
        }
      } catch (err) {
        console.error("handleGateway() failed for an inbound message; replying with an error, not silently dropping it", {
          from: msg.from,
          contract: gatewayRequest.contract,
          transactionHash: msg.transactionHash,
          err,
        });
        await deps.ping.sendReply(msg.from, deps.formatReply({ outcome: "error", message: String(err) }));
      }
      processed++;
      continue;
    }

    const contract = deps.extractContract(msg.content);
    if (!contract) {
      await deps.ping.sendReply(msg.from, deps.formatReply({ outcome: "no_contract_found" }));
      processed++;
      continue;
    }

    try {
      const outcome = await deps.handle(contract);
      await deps.ping.sendReply(msg.from, deps.formatReply(outcome));
      if (outcome.outcome === "pending_approval") {
        newlyPending.push({
          requestId: outcome.requestId,
          contract,
          replyTo: msg.from,
          fromBlock: outcome.fromBlock,
        });
      }
    } catch (err) {
      // Log server-side before replying: the Ping reply only ever gets a
      // short user-facing message, and without this the only record of a
      // real failure (a reverted call, a thrown decisionCore error) would
      // be that terse string on-chain — not enough to debug from later.
      console.error("handle() failed for an inbound message; replying with an error, not silently dropping it", {
        from: msg.from,
        contract,
        transactionHash: msg.transactionHash,
        err,
      });
      await deps.ping.sendReply(msg.from, deps.formatReply({ outcome: "error", message: String(err) }));
    }
    processed++;
  }

  return { processed, newLastProcessedBlock, newlyPending };
}

export function extractContractAddress(content: string): string | null {
  const match = /0x[a-fA-F0-9]{40}/i.exec(content);
  return match ? match[0].toLowerCase() : null;
}

/**
 * A gateway (Direction B) request is any message carrying both a 20-byte
 * contract address (40 hex chars) and a 32-byte tx hash (64 hex chars) —
 * the two are unambiguous by length alone, so no keyword/prefix convention
 * is needed. A message with only an address is never treated as a gateway
 * request, even on a gateway-enabled deployment — it keeps using the free
 * path (see PollOnceDeps).
 */
export function extractGatewayRequest(content: string): GatewayRequest | null {
  const addressMatch = /0x[a-fA-F0-9]{40}\b/i.exec(content);
  const hashMatch = /0x[a-fA-F0-9]{64}\b/i.exec(content);
  if (!addressMatch || !hashMatch) return null;
  return { contract: addressMatch[0].toLowerCase(), txHash: hashMatch[0].toLowerCase() as `0x${string}` };
}

export function defaultFormatReply(outcome: PollReplyOutcome): string {
  switch (outcome.outcome) {
    case "cache_hit":
      return `Conviction tier: ${outcome.tier} (cached, checked ${outcome.checkedAt}). Not a safety/scam verdict.`;
    case "paid":
      return `Conviction tier: ${outcome.tier} (fresh check, tx ${outcome.txHash}). Not a safety/scam verdict.`;
    case "pending_approval":
      return `That check needs human sign-off first (request #${outcome.requestId.toString()}) — no funds moved yet.`;
    case "resumed":
      return `Conviction tier: ${outcome.tier} (approved and completed, tx ${outcome.txHash}). Not a safety/scam verdict.`;
    case "resumed_rejected":
      return `The check for that request (#${outcome.requestId.toString()}) was rejected by the owner — no funds moved.`;
    case "blocked":
      return `Can't check that right now: blocked by policy (${outcome.reason}).`;
    case "no_contract_found":
      return "I couldn't find a token contract address in your message — send me a 0x... address to check.";
    case "error":
      return `Something went wrong checking that: ${outcome.message}`;
    case "payment_not_found":
      return "I couldn't find that payment transaction on-chain yet — if you just sent it, wait for it to confirm and resend the same message.";
    case "payment_wrong_recipient":
      return "That transaction didn't send USDC to my gateway address — check the recipient and try again.";
    case "payment_insufficient":
      return `That payment (${outcome.amount.toString()}) was below the required gateway fee (${outcome.required.toString()}) — send the full amount and try again.`;
    case "payment_already_used":
      return "That payment has already been redeemed for a check — send a new payment for another query.";
  }
}
