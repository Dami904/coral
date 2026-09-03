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
 * Run: pnpm live:http-server
 * Then: curl http://127.0.0.1:8787/health
 *       curl "http://127.0.0.1:8787/check?token=0x..."
 */
import { createServer } from "node:http";
import { loadConfig } from "../src/config.js";
import { createHttpGatewayListener } from "../src/http/httpGatewayServer.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { makeChainClient, makeMemoryClient } from "./lib/liveHarness.js";

const PORT = Number(process.env["HTTP_PORT"] ?? 8787);
const PRICE_USDC_6DP = 250_000n; // matches the real /api/evaluate price

async function main() {
  const config = loadConfig();

  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const intelligence = new X402IntelligenceClient({ endpointUrl: "https://sibylcap.com/api/evaluate" });

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
      void memory.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error("[http-server] FAILED:", err);
  process.exitCode = 1;
});
