import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInboxWithStatusMock, sendMessageMock, isRegisteredMock, registerMock } = vi.hoisted(() => ({
  getInboxWithStatusMock: vi.fn(),
  sendMessageMock: vi.fn(),
  isRegisteredMock: vi.fn(),
  registerMock: vi.fn(),
}));

vi.mock("ping-onchain", () => ({
  Ping: {
    fromPrivateKey: vi.fn(() => ({
      getInboxWithStatus: getInboxWithStatusMock,
      sendMessage: sendMessageMock,
      isRegistered: isRegisteredMock,
      register: registerMock,
    })),
  },
}));

import { PingChainClient } from "../../src/ping/pingChainClient.js";

const AGENT_KEY: `0x${string}` = `0x${"2".repeat(64)}`;
const SENDER: `0x${string}` = "0x0000000000000000000000000000000000a1a1";

function makeClient(): PingChainClient {
  return new PingChainClient({ privateKey: AGENT_KEY });
}

beforeEach(() => {
  getInboxWithStatusMock.mockReset();
  sendMessageMock.mockReset();
  isRegisteredMock.mockReset();
  registerMock.mockReset();
});

describe("PingChainClient.getInboxWithStatus", () => {
  it("returns the mapped inbox on success", async () => {
    getInboxWithStatusMock.mockResolvedValueOnce([
      {
        from: SENDER,
        to: "0x000000000000000000000000000000000000ea",
        content: "hi",
        block: 5n,
        transactionHash: "0xaa",
        isBroadcast: false,
        replied: false,
        replyBlock: null,
      },
    ]);
    const client = makeClient();
    const result = await client.getInboxWithStatus(0n);
    expect(result).toHaveLength(1);
    expect(result[0]?.from).toBe(SENDER);
  });

  it("retries a transient RPC failure and succeeds — reads are safe to blind-retry", async () => {
    getInboxWithStatusMock.mockRejectedValueOnce(new Error("RPC timeout")).mockResolvedValueOnce([]);
    const client = makeClient();
    const result = await client.getInboxWithStatus(0n);
    expect(result).toEqual([]);
    expect(getInboxWithStatusMock).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and rethrows if the RPC never recovers", async () => {
    getInboxWithStatusMock.mockRejectedValue(new Error("RPC down"));
    const client = makeClient();
    await expect(client.getInboxWithStatus(0n)).rejects.toThrow("RPC down");
    expect(getInboxWithStatusMock).toHaveBeenCalledTimes(3);
  });
});

describe("PingChainClient.sendReply", () => {
  it("never retries — a lost response after a real send would mean sending twice", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("RPC timeout"));
    const client = makeClient();
    await expect(client.sendReply(SENDER, "hello")).rejects.toThrow("RPC timeout");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("returns the tx hash on success", async () => {
    sendMessageMock.mockResolvedValueOnce({ hash: "0xreply", receipt: {} });
    const client = makeClient();
    const result = await client.sendReply(SENDER, "hello");
    expect(result).toEqual({ txHash: "0xreply" });
  });
});
