import { beforeEach, describe, expect, it, vi } from "vitest";
import { SibylMemoryClient, MemoryToolRejectedError } from "../../src/memory/sibylMemoryClient.js";
import type { HiredAgentId, JobRecord } from "../../src/types.js";

const { callToolMock, connectMock, closeMock } = vi.hoisted(() => ({
  callToolMock: vi.fn(),
  connectMock: vi.fn(async () => {}),
  closeMock: vi.fn(async () => {}),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function Client() {
    return { connect: connectMock, close: closeMock, callTool: callToolMock };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function StdioClientTransport() {
    return {};
  }),
}));

function textResult(payload: unknown, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

const CONTRACT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const HIRED_AGENT_ID: HiredAgentId = "sibyl-conviction-check";
const RECORD: JobRecord = {
  hiredAgentId: HIRED_AGENT_ID,
  output: "high_conviction",
  raw_response: {},
  checked_at: "2026-08-26T12:00:00.000Z",
  source_endpoint: "/api/evaluate",
};

beforeEach(() => {
  callToolMock.mockReset();
  connectMock.mockClear();
});

describe("SibylMemoryClient", () => {
  describe("recallJob", () => {
    it("returns the parsed record on a successful recall", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ entity: { body: RECORD } }));
      const client = new SibylMemoryClient();
      const result = await client.recallJob(HIRED_AGENT_ID, CONTRACT);
      expect(result).toEqual(RECORD);
    });

    it("returns null on a NOT_FOUND rejection, without retrying", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "NOT_FOUND" }, true));
      const client = new SibylMemoryClient();
      const result = await client.recallJob(HIRED_AGENT_ID, CONTRACT);
      expect(result).toBeNull();
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("throws MemoryToolRejectedError on a real (non-NOT_FOUND) rejection, without retrying", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "VALIDATION_ERROR" }, true));
      const client = new SibylMemoryClient();
      await expect(client.recallJob(HIRED_AGENT_ID, CONTRACT)).rejects.toBeInstanceOf(MemoryToolRejectedError);
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("retries a transport-level (UNKNOWN) failure and succeeds", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("stdio pipe closed"))
        .mockResolvedValueOnce(textResult({ entity: { body: RECORD } }));
      const client = new SibylMemoryClient();
      const result = await client.recallJob(HIRED_AGENT_ID, CONTRACT);
      expect(result).toEqual(RECORD);
      expect(callToolMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("rememberJob", () => {
    it("writes successfully on the first attempt", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ ok: true }));
      const client = new SibylMemoryClient();
      await client.rememberJob(HIRED_AGENT_ID, CONTRACT, RECORD);
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("throws MemoryToolRejectedError immediately on a real rejection — no reconcile re-read", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "CAP_EXCEEDED" }, true));
      const client = new SibylMemoryClient();
      await expect(client.rememberJob(HIRED_AGENT_ID, CONTRACT, RECORD)).rejects.toBeInstanceOf(MemoryToolRejectedError);
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("on a transport-level failure, re-reads first: if the write already landed, does not blindly resend", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("pipe broke mid-write"))
        .mockResolvedValueOnce(textResult({ entity: { body: RECORD } })); // reconcile recall finds it already there
      const client = new SibylMemoryClient();
      await client.rememberJob(HIRED_AGENT_ID, CONTRACT, RECORD);
      expect(callToolMock).toHaveBeenCalledTimes(2); // write attempt + reconcile recall, no resend
    });

    it("on a transport-level failure, resends once the reconcile re-read confirms it's still missing", async () => {
      const staleRecord = { ...RECORD, checked_at: "2020-01-01T00:00:00.000Z" };
      callToolMock
        .mockRejectedValueOnce(new Error("pipe broke mid-write"))
        .mockResolvedValueOnce(textResult({ entity: { body: staleRecord } })) // reconcile recall: stale, not the fresh write
        .mockResolvedValueOnce(textResult({ ok: true })); // resend succeeds
      const client = new SibylMemoryClient();
      await client.rememberJob(HIRED_AGENT_ID, CONTRACT, RECORD);
      expect(callToolMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("wasPaymentConsumed", () => {
    const TX_HASH: `0x${string}` = "0xpaid";

    it("returns true when a record exists for that tx hash", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ entity: { body: { consumed_at: "now" } } }));
      const client = new SibylMemoryClient();
      expect(await client.wasPaymentConsumed(TX_HASH)).toBe(true);
    });

    it("returns false on a NOT_FOUND rejection, without retrying", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "NOT_FOUND" }, true));
      const client = new SibylMemoryClient();
      expect(await client.wasPaymentConsumed(TX_HASH)).toBe(false);
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("throws MemoryToolRejectedError on a real (non-NOT_FOUND) rejection", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "VALIDATION_ERROR" }, true));
      const client = new SibylMemoryClient();
      await expect(client.wasPaymentConsumed(TX_HASH)).rejects.toBeInstanceOf(MemoryToolRejectedError);
    });

    it("retries a transport-level failure", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("stdio pipe closed"))
        .mockResolvedValueOnce(textResult({ entity: { body: {} } }));
      const client = new SibylMemoryClient();
      expect(await client.wasPaymentConsumed(TX_HASH)).toBe(true);
      expect(callToolMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("markPaymentConsumed", () => {
    const TX_HASH: `0x${string}` = "0xpaid";

    it("writes successfully on the first attempt", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ ok: true }));
      const client = new SibylMemoryClient();
      await client.markPaymentConsumed(TX_HASH, { contract: "0xabc" });
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("throws MemoryToolRejectedError on a rejection — no retry, this is the entire replay-protection guarantee", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "VALIDATION_ERROR" }, true));
      const client = new SibylMemoryClient();
      await expect(client.markPaymentConsumed(TX_HASH, {})).rejects.toBeInstanceOf(MemoryToolRejectedError);
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("on a transport-level failure, re-reads first: if the write already landed, does not blindly resend", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("pipe broke mid-write"))
        .mockResolvedValueOnce(textResult({ entity: { body: { contract: "0xabc" } } })); // reconcile recall finds it already there
      const client = new SibylMemoryClient();
      await client.markPaymentConsumed(TX_HASH, { contract: "0xabc" });
      expect(callToolMock).toHaveBeenCalledTimes(2); // write attempt + reconcile recall, no resend
    });

    it("on a transport-level failure, resends once the reconcile re-read confirms it's still missing", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("pipe broke mid-write"))
        .mockResolvedValueOnce(textResult({ code: "NOT_FOUND" }, true)) // reconcile recall: not there yet
        .mockResolvedValueOnce(textResult({ ok: true })); // resend succeeds
      const client = new SibylMemoryClient();
      await client.markPaymentConsumed(TX_HASH, { contract: "0xabc" });
      expect(callToolMock).toHaveBeenCalledTimes(3);
    });

    // Regression guard: without the reconcile above, a transport failure
    // right after a write that had actually landed would leave the caller's
    // payment silently consumed with no tier ever delivered — the resend
    // path (or blind non-retry) risks exactly the double-spend/no-answer
    // gap replay protection exists to prevent.
  });

  describe("recordEvent", () => {
    it("never retries on a transport-level failure — journal writes have no idempotency key", async () => {
      callToolMock.mockRejectedValueOnce(new Error("pipe broke"));
      const client = new SibylMemoryClient();
      await expect(
        client.recordEvent("decision", {}, { category: "token_verdict", name: CONTRACT }),
      ).rejects.toThrow("pipe broke");
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("throws MemoryToolRejectedError on a real rejection", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "VALIDATION_ERROR" }, true));
      const client = new SibylMemoryClient();
      await expect(
        client.recordEvent("decision", {}, { category: "token_verdict", name: CONTRACT }),
      ).rejects.toBeInstanceOf(MemoryToolRejectedError);
    });
  });

  describe("getPendingEscalation", () => {
    it("returns the parsed requestId/fromBlock as bigints on a successful recall", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ entity: { body: { requestId: "42", fromBlock: "1000" } } }));
      const client = new SibylMemoryClient();
      const result = await client.getPendingEscalation(HIRED_AGENT_ID, CONTRACT);
      expect(result).toEqual({ requestId: 42n, fromBlock: 1000n });
    });

    it("returns null on a NOT_FOUND rejection, without retrying", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "NOT_FOUND" }, true));
      const client = new SibylMemoryClient();
      expect(await client.getPendingEscalation(HIRED_AGENT_ID, CONTRACT)).toBeNull();
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("throws MemoryToolRejectedError on a real (non-NOT_FOUND) rejection", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "VALIDATION_ERROR" }, true));
      const client = new SibylMemoryClient();
      await expect(client.getPendingEscalation(HIRED_AGENT_ID, CONTRACT)).rejects.toBeInstanceOf(MemoryToolRejectedError);
    });

    it("retries a transport-level failure", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("stdio pipe closed"))
        .mockResolvedValueOnce(textResult({ entity: { body: { requestId: "1", fromBlock: "2" } } }));
      const client = new SibylMemoryClient();
      expect(await client.getPendingEscalation(HIRED_AGENT_ID, CONTRACT)).toEqual({ requestId: 1n, fromBlock: 2n });
      expect(callToolMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("setPendingEscalation", () => {
    it("writes successfully on the first attempt, serializing bigints as strings", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ ok: true }));
      const client = new SibylMemoryClient();
      await client.setPendingEscalation(HIRED_AGENT_ID, CONTRACT, 42n, 1000n);
      expect(callToolMock).toHaveBeenCalledTimes(1);
      const [sentCall] = callToolMock.mock.calls as [{ name: string; arguments: { body: unknown } }][];
      expect(sentCall?.[0].name).toBe("memory_remember");
      expect(sentCall?.[0].arguments.body).toEqual({ requestId: "42", fromBlock: "1000" });
    });

    it("throws MemoryToolRejectedError immediately on a real rejection — no reconcile re-read", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "CAP_EXCEEDED" }, true));
      const client = new SibylMemoryClient();
      await expect(client.setPendingEscalation(HIRED_AGENT_ID, CONTRACT, 42n, 1000n)).rejects.toBeInstanceOf(MemoryToolRejectedError);
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("on a transport-level failure, re-reads first: if the write already landed, does not blindly resend", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("pipe broke mid-write"))
        .mockResolvedValueOnce(textResult({ entity: { body: { requestId: "42", fromBlock: "1000" } } }));
      const client = new SibylMemoryClient();
      await client.setPendingEscalation(HIRED_AGENT_ID, CONTRACT, 42n, 1000n);
      expect(callToolMock).toHaveBeenCalledTimes(2);
    });

    it("on a transport-level failure, resends once the reconcile re-read confirms it's still missing", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("pipe broke mid-write"))
        .mockResolvedValueOnce(textResult({ code: "NOT_FOUND" }, true))
        .mockResolvedValueOnce(textResult({ ok: true }));
      const client = new SibylMemoryClient();
      await client.setPendingEscalation(HIRED_AGENT_ID, CONTRACT, 42n, 1000n);
      expect(callToolMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("clearPendingEscalation", () => {
    it("clears successfully on the first attempt", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ ok: true, archived: { category: "pending_escalation", name: CONTRACT } }));
      const client = new SibylMemoryClient();
      await client.clearPendingEscalation(HIRED_AGENT_ID, CONTRACT);
      expect(callToolMock).toHaveBeenCalledTimes(1);
    });

    it("treats a NOT_FOUND rejection as a successful no-op — already cleared", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "NOT_FOUND" }, true));
      const client = new SibylMemoryClient();
      await expect(client.clearPendingEscalation(HIRED_AGENT_ID, CONTRACT)).resolves.toBeUndefined();
    });

    it("throws MemoryToolRejectedError on a real (non-NOT_FOUND) rejection", async () => {
      callToolMock.mockResolvedValueOnce(textResult({ code: "VALIDATION_ERROR" }, true));
      const client = new SibylMemoryClient();
      await expect(client.clearPendingEscalation(HIRED_AGENT_ID, CONTRACT)).rejects.toBeInstanceOf(MemoryToolRejectedError);
    });

    it("retries a transport-level failure — without this, a stale pending-escalation record could block real payments forever", async () => {
      callToolMock
        .mockRejectedValueOnce(new Error("stdio pipe closed"))
        .mockResolvedValueOnce(textResult({ ok: true, archived: { category: "pending_escalation", name: CONTRACT } }));
      const client = new SibylMemoryClient();
      await expect(client.clearPendingEscalation(HIRED_AGENT_ID, CONTRACT)).resolves.toBeUndefined();
      expect(callToolMock).toHaveBeenCalledTimes(2);
    });
  });
});
