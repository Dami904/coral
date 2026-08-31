import { describe, expect, it } from "vitest";
import { pollOnce, defaultFormatReply, extractContractAddress, extractGatewayRequest } from "../src/ping/pollOnce.js";
import type { HandleOutcome, PingMessage, PingPort, PollReplyOutcome } from "../src/types.js";

const SENDER_A: `0x${string}` = "0x000000000000000000000000000000000000a1";
const SENDER_B: `0x${string}` = "0x000000000000000000000000000000000000b2";
const CONTRACT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TX_HASH = "0x" + "ab".repeat(32);

function msg(overrides: Partial<PingMessage>): PingMessage {
  return {
    from: SENDER_A,
    to: "0x0000000000000000000000000000000000dead",
    content: `is ${CONTRACT} safe?`,
    block: 100n,
    transactionHash: "0xaa",
    isBroadcast: false,
    replied: false,
    replyBlock: null,
    ...overrides,
  };
}

function makePing(inbox: PingMessage[]): PingPort & { replies: { to: string; content: string }[] } {
  const replies: { to: string; content: string }[] = [];
  return {
    replies,
    async getInboxWithStatus() {
      return inbox;
    },
    async sendReply(to, content) {
      replies.push({ to, content });
      return { txHash: "0xreply" };
    },
  };
}

describe("pollOnce", () => {
  it("skips broadcasts entirely — no handle call, no reply", async () => {
    const ping = makePing([msg({ isBroadcast: true, to: "broadcast", replied: null })]);
    let handleCalls = 0;

    const result = await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async () => {
        handleCalls++;
        return { outcome: "blocked", reason: "n/a" };
      },
    });

    expect(handleCalls).toBe(0);
    expect(ping.replies).toEqual([]);
    expect(result.processed).toBe(0);
    expect(result.newLastProcessedBlock).toBe(100n);
  });

  it("skips messages already replied to", async () => {
    const ping = makePing([msg({ replied: true })]);
    let handleCalls = 0;

    const result = await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async () => {
        handleCalls++;
        return { outcome: "blocked", reason: "n/a" };
      },
    });

    expect(handleCalls).toBe(0);
    expect(ping.replies).toEqual([]);
    expect(result.processed).toBe(0);
  });

  it("extracts the contract, calls handle, and replies with the formatted outcome", async () => {
    const ping = makePing([msg({})]);
    let receivedContract: string | null = null;

    const outcome: HandleOutcome = { outcome: "paid", tier: "high_conviction", txHash: "0xbeef" };
    const result = await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async (contract) => {
        receivedContract = contract;
        return outcome;
      },
    });

    expect(receivedContract).toBe(CONTRACT.toLowerCase());
    expect(ping.replies).toHaveLength(1);
    expect(ping.replies[0]?.to).toBe(SENDER_A);
    expect(ping.replies[0]?.content).toContain("high_conviction");
    expect(result.processed).toBe(1);
    expect(result.newLastProcessedBlock).toBe(100n);
  });

  it("replies with no_contract_found and never calls handle when no address is present", async () => {
    const ping = makePing([msg({ content: "hey, are you there?" })]);
    let handleCalls = 0;

    const result = await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async () => {
        handleCalls++;
        return { outcome: "blocked", reason: "n/a" };
      },
    });

    expect(handleCalls).toBe(0);
    expect(ping.replies).toHaveLength(1);
    expect(ping.replies[0]?.content.toLowerCase()).toContain("address");
    expect(result.processed).toBe(1);
  });

  it("replies with an error message and keeps processing when handle throws", async () => {
    const ping = makePing([msg({ from: SENDER_A, block: 100n }), msg({ from: SENDER_B, block: 101n, transactionHash: "0xbb" })]);

    const result = await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async (contract) => {
        if (contract === CONTRACT.toLowerCase()) throw new Error("guard reverted");
        return { outcome: "cache_hit", tier: "safe", checkedAt: "now" };
      },
    });

    expect(ping.replies).toHaveLength(2);
    expect(ping.replies[0]?.content.toLowerCase()).toContain("guard reverted");
    expect(result.processed).toBe(2);
    expect(result.newLastProcessedBlock).toBe(101n);
  });

  it("gateway: a message with both an address and a tx hash calls handleGateway, not handle, and replies with its outcome", async () => {
    const ping = makePing([msg({ content: `check ${CONTRACT} paid ${TX_HASH}` })]);
    let handleCalls = 0;
    let gatewayArgs: { contract: string; txHash: string } | null = null;

    const result = await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async () => {
        handleCalls++;
        return { outcome: "blocked", reason: "n/a" };
      },
      extractGatewayRequest,
      handleGateway: async (contract, txHash) => {
        gatewayArgs = { contract, txHash };
        return { outcome: "paid", tier: "high_conviction", txHash: "0xbeef" };
      },
    });

    expect(handleCalls).toBe(0);
    expect(gatewayArgs).toEqual({ contract: CONTRACT.toLowerCase(), txHash: TX_HASH.toLowerCase() });
    expect(ping.replies).toHaveLength(1);
    expect(ping.replies[0]?.content).toContain("high_conviction");
    expect(result.processed).toBe(1);
  });

  it("gateway: a message with only an address (no tx hash) still uses the free handle path unchanged", async () => {
    const ping = makePing([msg({})]);
    let handleCalls = 0;
    let gatewayCalls = 0;

    await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async () => {
        handleCalls++;
        return { outcome: "cache_hit", tier: "safe", checkedAt: "now" };
      },
      extractGatewayRequest,
      handleGateway: async () => {
        gatewayCalls++;
        return { outcome: "payment_not_found" };
      },
    });

    expect(gatewayCalls).toBe(0);
    expect(handleCalls).toBe(1);
  });

  it("gateway: a pending_approval outcome is tracked in newlyPending exactly like the free path", async () => {
    const ping = makePing([msg({ content: `check ${CONTRACT} paid ${TX_HASH}` })]);

    const result = await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async () => ({ outcome: "blocked", reason: "n/a" }),
      extractGatewayRequest,
      handleGateway: async () => ({ outcome: "pending_approval", requestId: 3n, fromBlock: 7n }),
    });

    expect(result.newlyPending).toEqual([
      { requestId: 3n, contract: CONTRACT.toLowerCase(), replyTo: SENDER_A, fromBlock: 7n },
    ]);
  });

  it("gateway: replies with an error and keeps processing when handleGateway throws", async () => {
    const ping = makePing([msg({ content: `check ${CONTRACT} paid ${TX_HASH}` })]);

    const result = await pollOnce({
      ping,
      lastProcessedBlock: 0n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async () => ({ outcome: "blocked", reason: "n/a" }),
      extractGatewayRequest,
      handleGateway: async () => {
        throw new Error("verifier RPC down");
      },
    });

    expect(ping.replies).toHaveLength(1);
    expect(ping.replies[0]?.content.toLowerCase()).toContain("verifier rpc down");
    expect(result.processed).toBe(1);
  });

  it("returns the highest block seen even when nothing was actionable, and 0 processed on an empty inbox", async () => {
    const ping = makePing([]);
    const result = await pollOnce({
      ping,
      lastProcessedBlock: 50n,
      extractContract: extractContractAddress,
      formatReply: defaultFormatReply,
      handle: async () => ({ outcome: "blocked", reason: "n/a" }),
    });

    expect(result.processed).toBe(0);
    expect(result.newLastProcessedBlock).toBe(50n);
  });
});

