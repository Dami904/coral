import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requestHandler } from "../mock-x402-server/server.mjs";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { IntelligenceResultUnrecoverableError } from "../src/types.js";

const CONTRACT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TX_A: `0x${string}` = `0x${"a".repeat(64)}`;
const TX_B: `0x${string}` = `0x${"b".repeat(64)}`;
const MALFORMED_TX = "0xnothex" as `0x${string}`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer(requestHandler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://127.0.0.1:${address.port}/api/evaluate`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("X402IntelligenceClient", () => {
  it("relays the tx hash and token, and returns the tier", async () => {
    const client = new X402IntelligenceClient({ endpointUrl: baseUrl });
    const result = await client.invoke(CONTRACT, TX_A);

    expect(result.output).toBe("high_conviction");
    expect(result.sourceEndpoint).toContain(`token=${CONTRACT}`);
    expect(result.raw).toMatchObject({ verified_tx: TX_A, tier: "high_conviction" });
  });

  it("rejects a malformed tx hash the same way the server does (400)", async () => {
    const client = new X402IntelligenceClient({ endpointUrl: baseUrl });
    await expect(client.invoke(CONTRACT, MALFORMED_TX)).rejects.toThrow(/malformed/i);
  });

  it("rejects reuse of an already-used tx hash (409, single-use)", async () => {
    const client = new X402IntelligenceClient({ endpointUrl: baseUrl });
    await client.invoke(CONTRACT, TX_B);
    await expect(client.invoke(CONTRACT, TX_B)).rejects.toThrow(/already used|single-use/i);
  });
});

describe("X402IntelligenceClient retry/UNKNOWN handling", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("retries a transport-level (network) failure with the same hash and succeeds", async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tier: "high_conviction" }), {
          status: 200,
          headers: { "X-PAYMENT-RESPONSE": "ok" },
        }),
      );

    const client = new X402IntelligenceClient({ endpointUrl: "http://example.invalid/api/evaluate", baseDelayMs: 1 });
    const result = await client.invoke(CONTRACT, TX_A);

    expect(result.output).toBe("high_conviction");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws IntelligenceResultUnrecoverableError when a retry (not the first attempt) hits 409", async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch
      .mockRejectedValueOnce(new Error("timed out")) // first attempt: lost in transit
      .mockResolvedValueOnce(new Response("already used", { status: 409 })); // retry: server says it landed

    const client = new X402IntelligenceClient({ endpointUrl: "http://example.invalid/api/evaluate", baseDelayMs: 1 });

    await expect(client.invoke(CONTRACT, TX_A)).rejects.toBeInstanceOf(IntelligenceResultUnrecoverableError);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws the plain single-use error (not Unrecoverable) on a genuine first-attempt 409", async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValueOnce(new Response("already used", { status: 409 }));

    const client = new X402IntelligenceClient({ endpointUrl: "http://example.invalid/api/evaluate", baseDelayMs: 1 });

    await expect(client.invoke(CONTRACT, TX_A)).rejects.toThrow(/already used|single-use/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
