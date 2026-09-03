/**
 * The final automated gate before the real recorded demo: one real
 * end-to-end query against the deployed MAINNET SpendGuard and Sibyl's
 * real production /api/evaluate endpoint. Real, non-refundable USDC spend
 * (~$0.25 at today's confirmed price — docs/API_NOTES.md) and real gas.
 * Requires NETWORK=mainnet plus a funded agent + owner wallet (see
 * PLAN.md's mainnet funding checklist). Never run this without
 * deliberately deciding to (see CLAUDE.md: "don't deploy to mainnet from
 * an agent session" — the same principle applies to spending on mainnet).
 *
 * Because the recommended mainnet policy (script/DeployMainnet.s.sol) sets
 * humanApprovalThreshold below the real $0.25 price, this query is
 * expected to escalate — this script also owner-approves it and proves
 * decisionCore's resumeAfterApproval closes the loop, on real money.
 *
 * Run: NETWORK=mainnet MAINNET_SMOKE_TEST_TOKEN=0x... pnpm live:mainnet-smoke
 */
import { loadConfig } from "../src/config.js";
import { handleJobQuery, resumeAfterApproval } from "../src/decisionCore.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { makeChainClient, makeMemoryClient, makeOwnerClients, ownerApproveAndWait, resetMemoryDb, SIBYL_HIRED_AGENT_ID } from "./lib/liveHarness.js";

const REAL_PRICE_USDC_6DP = 250_000n; // confirmed live, docs/API_NOTES.md

async function main() {
  const config = loadConfig();
  if (config.network !== "mainnet") {
    throw new Error("set NETWORK=mainnet before running this — refusing to run a mainnet smoke test against testnet config");
  }
  const ownerClients = makeOwnerClients(config);
  const contract = process.env["MAINNET_SMOKE_TEST_TOKEN"];
  if (!contract) {
    throw new Error("MAINNET_SMOKE_TEST_TOKEN required — a real ERC-20 contract address on Base to evaluate");
  }

  resetMemoryDb(config, "mainnet-smoke");

  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const intelligence = new X402IntelligenceClient({ endpointUrl: "https://sibylcap.com/api/evaluate" });

  const deps = {
    memory,
    chain,
    intelligence,
    payTo: config.vendorPayTo,
    priceUsdc6dp: REAL_PRICE_USDC_6DP,
    staleWindowMs: 60 * 60 * 1000,
  };

  try {
    console.log(`[mainnet-smoke] call 1: real query for ${contract} against the deployed mainnet guard...`);
    const first = await handleJobQuery(SIBYL_HIRED_AGENT_ID, contract, deps);
    console.log("[mainnet-smoke] result 1:", first);

    let tier: string;
    if (first.outcome === "paid") {
      tier = first.output;
    } else if (first.outcome === "pending_approval") {
      console.log(
        `[mainnet-smoke] escalated as expected (threshold below the real price) — owner approving requestId ${first.requestId.toString()}...`,
      );
      const { txHash: approveTxHash, events: approveEvents } = await ownerApproveAndWait(
        config,
        ownerClients,
        first.requestId,
      );
      if (!approveEvents.some((e) => e.eventName === "PaymentApproved")) {
        throw new Error(`ownerApprove tx ${approveTxHash} did not emit PaymentApproved`);
      }
      console.log(`[mainnet-smoke] owner approved on-chain (tx ${approveTxHash}) — resuming (real x402 call)...`);
      const resumed = await resumeAfterApproval(SIBYL_HIRED_AGENT_ID, contract, first.requestId, first.fromBlock, {
        memory,
        intelligence,
        chain,
        now: () => new Date(),
      });
      console.log("[mainnet-smoke] resumed result:", resumed);
      if (resumed.outcome !== "paid") {
        throw new Error(`expected "paid" after resuming an approved request, got "${resumed.outcome}"`);
      }
      tier = resumed.output;
    } else {
      throw new Error(`expected "paid" or "pending_approval" on the first real call, got "${first.outcome}"`);
    }

    console.log("[mainnet-smoke] call 2: same contract, expect cache hit -> zero additional payment");
    const second = await handleJobQuery(SIBYL_HIRED_AGENT_ID, contract, deps);
    console.log("[mainnet-smoke] result 2:", second);
    if (second.outcome !== "cache_hit") {
      throw new Error(`expected "cache_hit" on the second call, got "${second.outcome}"`);
    }

    console.log(
      `[mainnet-smoke] PASS: real mainnet payment -> real /api/evaluate response (tier: ${tier}) -> cached, wired end-to-end on real money.`,
    );
  } finally {
    await memory.close();
  }
}

main().catch((err: unknown) => {
  console.error("[mainnet-smoke] FAILED:", err);
  process.exitCode = 1;
});
