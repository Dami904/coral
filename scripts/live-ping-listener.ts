/**
 * The real Day 6-7 entry point: polls Ping, runs the decision core per
 * message, replies. This is code, not a demo run — it is NOT executed by
 * this repo's automation and should not be run without deliberately
 * confirming the cost first (see the checks below and docs/API_NOTES.md's
 * Ping section).
 *
 * KNOWN GAP, discovered while wiring this: Ping has no testnet deployment
 * (docs/API_NOTES.md) — it only exists on Base mainnet. `SpendGuard` is
 * currently only deployed to Base Sepolia (PLAN.md Day 2). That means a
 * real inbound Ping message handled by this script would call
 * `requestPayment` against a Sepolia contract a mainnet Ping message can
 * never actually reach in a live demo — the two halves of the pipeline
 * are proven independently (Days 3-5) but not yet wired against each
 * other on the same chain. Before recording the real demo, either deploy
 * SpendGuard + a funded USDC balance to Base mainnet, or accept a staged
 * demo where the Ping leg and the payment leg are shown separately. This
 * choice needs a human decision, not a default baked in here.
 *
 * Run only after: the agent wallet is registered on Ping (real gas spend,
 * see PingChainClient.register), and you've decided which chain
 * SpendGuard should be paying on for this run.
 */
import { loadConfig } from "../src/config.js";
import { handleGatewayQuery, handleTokenQuery, resumeAfterApproval } from "../src/decisionCore.js";
import { SpendGuardChainClient } from "../src/chain/spendGuardClient.js";
import { SibylMemoryClient } from "../src/memory/sibylMemoryClient.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { PingChainClient } from "../src/ping/pingChainClient.js";
import { runPollLoop } from "../src/ping/pollLoop.js";
import { extractGatewayRequest } from "../src/ping/pollOnce.js";
import { SpendGuardIncomingPaymentVerifier } from "../src/gateway/incomingPaymentVerifier.js";

const POLL_INTERVAL_MS = 15_000;
const PRICE_USDC_6DP = 250_000n; // matches the real /api/evaluate price

async function main() {
  const config = loadConfig();

  const pingPrivateKey = process.env["AGENT_PRIVATE_KEY"];
  if (!pingPrivateKey) throw new Error("AGENT_PRIVATE_KEY required");

  const ping = new PingChainClient({ privateKey: pingPrivateKey as `0x${string}` });

  const registered = await ping.isRegistered();
  if (!registered) {
    throw new Error(
      `Agent wallet ${ping.address} is not registered on Ping. Registration is a one-time, real-gas ` +
        "mainnet transaction — run it deliberately (PingChainClient.register), not automatically from this loop.",
    );
  }

  const chain = new SpendGuardChainClient({
    rpcUrl: config.rpcUrl,
    guardAddress: config.guardAddress,
    agentPrivateKey: config.agentPrivateKey,
    chain: config.chain,
  });
  const memory = new SibylMemoryClient({
    command: config.memoryMcpCommand,
    ...(config.memoryDbPath
      ? { env: { ...process.env, SIBYL_MEMORY_DB: config.memoryDbPath } }
      : {}),
  });
  const intelligence = new X402IntelligenceClient({ endpointUrl: "https://sibylcap.com/api/evaluate" });
  // Direction B (gateway): reads SpendGuard's own `usdc` immutable to know
  // which token to check Transfer events against — see PLAN.md's "Gateway
  // direction" entry. The recipient is always the deployed SpendGuard
  // contract itself, never a separate wallet.
  const incomingPayment = new SpendGuardIncomingPaymentVerifier({
    rpcUrl: config.rpcUrl,
    guardAddress: config.guardAddress,
    chain: config.chain,
  });

  const startBlock = 0n; // TODO: resume from a real cursor before production use; see docs/LIMITATIONS.md

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  await runPollLoop(
    {
      ping,
      pollIntervalMs: POLL_INTERVAL_MS,
      startBlock,
      handle: (contract) =>
        handleTokenQuery(contract, {
          memory,
          chain,
          intelligence,
          payTo: config.vendorPayTo,
          priceUsdc6dp: PRICE_USDC_6DP,
          staleWindowMs: 60 * 60 * 1000,
        }),
      resumePending: (contract, requestId, fromBlock) =>
        resumeAfterApproval(contract, requestId, fromBlock, { memory, intelligence, chain, now: () => new Date() }),
      // Direction B: a message carrying both a contract address and a
      // payment tx hash is served as a paid gateway request instead of the
      // free one above. pending_approval outcomes from this path are
      // tracked and auto-resumed by resumePending exactly like the free
      // path's — see src/ping/pollOnce.ts.
      extractGatewayRequest,
      handleGateway: (contract, txHash) =>
        handleGatewayQuery(contract, txHash, {
          memory,
          chain,
          intelligence,
          incomingPayment,
          payTo: config.vendorPayTo,
          priceUsdc6dp: PRICE_USDC_6DP,
          staleWindowMs: 60 * 60 * 1000,
          gatewayFeeUsdc6dp: config.gatewayFeeUsdc6dp,
        }),
      onCycle: (result) => {
        console.log(`[ping] cycle: processed ${String(result.processed)}, cursor -> ${result.newLastProcessedBlock.toString()}`);
      },
    },
    controller.signal,
  );

  await memory.close();
}

main().catch((err: unknown) => {
  console.error("[ping] FAILED:", err);
  process.exitCode = 1;
});
