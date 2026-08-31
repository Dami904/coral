import { beforeEach, describe, expect, it, vi } from "vitest";

const { writeContractMock, waitForReceiptMock, getLogsMock, parseEventLogsMock, getTransactionCountMock } = vi.hoisted(
  () => ({
    writeContractMock: vi.fn(),
    waitForReceiptMock: vi.fn(),
    getLogsMock: vi.fn(),
    parseEventLogsMock: vi.fn(),
    getTransactionCountMock: vi.fn(async () => 0),
  }),
);

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      waitForTransactionReceipt: waitForReceiptMock,
      getLogs: getLogsMock,
      getTransactionCount: getTransactionCountMock,
    })),
    createWalletClient: vi.fn(() => ({
      writeContract: writeContractMock,
    })),
    parseEventLogs: parseEventLogsMock,
  };
});

import { SpendGuardChainClient } from "../../src/chain/spendGuardClient.js";
import { TransactionStatusUnknownError } from "../../src/types.js";

const GUARD: `0x${string}` = "0x000000000000000000000000000000000000ea";
const VENDOR: `0x${string}` = "0x0000000000000000000000000000000000dead";
const AGENT_KEY: `0x${string}` = `0x${"1".repeat(64)}`;

function makeClient(): SpendGuardChainClient {
  return new SpendGuardChainClient({ rpcUrl: "http://127.0.0.1:0", guardAddress: GUARD, agentPrivateKey: AGENT_KEY });
}

/** Routes getLogs calls by the event name being queried, with a scripted
 * sequence of responses per name (throw or return) so a specific call can
 * fail once and succeed on retry without affecting the others. */
function makeGetLogsRouter(script: Record<string, Array<unknown[] | Error>>) {
  const counters: Record<string, number> = {};
  return vi.fn(async (args: { event: { name: string } }) => {
    const key = args.event.name;
    const i = counters[key] ?? 0;
    counters[key] = i + 1;
    const entries = script[key] ?? [[]];
    const entry = entries[Math.min(i, entries.length - 1)] ?? [];
    if (entry instanceof Error) throw entry;
    return entry;
  });
}

beforeEach(() => {
  writeContractMock.mockReset();
  waitForReceiptMock.mockReset();
  getLogsMock.mockReset();
  parseEventLogsMock.mockReset();
  getTransactionCountMock.mockReset().mockResolvedValue(0);
});

