/**
 * Proves the Day 5 deliverable for real: the full directTx -> X-PAYMENT-TX
 * flow, with a REAL Base Sepolia SpendGuard payment relayed to a REAL HTTP
 * server (the local mock — free, no mainnet spend). Not part of `pnpm
 * test` — needs a funded agent wallet, hence the `live:` prefix.
 *
 * This is deliberately NOT the real mainnet smoke test PLAN.md also calls
 * for (real USDC to Sibyl's real payTo on Base mainnet) — that's a
 * separate, explicit, costly step requiring its own confirmation.
 *
 * Run: pnpm live:day5-smoke
 */
import { loadConfig } from "../src/config.js";
import { handleTokenQuery } from "../src/decisionCore.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { makeChainClient, makeMemoryClient, resetMemoryDb, startMockX402Server } from "./lib/liveHarness.js";

const TEST_CONTRACT = "0x000000000000000000000000000000c0ffee02";

async function main() {
  const config = loadConfig();

  const mockServer = await startMockX402Server();
  console.log(`[smoke] local mock x402 server listening at ${mockServer.endpoint}`);

  resetMemoryDb(config, "smoke");

  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const intelligence = new X402IntelligenceClient({ endpointUrl: mockServer.endpoint });

  const deps = {
    memory,
    chain,
    intelligence,
    payTo: config.vendorPayTo,
    priceUsdc6dp: 100_000n,
    staleWindowMs: 60 * 60 * 1000,
  };

  try {
    console.log(`[smoke] call 1 (expect cache miss -> real testnet payment -> real HTTP directTx flow) for ${TEST_CONTRACT}`);
    const first = await handleTokenQuery(TEST_CONTRACT, deps);
    console.log("[smoke] result 1:", first);
    if (first.outcome !== "paid") {
      throw new Error(`expected outcome "paid" on first call, got "${first.outcome}"`);
    }

    console.log(`[smoke] call 2 (expect cache hit -> zero payment, zero HTTP call) for ${TEST_CONTRACT}`);
    const second = await handleTokenQuery(TEST_CONTRACT, deps);
    console.log("[smoke] result 2:", second);
    if (second.outcome !== "cache_hit") {
      throw new Error(`expected outcome "cache_hit" on second call, got "${second.outcome}"`);
    }

    console.log("[smoke] PASS: real SpendGuard payment -> real directTx/X-PAYMENT-TX HTTP relay -> real MCP cache, wired end-to-end");
  } finally {
    await memory.close();
    await mockServer.close();
  }
}

main().catch((err: unknown) => {
  console.error("[smoke] FAILED:", err);
  process.exitCode = 1;
});
