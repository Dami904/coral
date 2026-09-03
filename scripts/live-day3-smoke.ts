/**
 * Proves the Day 3-4 deliverable for real: the decision core wired to the
 * live sibyl-memory-mcp server AND the deployed Base Sepolia SpendGuard.
 * Not part of `pnpm test` — needs a funded agent wallet and spends real
 * (tiny) testnet gas, hence the `live:` script-name prefix per CLAUDE.md.
 *
 * Run: pnpm live:day3-smoke
 */
import { loadConfig } from "../src/config.js";
import { handleJobQuery } from "../src/decisionCore.js";
import { StubIntelligenceClient } from "../src/intelligence/stubIntelligenceClient.js";
import { makeChainClient, makeMemoryClient, resetMemoryDb, SIBYL_HIRED_AGENT_ID } from "./lib/liveHarness.js";

const TEST_CONTRACT = "0x000000000000000000000000000000c0ffee01";

async function main() {
  const config = loadConfig();

  // Deterministic first-call-is-a-miss demo run: start from a clean local
  // DB every time this script runs, same file the deletion-test gate
  // targets in the real demo (docs/API_NOTES.md).
  resetMemoryDb(config, "smoke");

  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const intelligence = new StubIntelligenceClient();

  const deps = {
    memory,
    chain,
    intelligence,
    payTo: config.vendorPayTo,
    priceUsdc6dp: 100_000n, // $0.10 — well under the deployed guard's $0.15 escalation threshold
    staleWindowMs: 60 * 60 * 1000,
  };

  console.log(`[smoke] call 1 (expect cache miss -> real testnet payment) for ${TEST_CONTRACT}`);
  const first = await handleJobQuery(SIBYL_HIRED_AGENT_ID, TEST_CONTRACT, deps);
  console.log("[smoke] result 1:", first);
  if (first.outcome !== "paid") {
    throw new Error(`expected outcome "paid" on first call, got "${first.outcome}"`);
  }

  console.log(`[smoke] call 2 (expect cache hit -> zero payment) for ${TEST_CONTRACT}`);
  const second = await handleJobQuery(SIBYL_HIRED_AGENT_ID, TEST_CONTRACT, deps);
  console.log("[smoke] result 2:", second);
  if (second.outcome !== "cache_hit") {
    throw new Error(`expected outcome "cache_hit" on second call, got "${second.outcome}"`);
  }

  console.log("[smoke] PASS: real MCP cache + real SpendGuard payment wired end-to-end");
  await memory.close();
}

main().catch((err: unknown) => {
  console.error("[smoke] FAILED:", err);
  process.exitCode = 1;
});