describe("SpendGuardChainClient.requestPayment", () => {
  it("retries a pre-broadcast writeContract failure and succeeds", async () => {
    writeContractMock.mockRejectedValueOnce(new Error("connection refused")).mockResolvedValueOnce("0xhash");
    waitForReceiptMock.mockResolvedValueOnce({ status: "success", logs: [], blockNumber: 10n });
    parseEventLogsMock.mockReturnValueOnce([{ eventName: "PaymentSent", args: { amount: 5_000n } }]);

    const client = makeClient();
    const result = await client.requestPayment(VENDOR, 5_000n);

    expect(result).toEqual({ kind: "sent", payTo: VENDOR, amount: 5_000n, txHash: "0xhash" });
    expect(writeContractMock).toHaveBeenCalledTimes(2);
  });

  it("pins one nonce across every writeContract retry attempt — never fetches a fresh one per attempt", async () => {
    // Regression guard: a network failure can occur AFTER a transaction
    // actually broadcasts (the response is what gets lost), not only
    // before. If each retry fetched a fresh "pending" nonce, that scenario
    // would sign and send a SECOND, independently valid transaction — a
    // real double-payment, since this moves real funds. Pinning one nonce
    // makes that structurally impossible: only one tx can ever be mined
    // for a given nonce.
    getTransactionCountMock.mockResolvedValueOnce(42);
    writeContractMock.mockRejectedValueOnce(new Error("response lost, tx may have broadcast")).mockResolvedValueOnce("0xhash");
    waitForReceiptMock.mockResolvedValueOnce({ status: "success", logs: [], blockNumber: 10n });
    parseEventLogsMock.mockReturnValueOnce([{ eventName: "PaymentSent", args: { amount: 5_000n } }]);

    const client = makeClient();
    await client.requestPayment(VENDOR, 5_000n);

    expect(getTransactionCountMock).toHaveBeenCalledTimes(1); // fetched once, not once per attempt
    expect(writeContractMock).toHaveBeenCalledTimes(2);
    const [firstCallArgs] = writeContractMock.mock.calls[0] as [{ nonce: number }];
    const [secondCallArgs] = writeContractMock.mock.calls[1] as [{ nonce: number }];
    expect(firstCallArgs.nonce).toBe(42);
    expect(secondCallArgs.nonce).toBe(42); // same nonce on retry, not re-fetched
  });

  it("never resends once a tx hash exists — only retries polling for the receipt", async () => {
    writeContractMock.mockResolvedValueOnce("0xhash");
    waitForReceiptMock.mockRejectedValue(new Error("RPC timeout"));

    const client = makeClient();
    await expect(client.requestPayment(VENDOR, 5_000n)).rejects.toBeInstanceOf(TransactionStatusUnknownError);

    expect(writeContractMock).toHaveBeenCalledTimes(1); // never resent
    expect(waitForReceiptMock).toHaveBeenCalledTimes(3); // exhausted retry (maxAttempts=3)
  });

  it("recovers if the receipt poll succeeds within the retry budget", async () => {
    writeContractMock.mockResolvedValueOnce("0xhash");
    waitForReceiptMock
      .mockRejectedValueOnce(new Error("RPC timeout"))
      .mockResolvedValueOnce({ status: "success", logs: [], blockNumber: 10n });
    parseEventLogsMock.mockReturnValueOnce([{ eventName: "PaymentBlocked", args: { amount: 5_000n, reason: "budget-window" } }]);

    const client = makeClient();
    const result = await client.requestPayment(VENDOR, 5_000n);

    expect(result).toEqual({ kind: "blocked", payTo: VENDOR, amount: 5_000n, reason: "budget-window" });
    expect(writeContractMock).toHaveBeenCalledTimes(1);
  });

  it("treats a reverted receipt as a real failure, not a retryable/unknown one", async () => {
    writeContractMock.mockResolvedValueOnce("0xhash");
    waitForReceiptMock.mockResolvedValueOnce({ status: "reverted", logs: [], blockNumber: 10n });

    const client = makeClient();
    await expect(client.requestPayment(VENDOR, 5_000n)).rejects.toThrow(/reverted on-chain/);
    expect(waitForReceiptMock).toHaveBeenCalledTimes(1); // not retried — this is FAILED, not UNKNOWN
  });

  it("returns a pending outcome with the receipt's blockNumber attached", async () => {
    writeContractMock.mockResolvedValueOnce("0xhash");
    waitForReceiptMock.mockResolvedValueOnce({ status: "success", logs: [], blockNumber: 77n });
    parseEventLogsMock.mockReturnValueOnce([
      { eventName: "PaymentPending", args: { amount: 300_000n, requestId: 3n } },
    ]);

    const client = makeClient();
    const result = await client.requestPayment(VENDOR, 300_000n);

    expect(result).toEqual({ kind: "pending", payTo: VENDOR, amount: 300_000n, requestId: 3n, txHash: "0xhash", blockNumber: 77n });
  });
});

describe("SpendGuardChainClient.checkPendingResolution", () => {
  it("returns still_pending when no resolving event is visible yet", async () => {
    getLogsMock.mockImplementation(makeGetLogsRouter({}));
    const client = makeClient();
    const result = await client.checkPendingResolution(5n, 10n);
    expect(result).toEqual({ kind: "still_pending" });
  });

  it("returns rejected when a PaymentRejected log is found, without querying PaymentSent", async () => {
    getLogsMock.mockImplementation(
      makeGetLogsRouter({ PaymentRejected: [[{ transactionHash: "0xrej" }]] }),
    );
    const client = makeClient();
    const result = await client.checkPendingResolution(5n, 10n);
    expect(result).toEqual({ kind: "rejected", txHash: "0xrej" });
  });

  it("returns approved with amount/payTo read from the matching PaymentSent in the same tx", async () => {
    getLogsMock.mockImplementation(
      makeGetLogsRouter({
        PaymentApproved: [[{ transactionHash: "0xapprove", blockNumber: 100n }]],
        PaymentSent: [[{ transactionHash: "0xapprove", args: { amount: 60_000n, payTo: VENDOR } }]],
      }),
    );
    const client = makeClient();
    const result = await client.checkPendingResolution(5n, 10n);
    expect(result).toEqual({ kind: "approved", txHash: "0xapprove", amount: 60_000n, payTo: VENDOR });
  });

  it("retries a transient getLogs failure on one query without affecting the other", async () => {
    getLogsMock.mockImplementation(
      makeGetLogsRouter({
        PaymentRejected: [new Error("RPC blip"), []],
        PaymentApproved: [[]],
      }),
    );
    const client = makeClient();
    const result = await client.checkPendingResolution(5n, 10n);
    expect(result).toEqual({ kind: "still_pending" });
  });

  it("throws if an approved request has no decodable matching PaymentSent — unexpected state, not swallowed", async () => {
    getLogsMock.mockImplementation(
      makeGetLogsRouter({
        PaymentApproved: [[{ transactionHash: "0xapprove", blockNumber: 100n }]],
        PaymentSent: [[]], // no matching log at all
      }),
    );
    const client = makeClient();
    await expect(client.checkPendingResolution(5n, 10n)).rejects.toThrow(/no decodable matching PaymentSent/);
  });
});
