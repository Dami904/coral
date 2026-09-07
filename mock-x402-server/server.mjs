// Zero-dependency mock of Sibyl's x402 endpoint shape, captured live from a
// real GET to https://sibylcap.com/api/evaluate on 2026-08-25. Run:
//   node server.mjs
// Then point the decision core's SIBYL_ENDPOINT env var at
// http://localhost:8402/api/evaluate during development.
import http from "node:http";

const PORT = 8402;
const PRICE_USDC_6DP = "250000"; // $0.25, matches the real /api/evaluate price
const PAY_TO = "0x000000000000000000000000000000000dEaD1"; // mock recipient
const USDC_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // real Base USDC address, kept for shape-fidelity only — this mock never touches it

const seenTxHashes = new Set(); // enforce "single-use", same claim the real endpoint makes

function challenge(res) {
  res.writeHead(402, {
    "Content-Type": "application/json",
    "access-control-allow-headers": "Content-Type, X-PAYMENT",
    "access-control-expose-headers": "X-PAYMENT-RESPONSE",
  });
  res.end(JSON.stringify({
    x402Version: 1,
    accepts: [{
      scheme: "exact",
      network: "base-sepolia", // mock runs on testnet framing; the real endpoint says "base" (mainnet)
      maxAmountRequired: PRICE_USDC_6DP,
      asset: USDC_ASSET,
      payTo: PAY_TO,
      resource: `http://localhost:${PORT}/api/evaluate`,
      description: "MOCK: SIBYL full project evaluation (local stub, no real payment verified)",
      maxTimeoutSeconds: 600,
      extra: { name: "USD Coin", version: "2" },
    }],
    error: "payment required",
    alt: { directTx: {
      header: "X-PAYMENT-TX",
      instructions: "Send maxAmountRequired (USDC, 6dp) to payTo on Base, then resend with header X-PAYMENT-TX:<txHash> within 120s. Single-use.",
    }},
  }));
}

const TIER_BUCKETS = [
  { tier: "low_conviction", scoreMin: 0, scoreMax: 11 },
  { tier: "medium_conviction", scoreMin: 12, scoreMax: 23 },
  { tier: "high_conviction", scoreMin: 24, scoreMax: 30 },
];

/**
 * Deterministic (same token always maps to the same tier — real caching
 * behavior depends on that) but varied mock verdict, keyed off the token
 * address itself. Before this, every token got the identical hardcoded
 * "high_conviction"/24, which made a demo look staged (every query, real
 * address or not, returning the exact same result). This is still
 * disclosed MOCK data (see `mock: true` below and docs/LIMITATIONS.md) —
 * varying it doesn't make it a real evaluation, just a more honest-looking
 * *fake* one for a recording. Exported so tests can assert against it
 * instead of hardcoding a value that would silently drift from this logic.
 */
export function tierForToken(token) {
  const normalized = (token ?? "").toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  const bucket = TIER_BUCKETS[hash % TIER_BUCKETS.length];
  const score = bucket.scoreMin + (hash % (bucket.scoreMax - bucket.scoreMin + 1));
  return { tier: bucket.tier, conviction_score: score };
}

function verdict(res, txHash, token) {
  const { tier, conviction_score } = tierForToken(token);
  res.writeHead(200, { "Content-Type": "application/json", "X-PAYMENT-RESPONSE": txHash });
  res.end(JSON.stringify({
    conviction_score,
    tier,
    builder_conviction: { note: "MOCK data — not a real evaluation" },
    community_seed: {},
    onchain_proof: {},
    mock: true,
    verified_tx: txHash,
  }));
}

// Exported so tests can spin up a real http.Server in-process (ephemeral
// port, real HTTP round trip) instead of duplicating this logic against a
// mocked fetch — see test/x402Client.test.ts.
export function requestHandler(req, res) {
  if (!req.url.startsWith("/api/evaluate")) {
    res.writeHead(404); res.end("not found"); return;
  }

  const token = new URL(req.url, "http://localhost").searchParams.get("token");

  const txHash = req.headers["x-payment-tx"];
  if (!txHash) return challenge(res);

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "malformed tx hash" }));
    return;
  }
  if (seenTxHashes.has(txHash)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "tx hash already used (single-use)" }));
    return;
  }
  seenTxHashes.add(txHash);

  // IMPORTANT: unlike the real endpoint, this mock does NOT verify the tx
  // on-chain (no RPC call, no confirmation check, no amount/recipient
  // check) — it trusts any well-formed hash. That keeps the dev loop fast
  // and dependency-free, but it means passing against this mock proves
  // your CLIENT logic works, not that on-chain settlement actually works.
  // Only the one real mainnet smoke test proves that.
  verdict(res, txHash, token);
}

// Only auto-listen when run directly (`node server.mjs` / `pnpm mock:x402`),
// not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  http.createServer(requestHandler).listen(PORT, () => console.log(`mock x402 server listening on :${PORT}`));
}