describe("extractContractAddress", () => {
  it("finds a lowercase-normalized address anywhere in the text", () => {
    expect(extractContractAddress(`check ${CONTRACT.toUpperCase()} please`)).toBe(CONTRACT.toLowerCase());
  });

  it("returns null when no address is present", () => {
    expect(extractContractAddress("no address here")).toBeNull();
  });
});

describe("extractGatewayRequest", () => {
  it("finds a lowercase-normalized address and tx hash when both are present, regardless of order", () => {
    expect(extractGatewayRequest(`check ${CONTRACT.toUpperCase()} paid ${TX_HASH.toUpperCase()}`)).toEqual({
      contract: CONTRACT.toLowerCase(),
      txHash: TX_HASH.toLowerCase(),
    });
    expect(extractGatewayRequest(`paid ${TX_HASH.toUpperCase()} for ${CONTRACT.toUpperCase()}`)).toEqual({
      contract: CONTRACT.toLowerCase(),
      txHash: TX_HASH.toLowerCase(),
    });
  });

  it("returns null when only an address is present — never mistaken for a gateway request", () => {
    expect(extractGatewayRequest(`check ${CONTRACT} please`)).toBeNull();
  });

  it("returns null when only a tx hash is present — its own 40-hex-char prefix is never mistaken for a separate address", () => {
    // Regression guard: without a trailing word-boundary on the address
    // regex, the first 40 hex chars of a lone 64-hex tx hash would match
    // extractContractAddress-style — a message with a tx hash but no real
    // address must never be treated as a gateway request.
    expect(extractGatewayRequest(`paid ${TX_HASH}`)).toBeNull();
  });
});

describe("defaultFormatReply", () => {
  it("formats every outcome variant into non-empty human text", () => {
    const outcomes: PollReplyOutcome[] = [
      { outcome: "cache_hit", tier: "safe", checkedAt: "2026-01-01T00:00:00.000Z" },
      { outcome: "paid", tier: "high_conviction", txHash: "0xbeef" },
      { outcome: "pending_approval", requestId: 3n, fromBlock: 10n },
      { outcome: "blocked", reason: "budget-window" },
      { outcome: "no_contract_found" },
      { outcome: "error", message: "boom" },
      { outcome: "resumed", tier: "high_conviction", txHash: "0xbeef" },
      { outcome: "resumed_rejected", requestId: 3n },
      { outcome: "payment_not_found" },
      { outcome: "payment_wrong_recipient" },
      { outcome: "payment_insufficient", amount: 1n, required: 2n },
      { outcome: "payment_already_used" },
    ];
    for (const o of outcomes) {
      expect(defaultFormatReply(o).length).toBeGreaterThan(0);
    }
  });
});
