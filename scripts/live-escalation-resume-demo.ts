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
import { createServer } from "node:http";
import { unlinkSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import { handleTokenQuery, resumeAfterApproval } from "../src/decisionCore.js";
import { SpendGuardChainClient, SPEND_GUARD_ABI } from "../src/chain/spendGuardClient.js";
import { SibylMemoryClient } from "../src/memory/sibylMemoryClient.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { requestHandler } from "../mock-x402-server/server.mjs";
import { withRetry } from "../src/lib/retry.js";

const TEST_CONTRACT = "0x000000000000000000000000000000c0ffee04";
// Between the deployed guard's humanApprovalThreshold (150_000) and
// maxPerPayment (500_000) — see PLAN.md's Day 2 entry.
const ESCALATION_AMOUNT_USDC_6DP = 200_000n;

async function main() {
  const config = loadConfig();
  if (!config.deployerPrivateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY required (owner key — only it can call ownerApprove)");
  }

  const mockServer = createServer(requestHandler);
  await new Promise<void>((resolve) => mockServer.listen(0, resolve));
  const address = mockServer.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  const mockEndpoint = `http://127.0.0.1:${address.port}/api/evaluate`;
  console.log(`[escalation-resume] local mock x402 server listening at ${mockEndpoint}`);

  if (config.memoryDbPath && existsSync(config.memoryDbPath)) {
    unlinkSync(config.memoryDbPath);
    console.log(`[escalation-resume] deleted pre-existing ${config.memoryDbPath} for a clean run`);
  }

  const chain = new SpendGuardChainClient({
    rpcUrl: config.rpcUrl,
    guardAddress: config.guardAddress,
    agentPrivateKey: config.agentPrivateKey,
    chain: config.chain,
  });
  const memory = new SibylMemoryClient({
    command: config.memoryMcpCommand,
    ...(config.memoryDbPath ? { env: { ...process.env, SIBYL_MEMORY_DB: config.memoryDbPath } } : {}),
  });
  const intelligence = new X402IntelligenceClient({ endpointUrl: mockEndpoint });

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
    const first = await handleTokenQuery(TEST_CONTRACT, deps);
    console.log("[escalation-resume] result 1:", first);
    if (first.outcome !== "pending_approval") {
      throw new Error(
        `expected "pending_approval", got "${first.outcome}" — is ESCALATION_AMOUNT_USDC_6DP still above the deployed threshold?`,
      );
    }
    console.log("[escalation-resume] no funds moved yet, no intelligence call yet — the agent proposed, it did not execute.");

    console.log(`[escalation-resume] owner approving requestId ${first.requestId.toString()}...`);
    const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
    const ownerAccount = privateKeyToAccount(config.deployerPrivateKey);
    const ownerWallet = createWalletClient({ account: ownerAccount, chain: config.chain, transport: http(config.rpcUrl) });
    // Same class of issue as the Day 8 stale-read bug (docs/API_NOTES.md):
    // viem's writeContract does an eth_call-based gas estimate before
    // broadcasting, and Base Sepolia's public multi-node RPC can route that
    // estimate to a node that hasn't yet seen the block this request was
    // JUST created in. Retry the whole call rather than assume a revert
    // here means the request is genuinely invalid.
    const approveTxHash = await withRetry(
      () =>
        ownerWallet.writeContract({
          address: config.guardAddress,
          abi: SPEND_GUARD_ABI,
          functionName: "ownerApprove",
          args: [first.requestId],
          chain: config.chain,
          account: ownerAccount,
        }),
      { maxAttempts: 5, baseDelayMs: 2000, isRetryable: () => true },
    );
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    if (approveReceipt.status !== "success") {
      throw new Error(`ownerApprove tx ${approveTxHash} reverted (status=${approveReceipt.status})`);
    }
    const approveEvents = parseEventLogs({ abi: SPEND_GUARD_ABI, logs: approveReceipt.logs });
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
      resumed = await resumeAfterApproval(TEST_CONTRACT, first.requestId, first.fromBlock, {
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
    const third = await handleTokenQuery(TEST_CONTRACT, deps);
    console.log("[escalation-resume] result 3:", third);
    if (third.outcome !== "cache_hit") {
      throw new Error(`expected "cache_hit" on the third call, got "${third.outcome}"`);
    }

    console.log(
      "[escalation-resume] PASS: propose -> approve -> auto-detected resolution -> intelligence check -> cache write, proven end-to-end.",
    );
  } finally {
    await memory.close();
    await new Promise<void>((resolve, reject) => mockServer.close((err) => (err ? reject(err) : resolve())));
  }
}

main().catch((err: unknown) => {
  console.error("[escalation-resume] FAILED:", err);
  process.exitCode = 1;
});
