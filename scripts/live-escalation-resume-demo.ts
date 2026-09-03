/**
 * Extends live-escalation-demo.ts's proven pattern (receipt-only
 * verification, never a stale readContract) to close the gap that
 * script's own doc comment names: propose -> owner approves -> the
 * approval is auto-detected -> the intelligence check runs -> the tier
 * gets cached -> a follow-up query for the same contract is a cache hit
 * with zero additional payment. Real Base Sepolia SpendGuard
 * payment/approval; the intelligence check itself goes to a local mock
 * x402 server (free, no mainnet spend) — same as live-day5-smoke.ts.
 *
 * Run: pnpm live:escalation-resume-demo
 */
import { loadConfig } from "../src/config.js";
import { handleJobQuery, resumeAfterApproval } from "../src/decisionCore.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import {
  makeChainClient,
  makeMemoryClient,
  makeOwnerClients,
  ownerApproveAndWait,
  resetMemoryDb,
  SIBYL_HIRED_AGENT_ID,
  startMockX402Server,
} from "./lib/liveHarness.js";

const TEST_CONTRACT = "0x000000000000000000000000000000c0ffee04";
// Between the deployed guard's humanApprovalThreshold (150_000) and
// maxPerPayment (500_000) — see PLAN.md's Day 2 entry.
const ESCALATION_AMOUNT_USDC_6DP = 200_000n;

async function main() {
  const config = loadConfig();
  const ownerClients = makeOwnerClients(config);

  const mockServer = await startMockX402Server();
  console.log(`[escalation-resume] local mock x402 server listening at ${mockServer.endpoint}`);

  resetMemoryDb(config, "escalation-resume");

  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const intelligence = new X402IntelligenceClient({ endpointUrl: mockServer.endpoint });

  const deps = {
    memory,
    chain,
    intelligence,
    payTo: config.vendorPayTo,
    priceUsdc6dp: ESCALATION_AMOUNT_USDC_6DP,
    staleWindowMs: 60 * 60 * 1000,
  };

  try {
    console.log(
      `[escalation-resume] call 1: propose ${ESCALATION_AMOUNT_USDC_6DP.toString()} (above threshold) for ${TEST_CONTRACT}`,
    );
    const first = await handleJobQuery(SIBYL_HIRED_AGENT_ID, TEST_CONTRACT, deps);
    console.log("[escalation-resume] result 1:", first);
    if (first.outcome !== "pending_approval") {
      throw new Error(
        `expected "pending_approval", got "${first.outcome}" — is ESCALATION_AMOUNT_USDC_6DP still above the deployed threshold?`,
      );
    }
    console.log("[escalation-resume] no funds moved yet, no intelligence call yet — the agent proposed, it did not execute.");

    console.log(`[escalation-resume] owner approving requestId ${first.requestId.toString()}...`);
    const { txHash: approveTxHash, events: approveEvents } = await ownerApproveAndWait(
      config,
      ownerClients,
      first.requestId,
    );
    if (!approveEvents.some((e) => e.eventName === "PaymentApproved")) {
      throw new Error(`ownerApprove tx ${approveTxHash} did not emit PaymentApproved: ${JSON.stringify(approveEvents)}`);
    }
    console.log(
      `[escalation-resume] owner approved on-chain (tx ${approveTxHash}) — funds moved, but nothing has resumed the check yet.`,
    );

    console.log("[escalation-resume] call 2: auto-detect the approval and resume (intelligence check + cache write)...");
    // Real polling behavior, not a single shot: Base Sepolia's public RPC can
    // lag on indexing getLogs for a block that was JUST mined (the same
    // eventual-consistency gap docs/API_NOTES.md already documents for
    // reads-right-after-a-write) — checkPendingResolution correctly reports
    // "still_pending" rather than asserting a false positive in that case.
    // In the real poll loop this resolves naturally on a later cycle; here
    // we retry a few times with a short wait to mirror that instead of
    // treating the first still_pending as a failure.
    let resumed: Awaited<ReturnType<typeof resumeAfterApproval>> | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      resumed = await resumeAfterApproval(SIBYL_HIRED_AGENT_ID, TEST_CONTRACT, first.requestId, first.fromBlock, {
        memory,
        intelligence,
        chain,
        now: () => new Date(),
      });
      console.log(`[escalation-resume] result 2 (attempt ${attempt.toString()}):`, resumed);
      if (resumed.outcome !== "still_pending") break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!resumed || resumed.outcome !== "paid") {
      throw new Error(`expected "paid" after resuming an approved request, got "${resumed?.outcome}"`);
    }

    console.log("[escalation-resume] call 3: same contract, expect cache hit -> zero payment, zero HTTP call");
    const third = await handleJobQuery(SIBYL_HIRED_AGENT_ID, TEST_CONTRACT, deps);
    console.log("[escalation-resume] result 3:", third);
    if (third.outcome !== "cache_hit") {
      throw new Error(`expected "cache_hit" on the third call, got "${third.outcome}"`);
    }

    console.log(
      "[escalation-resume] PASS: propose -> approve -> auto-detected resolution -> intelligence check -> cache write, proven end-to-end.",
    );
  } finally {
    await memory.close();
    await mockServer.close();
  }
}

main().catch((err: unknown) => {
  console.error("[escalation-resume] FAILED:", err);
  process.exitCode = 1;
});
