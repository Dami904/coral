import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { handleJobQuery, resumeAfterApproval, type HandleTokenQueryDeps } from "../decisionCore.js";
import { createKeyedLock } from "../lib/keyedLock.js";
import type { HiredAgentId, ResumableChainPort } from "../types.js";

const CONTRACT_RE = /^0x[a-fA-F0-9]{40}$/;
const REQUEST_ID_RE = /^\d+$/;

/**
 * The free HTTP entry point: any caller can request a conviction-tier
 * lookup with no payment of their own — Coral pays Sibyl out of its own
 * SpendGuard treasury on a cache miss, same as the Ping/free path
 * (decisionCore.handleJobQuery). Worst-case spend exposure from public
 * abuse is bounded by SpendGuard's own on-chain budget/rate-limit/
 * allowlist rules, not by anything this HTTP layer does — a flood of
 * requests degrades to "blocked" (503) once the guard's own rate limit
 * trips, exactly as it would for any other caller of this deployment's
 * agent wallet. See docs/THREAT_MODEL.md.
 *
 * Safely retryable for a single client's *sequential* retries: if a
 * connection drops mid `handleJobQuery` after a real payment already
 * landed, the memory write happens before this handler returns anything,
 * so a retried GET for the same contract is a cache hit, not a second
 * payment. That guarantee does NOT extend to concurrent requests for the
 * same contract from different callers — see the per-contract lock below
 * and docs/LIMITATIONS.md.
 */
export type HttpGatewayDeps = HandleTokenQueryDeps & {
  chain: ResumableChainPort;
  /** Which hired agent this deployment's /check and /resume answer for —
   * always Sibyl's conviction-check today (see scripts/lib/liveHarness.ts's
   * SIBYL_HIRED_AGENT_ID), but the core no longer assumes that's the only
   * possible value. */
  hiredAgentId: HiredAgentId;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // Public, unauthenticated, GET-only reads — open CORS is the correct
  // policy here, not an oversight: there's no session/cookie to leak, and
  // the same responses are already fetchable by anyone via plain curl.
  // Lets browser-based callers (e.g. coral-landing's live widget) call
  // this cross-origin without a bespoke allowlist to maintain.
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
}

function readQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://localhost").searchParams;
}

async function handleCheck(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpGatewayDeps,
  withContractLock: ReturnType<typeof createKeyedLock>,
): Promise<void> {
  const contract = readQuery(req).get("token")?.toLowerCase();
  if (!contract || !CONTRACT_RE.test(contract)) {
    sendJson(res, 400, { error: "query param 'token' must be a 0x-prefixed 20-byte contract address" });
    return;
  }

  const outcome = await withContractLock(contract, () => handleJobQuery(deps.hiredAgentId, contract, deps));
  switch (outcome.outcome) {
    case "cache_hit":
      // Explicit field-by-field build, not a spread: `outcome.output` is
      // the core's now-generic field name, but the wire response keeps
      // `tier` — this deployment's one real hired agent (Sibyl) really is
      // a conviction tier, and coral-landing's live widget already reads
      // `data.tier`. A blind `{...outcome}` would leak `output` instead
      // and silently break that widget.
      sendJson(res, 200, { outcome: outcome.outcome, tier: outcome.output, checkedAt: outcome.checkedAt, note: "Conviction tier, not a safety/scam verdict." });
      return;
    case "paid":
      sendJson(res, 200, { outcome: outcome.outcome, tier: outcome.output, txHash: outcome.txHash, note: "Conviction tier, not a safety/scam verdict." });
      return;
    case "pending_approval":
      sendJson(res, 202, {
        outcome: outcome.outcome,
        requestId: outcome.requestId.toString(),
        fromBlock: outcome.fromBlock.toString(),
        note: "This check needs human sign-off before it can proceed — poll GET /resume with these values.",
      });
      return;
    case "blocked":
      // Coral's own SpendGuard policy refused to pay Sibyl for this check
      // (allowlist/budget/rate-limit) — a real backpressure signal, not a
      // client error, hence 503 rather than 4xx.
      sendJson(res, 503, outcome);
      return;
  }
}

async function handleResume(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpGatewayDeps,
  withContractLock: ReturnType<typeof createKeyedLock>,
): Promise<void> {
  const query = readQuery(req);
  const contract = query.get("contract")?.toLowerCase();
  const requestIdRaw = query.get("requestId");
  const fromBlockRaw = query.get("fromBlock");
  if (!contract || !CONTRACT_RE.test(contract) || !requestIdRaw || !REQUEST_ID_RE.test(requestIdRaw) || !fromBlockRaw || !REQUEST_ID_RE.test(fromBlockRaw)) {
    sendJson(res, 400, { error: "query params 'contract' (address), 'requestId' and 'fromBlock' (both decimal integers) are required" });
    return;
  }

  // Same lock namespace as /check: a /resume landing while a /check for
  // the same contract is still mid-flight (e.g. awaiting the intelligence
  // check after a just-approved payment) should queue behind it, not race
  // it — both ultimately write the same job-cache entry.
  const outcome = await withContractLock(contract, () =>
    resumeAfterApproval(deps.hiredAgentId, contract, BigInt(requestIdRaw), BigInt(fromBlockRaw), deps),
  );
  switch (outcome.outcome) {
    case "still_pending":
      sendJson(res, 202, outcome);
      return;
    case "rejected":
      sendJson(res, 409, outcome);
      return;
    case "paid":
      // Explicit build, not a spread — same reasoning as handleCheck above.
      sendJson(res, 200, { outcome: outcome.outcome, tier: outcome.output, txHash: outcome.txHash, note: "Conviction tier, not a safety/scam verdict." });
      return;
  }
}

export function createHttpGatewayListener(deps: HttpGatewayDeps): RequestListener {
  const withContractLock = createKeyedLock();
  return (req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "only GET is supported" });
          return;
        }
        if (path === "/health") {
          sendJson(res, 200, { status: "ok" });
          return;
        }
        if (path === "/check") {
          await handleCheck(req, res, deps, withContractLock);
          return;
        }
        if (path === "/resume") {
          await handleResume(req, res, deps, withContractLock);
          return;
        }
        sendJson(res, 404, { error: "not found", routes: ["GET /check?token=0x...", "GET /resume?contract=&requestId=&fromBlock=", "GET /health"] });
      } catch (err) {
        // IntelligenceCheckFailedAfterPaymentError/CacheWriteFailedAfterPaymentError
        // (docs/API_NOTES.md's "dangerous ordering" note) carry the exact
        // contract/txHash that needs human reconciliation — surface them as
        // their own structured fields, matching pollOnce.ts's convention,
        // not just buried inside the serialized `err`.
        const withContext = err as { contract?: unknown; txHash?: unknown };
        console.error("httpGatewayServer: unhandled error while serving a request", {
          url: req.url,
          contract: withContext.contract,
          txHash: withContext.txHash,
          err,
        });
        sendJson(res, 500, { error: "internal error" });
      }
    })();
  };
}
