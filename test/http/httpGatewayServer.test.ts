import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpGatewayListener, type HttpGatewayDeps } from "../../src/http/httpGatewayServer.js";
import type {
  HiredAgentId,
  IntelligencePort,
  JobRecord,
  MemoryPort,
  PaymentOutcome,
  PendingResolution,
  ResumableChainPort,
} from "../../src/types.js";

const CONTRACT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const HIRED_AGENT_ID: HiredAgentId = "sibyl-conviction-check";
const VENDOR: `0x${string}` = "0x000000000000000000000000000000000000ea";
const PRICE = 250_000n;

function makeMemory(
  recallResult: JobRecord | null,
  pendingEscalation: { requestId: bigint; fromBlock: bigint } | null = null,
): MemoryPort {
  return {
    async recallJob() {
      return recallResult;
    },
    async rememberJob() {
      /* no-op for these tests */
    },
    async recordEvent() {
      /* no-op for these tests */
    },
    async wasPaymentConsumed() {
      return false;
    },
    async markPaymentConsumed() {
      /* no-op for these tests */
    },
    async getPendingEscalation() {
      return pendingEscalation;
    },
    async setPendingEscalation() {
      /* no-op for these tests */
    },
    async clearPendingEscalation() {
      /* no-op for these tests */
    },
  };
}

function makeChain(
  outcome: PaymentOutcome,
  resolution: PendingResolution = { kind: "still_pending" },
): ResumableChainPort & { requestPaymentCalls: number } {
  const calls = { count: 0 };
  return {
    get requestPaymentCalls() {
      return calls.count;
    },
    async requestPayment() {
      calls.count++;
      return outcome;
    },
    async checkPendingResolution() {
      return resolution;
    },
  };
}

function makeIntelligence(tier = "high_conviction"): IntelligencePort {
  return {
    async invoke() {
      return { output: tier, raw: { tier }, sourceEndpoint: "https://example.test/api/evaluate" };
    },
  };
}

function deps(overrides: Partial<HttpGatewayDeps>): HttpGatewayDeps {
  return {
    memory: makeMemory(null),
    chain: makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: `0x${"a".repeat(64)}` }),
    intelligence: makeIntelligence(),
    payTo: VENDOR,
    priceUsdc6dp: PRICE,
    staleWindowMs: 60 * 60 * 1000,
    hiredAgentId: HIRED_AGENT_ID,
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;
let currentDeps: HttpGatewayDeps;

