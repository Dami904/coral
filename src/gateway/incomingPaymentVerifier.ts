import { createPublicClient, http, parseEventLogs, type Address, type Chain } from "viem";
import type { IncomingPaymentPort, IncomingPaymentVerification } from "../types.js";
import { withRetry } from "../lib/retry.js";

const READ_RETRY = { maxAttempts: 3, baseDelayMs: 200 };

const USDC_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

const SPEND_GUARD_USDC_ABI = [
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export type IncomingPaymentVerifierConfig = {
  rpcUrl: string;
  guardAddress: Address;
  chain: Chain;
};

/**
 * Direction B's payment check: reads the real mined receipt for a
 * caller-supplied tx hash and decodes the USDC Transfer event from it —
 * never trusts the claim, never reads a balance snapshot (a snapshot
 * can't prove *this specific* transfer happened, and could double-count
 * one deposit across two requests).
 *
 * The recipient is always the deployed SpendGuard contract's own address
 * (this.guardAddress) — not a separate wallet. That's deliberate: it's
 * the exact treasury SpendGuard already policy-gates on the way out, so
 * accepting gateway fees there introduces no new fund-holding authority
 * (see PLAN.md's "Gateway direction" entry and docs/THREAT_MODEL.md).
 * The USDC token address itself is read from SpendGuard's own public
 * `usdc` immutable rather than configured separately, so this can never
 * drift from what the deployed contract actually accepts.
 */
export class SpendGuardIncomingPaymentVerifier implements IncomingPaymentPort {
  private readonly publicClient;
  private readonly guardAddress: Address;
  private usdcAddressCache: Address | null = null;

  constructor(config: IncomingPaymentVerifierConfig) {
    this.publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
    this.guardAddress = config.guardAddress;
  }

  private async getUsdcAddress(): Promise<Address> {
    if (this.usdcAddressCache) return this.usdcAddressCache;
    const address = await withRetry(
      () =>
        this.publicClient.readContract({
          address: this.guardAddress,
          abi: SPEND_GUARD_USDC_ABI,
          functionName: "usdc",
        }),
      { ...READ_RETRY, isRetryable: () => true },
    );
    this.usdcAddressCache = address;
    return address;
  }

  async verifyPayment(txHash: `0x${string}`, minAmount: bigint): Promise<IncomingPaymentVerification> {
    const usdcAddress = await this.getUsdcAddress();

    let receipt;
    try {
      receipt = await withRetry(
        () => this.publicClient.getTransactionReceipt({ hash: txHash }),
        { ...READ_RETRY, isRetryable: () => true },
      );
    } catch (err) {
      // Includes "not found" (never mined / wrong hash) and exhausted
      // retries on a genuinely flaky RPC — both are safe to report as
      // not_found to the caller here: nothing has been marked consumed
      // yet, so they can simply resend the same claim once the tx is
      // actually visible. Logged server-side regardless, since the RPC
      // case is a real ops signal a "your payment is missing" reply would
      // otherwise hide.
      console.error("verifyPayment: getTransactionReceipt failed (not-found or exhausted retries) — reporting not_found", {
        txHash,
        err,
      });
      return { kind: "not_found" };
    }
    if (receipt.status !== "success") {
      return { kind: "not_found" };
    }

    const transfers = parseEventLogs({ abi: [USDC_TRANSFER_EVENT], logs: receipt.logs }).filter(
      (log) =>
        log.address.toLowerCase() === usdcAddress.toLowerCase() &&
        log.args.to.toLowerCase() === this.guardAddress.toLowerCase(),
    );

    const [first] = transfers;
    if (!first) {
      return { kind: "wrong_recipient" };
    }

    const totalToGuard = transfers.reduce((sum, log) => sum + log.args.value, 0n);
    if (totalToGuard < minAmount) {
      return { kind: "insufficient", amount: totalToGuard };
    }

    return { kind: "valid", payer: first.args.from, amount: totalToGuard };
  }
}
