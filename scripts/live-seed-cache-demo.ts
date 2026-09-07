/**
 * Seeds Sibyl Memory with a realistic mix of cache hits and real payments
 * before recording the demo — deliberately does NOT reset the memory DB
 * (unlike every other live:* harness), since the point here is to build up
 * a journal worth reporting on with pnpm report:cache-savings, not to prove
 * a clean cold-start.
 *
 * Real (tiny) testnet payments against the deployed SpendGuard — needs a
 * funded agent wallet, hence the live: prefix per CLAUDE.md.
 *
 * Run: pnpm live:seed-cache-demo
 */
import { loadConfig } from "../src/config.js";
import { handleJobQuery } from "../src/decisionCore.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { makeChainClient, makeMemoryClient, SIBYL_HIRED_AGENT_ID, startMockX402Server } from "./lib/liveHarness.js";

// Distinct fake contract addresses so each gets its own cache entry — a
// real miss (payment) on first touch, a real hit (zero payment) on repeat.
const TOKENS = [
  "0x00000000000000000000000000000000000a11",
  "0x00000000000000000000000000000000000b22",
  "0x00000000000000000000000000000000000c33",
];

async function main(): Promise<void> {
  const config = loadConfig();
  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const mockServer = await startMockX402Server();
  const intelligence = new X402IntelligenceClient({ endpointUrl: mockServer.endpoint });

  const deps = {
    memory,
    chain,
    intelligence,
    payTo: config.vendorPayTo,
    priceUsdc6dp: 100_000n, // $0.10 — well under the deployed guard's $0.15 escalation threshold
    staleWindowMs: 60 * 60 * 1000,
  };

  for (const token of TOKENS) {
    console.log(`[seed] ${token}: call 1 (expect miss -> real payment)`);
    const first = await handleJobQuery(SIBYL_HIRED_AGENT_ID, token, deps);
    console.log(`[seed] ${token}: result 1:`, first);

    console.log(`[seed] ${token}: call 2 (expect hit -> zero payment)`);
    const second = await handleJobQuery(SIBYL_HIRED_AGENT_ID, token, deps);
    console.log(`[seed] ${token}: result 2:`, second);
  }

  console.log(`[seed] done: ${TOKENS.length.toString()} tokens seeded, each with one real payment + one cache hit`);
  await memory.close();
  await mockServer.close();
}

main().catch((err: unknown) => {
  console.error("[seed] FAILED:", err);
  process.exitCode = 1;
});
