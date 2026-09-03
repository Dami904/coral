/**
 * Shared setup boilerplate for the `live:*` scripts (scripts/live-*.ts).
 * Every one of these harnesses is not part of `pnpm test` — each needs a
 * funded wallet and/or a live external service, per CLAUDE.md's `live:`
 * naming rule — but they all wired up the same handful of things
 * independently: a SpendGuardChainClient, a SibylMemoryClient, a clean
 * local memory DB, and (for the escalation harnesses) an owner wallet plus
 * a retried ownerApprove call. Centralized here so a fix to one of those
 * (e.g. the retry wrapper added below) reaches every script that needs it,
 * instead of drifting between copies.
 */
import { createServer } from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEventLogs, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { loadConfig } from "../../src/config.js";
import { SpendGuardChainClient, SPEND_GUARD_ABI } from "../../src/chain/spendGuardClient.js";
import { SibylMemoryClient } from "../../src/memory/sibylMemoryClient.js";
import { withRetry } from "../../src/lib/retry.js";
import { requestHandler } from "../../mock-x402-server/server.mjs";

export type LiveConfig = ReturnType<typeof loadConfig>;

/** Deletes a pre-existing local memory DB so a harness starts from a known
 * cold state. No-ops if memoryDbPath isn't set or the file doesn't exist —
 * callers that must not run without a project-local path (live-deletion-test.ts,
 * which deletes the DB again mid-run) check that themselves first. */
export function resetMemoryDb(config: LiveConfig, label: string): void {
  if (config.memoryDbPath && existsSync(config.memoryDbPath)) {
    unlinkSync(config.memoryDbPath);
    console.log(`[${label}] deleted pre-existing ${config.memoryDbPath} for a clean run`);
  }
}

export function makeChainClient(config: LiveConfig): SpendGuardChainClient {
  return new SpendGuardChainClient({
    rpcUrl: config.rpcUrl,
    guardAddress: config.guardAddress,
    agentPrivateKey: config.agentPrivateKey,
    chain: config.chain,
  });
}

export function makeMemoryClient(config: LiveConfig): SibylMemoryClient {
  return new SibylMemoryClient({
    command: config.memoryMcpCommand,
    ...(config.memoryDbPath ? { env: { ...process.env, SIBYL_MEMORY_DB: config.memoryDbPath } } : {}),
  });
}

export type MockX402Server = { endpoint: string; close: () => Promise<void> };

/** Starts mock-x402-server's real request handler on an ephemeral local
 * port — free, no mainnet spend, used by every harness that needs a real
 * HTTP directTx/X-PAYMENT-TX round trip without a real Sibyl payment. */
export async function startMockX402Server(): Promise<MockX402Server> {
  const server = createServer(requestHandler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return {
    endpoint: `http://127.0.0.1:${address.port.toString()}/api/evaluate`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export type OwnerClients = {
  publicClient: PublicClient;
  ownerAccount: PrivateKeyAccount;
  ownerWallet: WalletClient;
};

/** Builds the owner-key clients needed by ownerApprove/ownerReject demo
 * scripts. Throws if DEPLOYER_PRIVATE_KEY isn't set — every caller needs
 * it, so failing here beats each script re-checking it separately. */
export function makeOwnerClients(config: LiveConfig): OwnerClients {
  if (!config.deployerPrivateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY required (owner key — only it can call ownerApprove)");
  }
  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const ownerAccount = privateKeyToAccount(config.deployerPrivateKey);
  const ownerWallet = createWalletClient({ account: ownerAccount, chain: config.chain, transport: http(config.rpcUrl) });
  return { publicClient, ownerAccount, ownerWallet };
}

/**
 * Calls ownerApprove(requestId) and waits for the mined receipt, decoding
 * its events. Wrapped in withRetry: viem's pre-broadcast gas estimate
 * (an eth_call) can hit Base Sepolia's public multi-node RPC on a node
 * that hasn't yet seen the block the request was just created in, causing
 * a false "invalid request" revert on the very first attempt — confirmed
 * live, see docs/API_NOTES.md. Verification is receipt-only, never a
 * follow-up readContract call, for the same stale-routing reason.
 * Callers assert which events they need present (some check just
 * PaymentApproved, live-escalation-demo.ts also checks PaymentSent) —
 * this only guarantees the tx succeeded and returns the decoded set.
 */
export async function ownerApproveAndWait(config: LiveConfig, { ownerWallet, ownerAccount, publicClient }: OwnerClients, requestId: bigint) {
  const txHash = await withRetry(
    () =>
      ownerWallet.writeContract({
        address: config.guardAddress,
        abi: SPEND_GUARD_ABI,
        functionName: "ownerApprove",
        args: [requestId],
        chain: config.chain,
        account: ownerAccount,
      }),
    { maxAttempts: 5, baseDelayMs: 2000, isRetryable: () => true },
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`ownerApprove tx ${txHash} reverted (status=${receipt.status})`);
  }
  const events = parseEventLogs({ abi: SPEND_GUARD_ABI, logs: receipt.logs });
  return { txHash, events };
}
