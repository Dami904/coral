import { createPublicClient, createWalletClient, http, parseEventLogs, type Address, type Chain } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { ChainPort, PaymentOutcome, PendingResolution, ResumableChainPort } from "../types.js";
import { TransactionStatusUnknownError } from "../types.js";
import { withRetry } from "../lib/retry.js";

const PRE_BROADCAST_RETRY = { maxAttempts: 3, baseDelayMs: 200 };
const RECEIPT_POLL_RETRY = { maxAttempts: 3, baseDelayMs: 2000 };
const READ_RETRY = { maxAttempts: 3, baseDelayMs: 200 };

// Individual event items, defined separately (not just inline in
// SPEND_GUARD_ABI) so getLogs({ event: ... }) below gets viem's strongly
// typed single-event overload — using { abi, eventName } instead resolves
// to a looser overload that doesn't type `args`/log fields precisely.
const PAYMENT_SENT_EVENT = {
  type: "event",
  name: "PaymentSent",
  inputs: [
    { name: "payTo", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
} as const;

const PAYMENT_BLOCKED_EVENT = {
  type: "event",
  name: "PaymentBlocked",
  inputs: [
    { name: "payTo", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "reason", type: "string", indexed: false },
  ],
} as const;

const PAYMENT_PENDING_EVENT = {
  type: "event",
  name: "PaymentPending",
  inputs: [
    { name: "requestId", type: "uint256", indexed: true },
    { name: "payTo", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
} as const;

const PAYMENT_APPROVED_EVENT = {
  type: "event",
  name: "PaymentApproved",
  inputs: [{ name: "requestId", type: "uint256", indexed: true }],
} as const;

const PAYMENT_REJECTED_EVENT = {
  type: "event",
  name: "PaymentRejected",
  inputs: [{ name: "requestId", type: "uint256", indexed: true }],
} as const;

export const SPEND_GUARD_ABI = [
  {
    type: "function",
    name: "requestPayment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payTo", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "sentImmediately", type: "bool" },
      { name: "requestId", type: "uint256" },
    ],
  },
  PAYMENT_SENT_EVENT,
  PAYMENT_BLOCKED_EVENT,
  PAYMENT_PENDING_EVENT,
  {
    type: "function",
    name: "ownerApprove",
    stateMutability: "nonpayable",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [],
  },
  PAYMENT_APPROVED_EVENT,
  PAYMENT_REJECTED_EVENT,
  {
    type: "function",
    name: "pending",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "payTo", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "exists", type: "bool" },
      { name: "approved", type: "bool" },
    ],
  },
] as const;

export type SpendGuardClientConfig = {
  rpcUrl: string;
  guardAddress: Address;
  agentPrivateKey: `0x${string}`;
  /** Defaults to Base Sepolia. Pass viem's `base` for a mainnet deployment. */
  chain?: Chain;
};

/**
 * The mined tx's decoded event is the sole source of truth for the
 * outcome — never the eth_call/simulation return value, which can go
 * stale between simulate and mine. See docs/API_NOTES.md.
 */
export class SpendGuardChainClient implements ChainPort, ResumableChainPort {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account: PrivateKeyAccount;
  private readonly guardAddress: Address;
  private readonly chain: Chain;

  constructor(config: SpendGuardClientConfig) {
    this.account = privateKeyToAccount(config.agentPrivateKey);
    this.chain = config.chain ?? baseSepolia;
    const transport = http(config.rpcUrl);
    this.publicClient = createPublicClient({ chain: this.chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain: this.chain, transport });
    this.guardAddress = config.guardAddress;
  }

