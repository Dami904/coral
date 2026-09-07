/**
 * One query, one fresh OS process, then exit. Deliberately does NOT reset
 * the memory DB and holds no state across invocations — unlike
 * live-deletion-test.ts (which runs its whole miss/hit/delete/miss
 * sequence inside one continuous process), this script exists specifically
 * so each call in the demo video is a genuinely separate process. That's
 * the literal thing the eligibility gate asks for ("recall and use
 * persisted context in a fresh session"): the only way this process can
 * possibly know about a prior call is the on-disk SQLite file, since
 * nothing else survives between invocations of a short-lived script.
 *
 * Intelligence check points at the local mock x402 server, not the real
 * https://sibylcap.com/api/evaluate — same as every other live:* script
 * (live-day5-smoke.ts, live-http-server.ts) and for the same reason:
 * SpendGuard here is deployed on Base Sepolia, and Sibyl's real endpoint
 * only recognizes Base *mainnet* transactions. That's also why the output
 * used to print "unknown-stub" — this was on StubIntelligenceClient, a
 * Day-1 placeholder that never called anything real. See docs/API_NOTES.md.
 * The mock's verdict is deterministic per-token but still disclosed MOCK
 * data (mock-x402-server/server.mjs's tierForToken) — not Sibyl's real
 * evaluation of this address.
 *
 * Real (tiny) testnet payment on a cache miss — needs a funded agent
 * wallet, hence the live: prefix per CLAUDE.md.
 *
 * Run: pnpm live:demo-query [tokenAddress]
 *   (defaults to real Base WETH's address if none given — a genuine,
 *   recognizable contract, not a placeholder like 0x...dead)
 */
import { loadConfig } from "../src/config.js";
import { handleJobQuery } from "../src/decisionCore.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { makeChainClient, makeMemoryClient, SIBYL_HIRED_AGENT_ID, startMockX402Server } from "./lib/liveHarness.js";

// Base's canonical WETH predeploy — a real, well-known contract, not a
// placeholder address, so the demo query looks like a genuine lookup.
const DEFAULT_TOKEN = "0x4200000000000000000000000000000000000006";

async function main(): Promise<void> {
  const token = process.argv[2] ?? DEFAULT_TOKEN;
  const config = loadConfig();
  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const mockServer = await startMockX402Server();
  const intelligence = new X402IntelligenceClient({ endpointUrl: mockServer.endpoint });

  console.log(`[demo-query] pid ${process.pid.toString()}, fresh process, querying ${token}`);
  const result = await handleJobQuery(SIBYL_HIRED_AGENT_ID, token, {
    memory,
    chain,
    intelligence,
    payTo: config.vendorPayTo,
    priceUsdc6dp: 100_000n,
    staleWindowMs: 60 * 60 * 1000,
  });
  console.log(`[demo-query] outcome: ${result.outcome}`);
  console.log(result);

  await memory.close();
  await mockServer.close();
}

main().catch((err: unknown) => {
  console.error("[demo-query] FAILED:", err);
  process.exitCode = 1;
});
