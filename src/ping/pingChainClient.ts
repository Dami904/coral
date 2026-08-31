import { Ping } from "ping-onchain";
import { privateKeyToAccount } from "viem/accounts";
import type { PingMessage, PingPort } from "../types.js";
import { withRetry } from "../lib/retry.js";

const READ_RETRY = { maxAttempts: 3, baseDelayMs: 500 };

export type PingChainClientConfig = {
  privateKey: `0x${string}`;
  /** Defaults to ping-onchain's own default (Base mainnet public RPC). */
  rpcUrl?: string;
};

/**
 * Real ping-onchain adapter. Mainnet-only (see docs/API_NOTES.md) — every
 * call here is real, irreversible, public spend. Registration is a
 * separate one-time concern (see ensureRegistered / scripts/live-ping-*),
 * not part of the per-cycle PingPort contract.
 */
export class PingChainClient implements PingPort {
  private readonly ping: Ping;
  readonly address: `0x${string}`;

  constructor(config: PingChainClientConfig) {
    this.address = privateKeyToAccount(config.privateKey).address;
    this.ping = Ping.fromPrivateKey(config.privateKey, config.rpcUrl ? { rpcUrl: config.rpcUrl } : {});
  }

  async getInboxWithStatus(fromBlock: bigint): Promise<PingMessage[]> {
    // A read — safe to blind-retry on a transient RPC failure (timeout,
    // connection drop). No three-state writeup existed for Ping before this
    // (docs/API_NOTES.md flagged it as "not yet verified"); classifying
    // reads this way mirrors every other port in this codebase.
    const raw = await withRetry(
      () => this.ping.getInboxWithStatus({ address: this.address, fromBlock }),
      { ...READ_RETRY, isRetryable: () => true },
    );
    return raw.map((m) => ({
      from: m.from,
      to: m.to,
      content: m.content,
      block: m.block,
      transactionHash: m.transactionHash,
      isBroadcast: m.isBroadcast,
      replied: m.replied ?? null,
      replyBlock: m.replyBlock ?? null,
    }));
  }

  /**
   * Deliberately no retry: this is real, mainnet, irreversible spend (see
   * docs/API_NOTES.md), and unlike X402IntelligenceClient there's no
   * client-visible idempotency key to make a blind resend safe — a lost
   * response after a message that actually landed would mean sending it
   * twice. On an UNKNOWN failure this throws and lets it surface as-is;
   * pollOnce.ts's existing per-message try/catch means one failed reply
   * never stops the others, and the next poll cycle can try again fresh.
   */
  async sendReply(to: `0x${string}`, content: string): Promise<{ txHash: `0x${string}` }> {
    const result = await this.ping.sendMessage(to, content);
    return { txHash: result.hash };
  }

  async isRegistered(): Promise<boolean> {
    return this.ping.isRegistered(this.address);
  }

  /** One-time setup, not part of the recurring poll loop. Costs real gas. */
  async register(username: string): Promise<{ txHash: `0x${string}` }> {
    const result = await this.ping.register(username);
    return { txHash: result.hash };
  }
}