  async requestPayment(payTo: `0x${string}`, amount: bigint): Promise<PaymentOutcome> {
    // Pin the nonce across the whole retry sequence below. A writeContract
    // failure does NOT reliably mean "nothing was sent" — the RPC node can
    // accept and broadcast the transaction while the response confirming
    // that is what gets lost (timeout/connection drop). Without a pinned
    // nonce, a retry would fetch a FRESH "pending" nonce and sign a SECOND,
    // independently valid transaction: a real double-payment, not a
    // theoretical one, since this moves real funds. With one nonce pinned
    // across every attempt, only one transaction can ever be mined for it —
    // a retry after a real-but-lost-response send is rejected by the
    // network (nonce collision) instead of silently creating a second
    // valid payment.
    const nonce = await this.publicClient.getTransactionCount({
      address: this.account.address,
      blockTag: "pending",
    });

    const txHash = await withRetry(
      () =>
        this.walletClient.writeContract({
          address: this.guardAddress,
          abi: SPEND_GUARD_ABI,
          functionName: "requestPayment",
          args: [payTo, amount],
          chain: this.chain,
          account: this.account,
          nonce,
        }),
      { ...PRE_BROADCAST_RETRY, isRetryable: () => true },
    );

    // Once a hash exists, NEVER resend — only retry polling for the receipt
    // of this exact hash. A dropped/slow RPC connection here is UNKNOWN, not
    // FAILED: the tx may still be pending. Exhausting retries surfaces a
    // TransactionStatusUnknownError rather than assuming failure.
    let receipt;
    try {
      receipt = await withRetry(
        () => this.publicClient.waitForTransactionReceipt({ hash: txHash }),
        { ...RECEIPT_POLL_RETRY, isRetryable: () => true },
      );
    } catch (err) {
      throw new TransactionStatusUnknownError(txHash, err);
    }
    if (receipt.status !== "success") {
      throw new Error(`requestPayment tx ${txHash} reverted on-chain (status=${receipt.status})`);
    }

    const events = parseEventLogs({ abi: SPEND_GUARD_ABI, logs: receipt.logs });

    const sent = events.find((e) => e.eventName === "PaymentSent");
    if (sent) {
      return { kind: "sent", payTo, amount: sent.args.amount, txHash };
    }
    const blocked = events.find((e) => e.eventName === "PaymentBlocked");
    if (blocked) {
      return { kind: "blocked", payTo, amount: blocked.args.amount, reason: blocked.args.reason };
    }
    const pending = events.find((e) => e.eventName === "PaymentPending");
    if (pending) {
      return {
        kind: "pending",
        payTo,
        amount: pending.args.amount,
        requestId: pending.args.requestId,
        txHash,
        blockNumber: receipt.blockNumber,
      };
    }

    throw new Error(
      `requestPayment tx ${txHash} mined successfully but emitted none of ` +
        "PaymentSent/PaymentBlocked/PaymentPending — unexpected SpendGuard state, do not assume a safe outcome",
    );
  }

  /**
   * Never reads SpendGuard.pending(requestId) — that read has a documented
   * history of returning stale data immediately after a write, on Base
   * Sepolia's public multi-node RPC (docs/API_NOTES.md's Day 8 note).
   * "still_pending" here just means "no resolving event visible yet," which
   * is always a safe thing to report (the next poll cycle tries again) —
   * unlike trusting a stale state read as a final answer. Once a resolving
   * event IS found, it's trusted the same way a receipt is trusted
   * elsewhere in this client.
   */
  async checkPendingResolution(requestId: bigint, fromBlock: bigint): Promise<PendingResolution> {
    const getLogsWithRetry = <T>(fn: () => Promise<T>) => withRetry(fn, { ...READ_RETRY, isRetryable: () => true });

    const [rejectedLogs, approvedLogs] = await Promise.all([
      getLogsWithRetry(() =>
        this.publicClient.getLogs({
          address: this.guardAddress,
          event: PAYMENT_REJECTED_EVENT,
          args: { requestId },
          fromBlock,
        }),
      ),
      getLogsWithRetry(() =>
        this.publicClient.getLogs({
          address: this.guardAddress,
          event: PAYMENT_APPROVED_EVENT,
          args: { requestId },
          fromBlock,
        }),
      ),
    ]);

    const [rejectedLog] = rejectedLogs;
    if (rejectedLog) {
      return { kind: "rejected", txHash: rejectedLog.transactionHash };
    }

    const [approveLog] = approvedLogs;
    if (approveLog) {
      // ownerApprove's mined receipt emits BOTH PaymentApproved and
      // PaymentSent in the same transaction — read PaymentSent from that
      // exact transaction rather than re-deriving payTo/amount elsewhere.
      const sentLogs = await getLogsWithRetry(() =>
        this.publicClient.getLogs({
          address: this.guardAddress,
          event: PAYMENT_SENT_EVENT,
          fromBlock: approveLog.blockNumber,
          toBlock: approveLog.blockNumber,
        }),
      );
      const sent = sentLogs.find((l) => l.transactionHash === approveLog.transactionHash);
      if (!sent || sent.args.amount === undefined || sent.args.payTo === undefined) {
        throw new Error(
          `PaymentApproved for request ${requestId.toString()} (tx ${approveLog.transactionHash}) had no ` +
            "decodable matching PaymentSent in the same transaction — unexpected SpendGuard state",
        );
      }
      return { kind: "approved", txHash: approveLog.transactionHash, amount: sent.args.amount, payTo: sent.args.payTo };
    }

    return { kind: "still_pending" };
  }
}