beforeAll(async () => {
  server = createServer((req, res) => createHttpGatewayListener(currentDeps)(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://127.0.0.1:${address.port.toString()}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("GET /health", () => {
  it("returns 200 ok without touching any port", async () => {
    currentDeps = deps({});
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("sets Access-Control-Allow-Origin: * so browser callers (e.g. the landing page's live widget) aren't blocked cross-origin", async () => {
    currentDeps = deps({});
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /check", () => {
  it("400s on a missing token", async () => {
    currentDeps = deps({});
    const res = await fetch(`${baseUrl}/check`);
    expect(res.status).toBe(400);
  });

  it("400s on a malformed token", async () => {
    currentDeps = deps({});
    const res = await fetch(`${baseUrl}/check?token=not-an-address`);
    expect(res.status).toBe(400);
  });

  it("200s a cache hit straight from memory, no payment involved", async () => {
    currentDeps = deps({
      memory: makeMemory({ hiredAgentId: HIRED_AGENT_ID, output: "high_conviction", raw_response: {}, checked_at: new Date().toISOString(), source_endpoint: "x" }),
    });
    const res = await fetch(`${baseUrl}/check?token=${CONTRACT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; tier: string };
    expect(body.outcome).toBe("cache_hit");
    expect(body.tier).toBe("high_conviction");
  });

  it("200s a fresh paid check on a cache miss — caller pays nothing, Coral's own guard does", async () => {
    currentDeps = deps({});
    const res = await fetch(`${baseUrl}/check?token=${CONTRACT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; tier: string };
    expect(body.outcome).toBe("paid");
    expect(body.tier).toBe("high_conviction");
  });

  it("503s when Coral's own SpendGuard policy blocks the payment", async () => {
    currentDeps = deps({
      chain: makeChain({ kind: "blocked", payTo: VENDOR, amount: PRICE, reason: "budget window exceeded" }),
    });
    const res = await fetch(`${baseUrl}/check?token=${CONTRACT}`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { outcome: string; reason: string };
    expect(body.reason).toBe("budget window exceeded");
  });

  it("202s and surfaces the escalation request when the payment needs human sign-off", async () => {
    currentDeps = deps({
      chain: makeChain({
        kind: "pending",
        payTo: VENDOR,
        amount: PRICE,
        requestId: 42n,
        txHash: `0x${"b".repeat(64)}`,
        blockNumber: 100n,
      }),
    });
    const res = await fetch(`${baseUrl}/check?token=${CONTRACT}`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { requestId: string; fromBlock: string };
    expect(body.requestId).toBe("42");
    expect(body.fromBlock).toBe("100");
  });

  it("returns the SAME pending request on a repeat call instead of proposing a second on-chain escalation", async () => {
    // Regression test for a real bug found running scripts/live-http-server.ts
    // against the deployed testnet guard: a second /check for a still-pending
    // contract used to fire a brand-new requestPayment every time, and
    // SpendGuard's own rate/budget rules don't count an unapproved pending
    // request (test/SpendGuard.t.sol's PendingDoesNotConsumeBudgetOrRateUntilApproved),
    // so nothing on-chain would have stopped unbounded repeat-escalation spam.
    const chain = makeChain({
      kind: "pending",
      payTo: VENDOR,
      amount: PRICE,
      requestId: 999n,
      txHash: `0x${"f".repeat(64)}`,
      blockNumber: 500n,
    });
    currentDeps = deps({
      chain,
      memory: makeMemory(null, { requestId: 7n, fromBlock: 200n }),
    });

    const res = await fetch(`${baseUrl}/check?token=${CONTRACT}`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { requestId: string; fromBlock: string };
    expect(body.requestId).toBe("7");
    expect(body.fromBlock).toBe("200");
    expect(chain.requestPaymentCalls).toBe(0);
  });
});

describe("GET /resume", () => {
  it("400s when required params are missing", async () => {
    currentDeps = deps({});
    const res = await fetch(`${baseUrl}/resume?contract=${CONTRACT}`);
    expect(res.status).toBe(400);
  });

  it("202s still_pending without asserting a false resolution", async () => {
    currentDeps = deps({ chain: makeChain({ kind: "sent", payTo: VENDOR, amount: PRICE, txHash: `0x${"c".repeat(64)}` }) });
    const res = await fetch(`${baseUrl}/resume?contract=${CONTRACT}&requestId=1&fromBlock=1`);
    expect(res.status).toBe(202);
  });

  it("409s a rejected request", async () => {
    currentDeps = deps({
      chain: makeChain(
        { kind: "sent", payTo: VENDOR, amount: PRICE, txHash: `0x${"c".repeat(64)}` },
        { kind: "rejected", txHash: `0x${"d".repeat(64)}` },
      ),
    });
    const res = await fetch(`${baseUrl}/resume?contract=${CONTRACT}&requestId=1&fromBlock=1`);
    expect(res.status).toBe(409);
  });

  it("200s once approved, running the same intelligence-check + cache-write tail a normal payment does", async () => {
    currentDeps = deps({
      chain: makeChain(
        { kind: "sent", payTo: VENDOR, amount: PRICE, txHash: `0x${"c".repeat(64)}` },
        { kind: "approved", txHash: `0x${"e".repeat(64)}`, amount: PRICE, payTo: VENDOR },
      ),
    });
    const res = await fetch(`${baseUrl}/resume?contract=${CONTRACT}&requestId=1&fromBlock=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; tier: string };
    expect(body.outcome).toBe("paid");
    expect(body.tier).toBe("high_conviction");
  });
});

describe("unhandled routes and methods", () => {
  it("404s an unknown path", async () => {
    currentDeps = deps({});
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it("405s a non-GET method", async () => {
    currentDeps = deps({});
    const res = await fetch(`${baseUrl}/check?token=${CONTRACT}`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("unexpected failures", () => {
  it("500s and does not leak the raw error to the client", async () => {
    currentDeps = deps({
      memory: {
        ...makeMemory(null),
        async recallJob() {
          throw new Error("db exploded");
        },
      },
    });
    const res = await fetch(`${baseUrl}/check?token=${CONTRACT}`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("db exploded");
  });
});

describe("concurrency: per-contract lock", () => {
  it("never double-pays for two concurrent /check calls on the same never-cached contract", async () => {
    // Regression test found by the reliability-auditor after this session's
    // escalation-dedup fix: for a contract priced below humanApprovalThreshold,
    // chain.requestPayment returns "sent" (funds move) immediately, and
    // nothing is written to memory until AFTER the intelligence check
    // completes (decisionCore.ts's finishAfterPayment). Without a lock, two
    // concurrent requests for the same never-before-seen contract can both
    // pass the cache-miss check and both call chain.requestPayment before
    // either result lands anywhere — a genuine double real USDC payment for
    // one logical query. Artificial delays below widen the race window so
    // this test would actually catch a regression, not pass by accident of
    // scheduling.
    let cached: JobRecord | null = null;
    const statefulMemory: MemoryPort = {
      async recallJob() {
        return cached;
      },
      async rememberJob(_hiredAgentId, _input, record) {
        cached = record;
      },
      async recordEvent() {
        /* no-op */
      },
      async wasPaymentConsumed() {
        return false;
      },
      async markPaymentConsumed() {
        /* no-op */
      },
      async getPendingEscalation() {
        return null;
      },
      async setPendingEscalation() {
        /* no-op */
      },
      async clearPendingEscalation() {
        /* no-op */
      },
    };

    const paymentCalls = { count: 0 };
    const delayedChain: ResumableChainPort = {
      async requestPayment() {
        paymentCalls.count++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { kind: "sent", payTo: VENDOR, amount: PRICE, txHash: `0x${"9".repeat(64)}` };
      },
      async checkPendingResolution() {
        return { kind: "still_pending" };
      },
    };
    const delayedIntelligence: IntelligencePort = {
      async invoke() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { output: "high_conviction", raw: {}, sourceEndpoint: "https://example.test/api/evaluate" };
      },
    };

    // Deliberately a dedicated server with a listener created exactly
    // once — matching production (scripts/live-http-server.ts calls
    // createHttpGatewayListener a single time and reuses that listener
    // for the server's whole lifetime). The shared beforeAll server above
    // recreates the listener per-request (via `currentDeps`) so other
    // tests can swap fakes freely; that would also recreate — and so
    // never actually persist — the per-contract lock's Map, silently
    // defeating the very thing this test checks.
    const lockedServer = createServer(
      createHttpGatewayListener({ memory: statefulMemory, chain: delayedChain, intelligence: delayedIntelligence, payTo: VENDOR, priceUsdc6dp: PRICE, staleWindowMs: 60 * 60 * 1000, hiredAgentId: HIRED_AGENT_ID }),
    );
    await new Promise<void>((resolve) => lockedServer.listen(0, resolve));
    const address = lockedServer.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    const lockedBaseUrl = `http://127.0.0.1:${address.port.toString()}`;

    try {
      const [first, second] = await Promise.all([
        fetch(`${lockedBaseUrl}/check?token=${CONTRACT}`),
        fetch(`${lockedBaseUrl}/check?token=${CONTRACT}`),
      ]);
      const firstBody = (await first.json()) as { outcome: string };
      const secondBody = (await second.json()) as { outcome: string };

      expect(paymentCalls.count).toBe(1);
      const outcomes = [firstBody.outcome, secondBody.outcome].sort();
      expect(outcomes).toEqual(["cache_hit", "paid"]);
    } finally {
      await new Promise<void>((resolve, reject) => lockedServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
