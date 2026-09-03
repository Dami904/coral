/**
 * Day 8: the escalation-demo harness. Proves, against the real deployed
 * testnet SpendGuard, that a payment above humanApprovalThreshold cannot
 * execute on the agent's own say-so — only a separate ownerApprove call
 * moves funds. This is the strongest demo beat because it's filmable,
 * on-chain, and proves "the agent is blind to and can't reason around its
 * limits" instead of just asserting it.
 *
 * Does NOT demonstrate the "check completes after approval" step PLAN.md's
 * demo script implies — see scripts/live-escalation-resume-demo.ts for
 * that (built on top of decisionCore's resumeAfterApproval). This harness
 * proves exactly what SpendGuard.sol guarantees: propose, no funds move,
 * owner approves, funds move.
 *
 * Verification relies ONLY on each transaction's mined receipt + decoded
 * event, never a subsequent readContract call — a first attempt at this
 * script did a `pending(requestId)` read right after each write and got
 * stale data back (the public multi-node RPC lagged behind the write it
 * had itself just confirmed — see docs/API_NOTES.md). The receipt's event
 * is the only thing this codebase treats as authoritative, for exactly
 * this reason.
 *
 * Run: pnpm live:escalation-demo
 */
import { loadConfig } from "../src/config.js";
import { makeChainClient, makeOwnerClients, ownerApproveAndWait } from "./lib/liveHarness.js";

// Between the deployed guard's humanApprovalThreshold (150_000) and
// maxPerPayment (500_000) — see PLAN.md's Day 2 entry.
const ESCALATION_AMOUNT_USDC_6DP = 200_000n;

async function main() {
  const config = loadConfig();
  const ownerClients = makeOwnerClients(config);
  const agentChain = makeChainClient(config);

  console.log(`[escalation] agent requests ${ESCALATION_AMOUNT_USDC_6DP.toString()} (above threshold) to ${config.vendorPayTo}`);
  const outcome = await agentChain.requestPayment(config.vendorPayTo, ESCALATION_AMOUNT_USDC_6DP);
  console.log("[escalation] outcome (decoded from the requestPayment tx's own receipt):", outcome);
  if (outcome.kind !== "pending") {
    throw new Error(
      `expected the payment to escalate to pending, got "${outcome.kind}" — is ESCALATION_AMOUNT_USDC_6DP still above the deployed threshold?`,
    );
  }
  console.log(`[escalation] no funds moved yet — this is the point: the agent proposed, it did not execute.`);

  console.log(`[escalation] owner approving requestId ${outcome.requestId.toString()}...`);
  const { txHash: approveTxHash, events } = await ownerApproveAndWait(config, ownerClients, outcome.requestId);
  const approved = events.find((e) => e.eventName === "PaymentApproved");
  const sent = events.find((e) => e.eventName === "PaymentSent");
  if (!approved || !sent) {
    throw new Error(`expected both PaymentApproved and PaymentSent events, got: ${JSON.stringify(events)}`);
  }

  console.log(
    `[escalation] PASS: ownerApprove tx ${approveTxHash} emitted PaymentApproved + PaymentSent ` +
      `(${sent.args.amount.toString()} to ${sent.args.payTo}) — funds moved only after, and only because of, ` +
      "the separate owner action.",
  );
}

main().catch((err: unknown) => {
  console.error("[escalation] FAILED:", err);
  process.exitCode = 1;
});
