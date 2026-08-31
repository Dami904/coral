import { beforeEach, describe, expect, it, vi } from "vitest";

const { getTransactionReceiptMock, readContractMock, parseEventLogsMock } = vi.hoisted(() => ({
  getTransactionReceiptMock: vi.fn(),
  readContractMock: vi.fn(),
  parseEventLogsMock: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getTransactionReceipt: getTransactionReceiptMock,
      readContract: readContractMock,
    })),
    parseEventLogs: parseEventLogsMock,
  };
});

import { baseSepolia } from "viem/chains";
import { SpendGuardIncomingPaymentVerifier } from "../../src/gateway/incomingPaymentVerifier.js";

const GUARD: `0x${string}` = "0x000000000000000000000000000000000000ea";
const USDC: `0x${string}` = "0x000000000000000000000000000000000000cc";
const PAYER: `0x${string}` = "0x0000000000000000000000000000000000c411";
const TX_HASH: `0x${string}` = "0xpaid";
const FEE = 500_000n;

function makeVerifier(): SpendGuardIncomingPaymentVerifier {
  return new SpendGuardIncomingPaymentVerifier({ rpcUrl: "http://127.0.0.1:0", guardAddress: GUARD, chain: baseSepolia });
}

beforeEach(() => {
  getTransactionReceiptMock.mockReset();
  readContractMock.mockReset().mockResolvedValue(USDC);
  parseEventLogsMock.mockReset();
});

describe("SpendGuardIncomingPaymentVerifier.verifyPayment", () => {
  it("returns not_found when the tx receipt can't be fetched", async () => {
    getTransactionReceiptMock.mockRejectedValue(new Error("not found"));

    const result = await makeVerifier().verifyPayment(TX_HASH, FEE);

    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns not_found when the tx reverted", async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: "reverted", logs: [] });

    const result = await makeVerifier().verifyPayment(TX_HASH, FEE);

    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns wrong_recipient when no USDC Transfer to the guard address is present", async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: "success", logs: [] });
    parseEventLogsMock.mockReturnValue([
      { address: USDC, args: { from: PAYER, to: "0x000000000000000000000000000000000000ff", value: FEE } },
    ]);

    const result = await makeVerifier().verifyPayment(TX_HASH, FEE);

    expect(result).toEqual({ kind: "wrong_recipient" });
  });

  it("ignores a Transfer event from a different token contract even if it's addressed to the guard", async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: "success", logs: [] });
    parseEventLogsMock.mockReturnValue([
      { address: "0x000000000000000000000000000000000000ee", args: { from: PAYER, to: GUARD, value: FEE } },
    ]);

    const result = await makeVerifier().verifyPayment(TX_HASH, FEE);

    expect(result).toEqual({ kind: "wrong_recipient" });
  });

  it("returns insufficient with the observed total when the transferred amount is below minAmount", async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: "success", logs: [] });
    parseEventLogsMock.mockReturnValue([{ address: USDC, args: { from: PAYER, to: GUARD, value: 100_000n } }]);

    const result = await makeVerifier().verifyPayment(TX_HASH, FEE);

    expect(result).toEqual({ kind: "insufficient", amount: 100_000n });
  });

  it("returns valid with the payer and amount when a matching Transfer covers minAmount", async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: "success", logs: [] });
    parseEventLogsMock.mockReturnValue([{ address: USDC, args: { from: PAYER, to: GUARD, value: FEE } }]);

    const result = await makeVerifier().verifyPayment(TX_HASH, FEE);

    expect(result).toEqual({ kind: "valid", payer: PAYER, amount: FEE });
  });

  it("sums multiple matching Transfer events in the same receipt rather than only reading the first", async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: "success", logs: [] });
    parseEventLogsMock.mockReturnValue([
      { address: USDC, args: { from: PAYER, to: GUARD, value: 200_000n } },
      { address: USDC, args: { from: PAYER, to: GUARD, value: 300_000n } },
    ]);

    const result = await makeVerifier().verifyPayment(TX_HASH, FEE);

    expect(result).toEqual({ kind: "valid", payer: PAYER, amount: FEE });
  });

  it("reads the USDC address from the guard contract only once across repeated calls", async () => {
    getTransactionReceiptMock.mockResolvedValue({ status: "success", logs: [] });
    parseEventLogsMock.mockReturnValue([{ address: USDC, args: { from: PAYER, to: GUARD, value: FEE } }]);

    const verifier = makeVerifier();
    await verifier.verifyPayment(TX_HASH, FEE);
    await verifier.verifyPayment(TX_HASH, FEE);

    expect(readContractMock).toHaveBeenCalledTimes(1);
  });
});
