/**
 * The real entry point for Coral's free HTTP access path
 * (src/http/httpGatewayServer.ts): any caller can GET /check?token=0x...
 * with no payment of their own — Coral pays Sibyl out of its own
 * SpendGuard treasury on a cache miss, bounded by the guard's own
 * on-chain budget/rate-limit/allowlist rules. Unlike live-ping-listener.ts
 * this has no external registration prerequisite — it's a plain local
 * Node HTTP server talking to the already-deployed testnet SpendGuard —
 * so it's safe to run for real verification the same way the other
 * live:* smoke tests are, not gated behind a special go-ahead.
 *
 * Intelligence check points at the in-process local mock x402 server, not
 * the real https://sibylcap.com/api/evaluate — same as every other
 * live:* script (live-day5-smoke.ts, live-escalation-resume-demo.ts,
 * etc.), and for the same reason: SpendGuard here is deployed on Base
 * Sepolia, and Sibyl's real endpoint only recognizes Base *mainnet*
 * transactions. Pointing this script at the real endpoint (the original
 * version of this file did) meant an approved, on-chain-paid escalation
 * could never actually resolve — "transaction not found. it may still be
 * confirming" forever, since the tx genuinely doesn't exist on the chain
 * Sibyl checks. Confirmed live: a real ownerApprove + real USDC transfer,
 * then 5 retries over 45s against the real endpoint, same error every
 * time. See docs/API_NOTES.md and docs/LIMITATIONS.md.
 *
 * Run: pnpm live:http-server
 * Then: curl http://127.0.0.1:8787/health
 *       curl "http://127.0.0.1:8787/check?token=0x..."
 */
import { createServer } from "node:http";
import { loadConfig } from "../src/config.js";
import { createHttpGatewayListener } from "../src/http/httpGatewayServer.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { makeChainClient, makeMemoryClient, startMockX402Server } from "./lib/liveHarness.js";

const PORT = Number(process.env["HTTP_PORT"] ?? 8787);
const PRICE_USDC_6DP = 250_000n; // matches the real /api/evaluate price

async function main() {
  const config = loadConfig();

  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const mockServer = await startMockX402Server();
  console.log(`[http-server] local mock x402 server listening at ${mockServer.endpoint}`);
  const intelligence = new X402IntelligenceClient({ endpointUrl: mockServer.endpoint });

  const server = createServer(
    createHttpGatewayListener({
      memory,
      chain,
      intelligence,
      payTo: config.vendorPayTo,
      priceUsdc6dp: PRICE_USDC_6DP,
      staleWindowMs: 60 * 60 * 1000,
    }),
  );

  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  console.log(`[http-server] listening on http://127.0.0.1:${PORT.toString()} (GET /check?token=, GET /resume, GET /health)`);

  const shutdown = () => {
    console.log("[http-server] shutting down...");
    server.close(() => {
      void Promise.allSettled([memory.close(), mockServer.close()]).finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error("[http-server] FAILED:", err);
  process.exitCode = 1;
});
