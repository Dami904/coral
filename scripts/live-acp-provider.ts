/**
 * Coral as an ACP (Virtuals Protocol Agent Commerce Protocol) Provider —
 * a third "another agent pays Coral" surface alongside Ping's gateway
 * mode, discoverable through Virtuals' own marketplace instead of
 * Ping's. See docs/API_NOTES.md's ACP section for the verified SDK
 * facts this was written against (including a real bug in the SDK's
 * own published example — `provider:` vs the actually-checked
 * `evmProvider:` field, confirmed by reading createAcpClients directly).
 *
 * Structurally like live-ping-listener.ts, not the request/response HTTP
 * gateway: a long-lived process holding open an SSE connection
 * (`AcpAgent.on("entry", ...)`), not a webhook.
 *
 * Job lifecycle (buyer funds a fixed-price job, Coral answers):
 *   job.created          -> log, wait for the buyer's requirement message
 *   requirement message  -> validate offering + parse {"token":"0x..."},
 *                           reject on either failure, else setBudget()
 *   job.funded           -> run Coral's own memory-then-pay check
 *                           (handleJobQuery — the payment already
 *                           arrived via ACP's escrow, so this is the
 *                           SAME direction as Coral's own outbound
 *                           SpendGuard-gated spend to Sibyl, not the
 *                           Ping-gateway incoming-payment-verification
 *                           path) -> submit() the result, or track it for
 *                           the resume-poll loop below if it needs
 *                           human sign-off first
 *   job.completed/.rejected/.expired -> log, drop any tracked state
 *
 * Intelligence check points at the local mock x402 server, same fix
 * applied to live-http-server.ts and for the same reason: SpendGuard
 * here runs on Base Sepolia, and Sibyl's real endpoint only recognizes
 * Base mainnet transactions — see docs/LIMITATIONS.md.
 *
 * Run: pnpm live:acp-provider
 */
import { baseSepolia } from "viem/chains";
import { AcpAgent, AssetToken, PrivyAlchemyEvmProviderAdapter, type JobRoomEntry, type JobSession } from "@virtuals-protocol/acp-node-v2";
import { loadConfig } from "../src/config.js";
import { handleJobQuery, resumeAfterApproval, type HandleTokenQueryDeps } from "../src/decisionCore.js";
import type { ResumableChainPort } from "../src/types.js";
import { X402IntelligenceClient } from "../src/intelligence/x402Client.js";
import { formatAcpDeliverable, parseAcpRequirement } from "../src/acp/acpProvider.js";
import { createKeyedLock } from "../src/lib/keyedLock.js";
import { makeChainClient, makeMemoryClient, SIBYL_HIRED_AGENT_ID, startMockX402Server } from "./lib/liveHarness.js";

// What Coral pays SpendGuard/Sibyl for a fresh check — matches the real
// Sibyl price, same as live-http-server.ts. NOT what an ACP buyer pays
// Coral for the job (that's the registered offering's own priceValue,
// read back from the registry below) — these were wrongly conflated into
// one constant in an earlier draft of this file, a real bug caught before
// ever running against a real job: setting the buyer's job budget to
// this value would have hardcoded what Coral charges instead of using
// whatever price is actually configured on the Virtuals dashboard.
const SIBYL_PRICE_USDC_6DP = 250_000n;
const RESUME_POLL_MS = 20_000;

function requireAcpEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `missing required environment variable for the ACP provider: ${name} — see docs/API_NOTES.md's ACP section for where this comes from (the Virtuals dashboard's Signers tab, etc.)`,
    );
  }
  return value;
}

type TrackedPending = { session: JobSession; token: `0x${string}`; requestId: bigint; fromBlock: bigint };

async function main(): Promise<void> {
  const config = loadConfig();
  const walletAddress = requireAcpEnv("ACP_WALLET_ADDRESS", config.acpWalletAddress);
  const walletId = requireAcpEnv("ACP_WALLET_ID", config.acpWalletId);
  const signerPrivateKey = requireAcpEnv("ACP_SIGNER_PRIVATE_KEY", config.acpSignerPrivateKey);
  const offeringName = requireAcpEnv("ACP_OFFERING_NAME", config.acpOfferingName);

  const chain = makeChainClient(config);
  const memory = makeMemoryClient(config);
  const mockServer = await startMockX402Server();
  console.log(`[acp-provider] local mock x402 server listening at ${mockServer.endpoint}`);
  const intelligence = new X402IntelligenceClient({ endpointUrl: mockServer.endpoint });

  try {
    await runProvider();
  } catch (err) {
    // Everything above can throw before the SIGINT/SIGTERM handlers near
    // the bottom of runProvider() are registered (e.g. "offering not
    // found" — confirmed live: without this, the process hung indefinitely
    // on the still-open mock server instead of exiting with a clean
    // error). Close what's already open before propagating.
    await Promise.allSettled([memory.close(), mockServer.close()]);
    throw err;
  }

  async function runProvider(): Promise<void> {

  // SpendGuardChainClient implements both ChainPort and ResumableChainPort;
  // this widened alias keeps deps.chain typed as ResumableChainPort so the
  // same `deps` object satisfies both handleJobQuery's and
  // resumeAfterApproval's deps shapes, same pattern as httpGatewayServer.ts's
  // HttpGatewayDeps.
  const deps: HandleTokenQueryDeps & { chain: ResumableChainPort } = {
    memory,
    chain,
    intelligence,
    payTo: config.vendorPayTo,
    priceUsdc6dp: SIBYL_PRICE_USDC_6DP,
    staleWindowMs: 60 * 60 * 1000,
  };

  const agent = await AcpAgent.create({
    evmProvider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: walletAddress as `0x${string}`,
      walletId,
      signerPrivateKey,
      chains: [baseSepolia],
    }),
  });

  const agentAddress = (await agent.getAddress()).toLowerCase();
  console.log(`[acp-provider] address: ${agentAddress}`);

  const registered = await agent.getAgentByWalletAddress(agentAddress);
  const offering = registered?.offerings?.find((o) => o.name === offeringName);
  if (!offering) {
    throw new Error(
      `no offering named "${offeringName}" found on this agent's Virtuals registry entry — register it on the dashboard first (see docs/API_NOTES.md's ACP section)`,
    );
  }
  console.log(`[acp-provider] serving offering "${offering.name}" at ${String(offering.priceValue)} USDC`);

  // Bridges the requirement-message step (where the token is known) to the
  // job.funded step (a separate event on the same jobId) — the SDK gives
  // no other place to stash per-job application data.
  const jobTokens = new Map<string, `0x${string}`>();
  // Mirrors pollLoop.ts's pendingRequests pattern exactly: a job whose
  // check needed human SpendGuard sign-off gets tracked here and retried
  // on a timer, same as Ping's resumePending, rather than left to hang
  // until the ACP job's own deadline silently expires it.
  const pendingApprovals = new Map<string, TrackedPending>();
  // Serializes per-jobId work (runCheck on job.funded, and each job's own
  // resume-poll attempt below) within this process. Without this, a
  // duplicate/replayed job.funded SSE event, or a resume-poll tick that
  // outruns RESUME_POLL_MS, could run handleJobQuery/resumeAfterApproval
  // + session.submit() twice for one logical job — a real double-payment/
  // double-submit bug caught by review, not by running against a real
  // job (no counterparty exists yet). Same mechanism as
  // httpGatewayServer.ts's per-contract lock, extracted to lib/keyedLock.ts.
  const withJobLock = createKeyedLock();

  agent.on("entry", (session: JobSession, entry: JobRoomEntry) => {
    void (async () => {
      if (entry.kind === "system") {
        switch (entry.event.type) {
          case "job.created":
            console.log(`[acp-provider] [job ${session.jobId}] new job from ${entry.event.client}`);
            return;
          case "job.completed":
            console.log(`[acp-provider] [job ${session.jobId}] completed`);
            jobTokens.delete(session.jobId);
            pendingApprovals.delete(session.jobId);
            return;
          case "job.rejected":
            console.log(`[acp-provider] [job ${session.jobId}] rejected by ${entry.event.rejector}: ${entry.event.reason}`);
            jobTokens.delete(session.jobId);
            pendingApprovals.delete(session.jobId);
            return;
          case "job.expired":
            console.log(`[acp-provider] [job ${session.jobId}] expired`);
            jobTokens.delete(session.jobId);
            pendingApprovals.delete(session.jobId);
            return;
          case "job.funded": {
            // Claimed synchronously (no await between get and delete) so a
            // duplicate/replayed job.funded for the same jobId finds
            // nothing here and is treated as an already-handled no-op,
            // never a second runCheck. A genuinely untracked job (funded
            // without ever going through the requirement-message step
            // above, which is the only place setBudget — a prerequisite
            // for funding — gets called) is not realistically
            // distinguishable from a duplicate event at this point, so
            // this no longer rejects on the theory it might wrongly
            // reject a job whose first runCheck already succeeded.
            const token = jobTokens.get(session.jobId);
            jobTokens.delete(session.jobId);
            if (!token) {
              console.log(`[acp-provider] [job ${session.jobId}] job.funded with no tracked token — likely a duplicate event, ignoring`);
              return;
            }
            await withJobLock(session.jobId, () => runCheck(session, token));
            return;
          }
        }
        return;
      }

      if (entry.kind === "message" && entry.contentType === "requirement" && session.status === "open") {
        const offeringDescription = session.job?.description;
        if (offeringDescription !== offeringName) {
          console.log(`[acp-provider] [job ${session.jobId}] rejecting — offering "${String(offeringDescription)}" not served here`);
          await session.sendMessage(`This provider only serves the "${offeringName}" offering.`);
          await session.reject("unsupported offering");
          return;
        }

        const parsed = parseAcpRequirement(entry.content);
        if (!parsed.ok) {
          console.log(`[acp-provider] [job ${session.jobId}] rejecting — ${parsed.reason}`);
          await session.sendMessage(parsed.reason);
          await session.reject("unparseable requirement");
          return;
        }

        jobTokens.set(session.jobId, parsed.requirement.token);
        try {
          await session.setBudget(AssetToken.usdc(offering.priceValue, session.chainId));
          console.log(`[acp-provider] [job ${session.jobId}] set budget for token ${parsed.requirement.token}`);
        } catch (err) {
          // Previously logged only — left the job stuck open with no
          // budget, no message, no rejection, silently relying on ACP's
          // own (possibly long) expiry as the only way out. Now
          // terminates it deterministically instead, same as every other
          // rejection path in this handler.
          console.error(`[acp-provider] [job ${session.jobId}] setBudget failed`, err);
          jobTokens.delete(session.jobId);
          await session.sendMessage("Internal error setting this job's budget — see provider logs.").catch(() => undefined);
          await session.reject("internal: setBudget failed").catch((rejectErr: unknown) => {
            console.error(`[acp-provider] [job ${session.jobId}] reject after setBudget failure also failed`, rejectErr);
          });
        }
      }
    })();
  });

  async function runCheck(session: JobSession, token: `0x${string}`): Promise<void> {
    let outcome;
    try {
      outcome = await handleJobQuery(SIBYL_HIRED_AGENT_ID, token, deps);
    } catch (err) {
      // Same "dangerous ordering" shape as the HTTP gateway (IntelligenceCheckFailedAfterPaymentError):
      // Coral's own SpendGuard spend to Sibyl may already have happened even
      // though this call threw. Not retried here automatically — matches
      // this codebase's standing rule against blind-retrying a non-idempotent
      // write; surfaced loudly instead. The ACP job stays funded/un-submitted,
      // so it'll either get manually retried (a future job.funded won't
      // re-fire) or expire and refund the buyer — the fund is not lost either
      // way, but Coral's own Sibyl spend (if it happened) is not recovered
      // here. See docs/LIMITATIONS.md.
      console.error(`[acp-provider] [job ${session.jobId}] handleJobQuery threw`, { token, err });
      await session.sendMessage("Internal error while checking this token — see provider logs.").catch(() => undefined);
      return;
    }

    if (outcome.outcome === "cache_hit" || outcome.outcome === "paid") {
      await session.sendMessage(`Result ready: ${outcome.output}`);
      await session.submit(formatAcpDeliverable(outcome));
      console.log(`[acp-provider] [job ${session.jobId}] submitted deliverable (${outcome.outcome}, output ${outcome.output})`);
      return;
    }

    if (outcome.outcome === "pending_approval") {
      pendingApprovals.set(session.jobId, { session, token, requestId: outcome.requestId, fromBlock: outcome.fromBlock });
      await session.sendMessage(
        "This check needs human sign-off on Coral's own SpendGuard contract before it can proceed — will deliver automatically once approved.",
      );
      console.log(`[acp-provider] [job ${session.jobId}] pending_approval requestId ${outcome.requestId.toString()}`);
      return;
    }

    // blocked
    await session.sendMessage(`Coral's own spend policy blocked this check: ${outcome.reason}`);
    await session.reject(outcome.reason);
    console.log(`[acp-provider] [job ${session.jobId}] blocked: ${outcome.reason}`);
  }

  const resumeTimer = setInterval(() => {
    void (async () => {
      for (const [jobId, tracked] of pendingApprovals) {
        // Per-jobId lock (shared with job.funded above): if this tick's
        // attempt for jobId is still in flight when the NEXT tick fires
        // (RESUME_POLL_MS outrun by a slow resumeAfterApproval/submit
        // call), the second attempt queues behind the first instead of
        // running concurrently — without this, both could reach
        // session.submit() for the same already-resolved job.
        await withJobLock(jobId, async () => {
          if (!pendingApprovals.has(jobId)) return; // resolved by the queued-ahead attempt already
          try {
            const resumed = await resumeAfterApproval(SIBYL_HIRED_AGENT_ID, tracked.token, tracked.requestId, tracked.fromBlock, deps);
            if (resumed.outcome === "still_pending") return;
            if (resumed.outcome === "rejected") {
              await tracked.session.reject("owner rejected the pending SpendGuard escalation");
              pendingApprovals.delete(jobId);
              return;
            }
            if (resumed.outcome !== "cache_hit" && resumed.outcome !== "paid") {
              // Structurally possible per ResumeOutcome's shared HandleOutcome
              // type, but not per resumeAfterApproval's actual approved-path
              // behavior (finishAfterPayment only ever returns "paid" or
              // throws) — logged as a real anomaly rather than silently
              // dropped or force-cast past the type checker.
              console.error(`[acp-provider] [job ${jobId}] unexpected resume outcome`, resumed);
              return;
            }
            await tracked.session.sendMessage(`Result ready: ${resumed.output}`);
            await tracked.session.submit(formatAcpDeliverable(resumed));
            console.log(`[acp-provider] [job ${jobId}] resumed + submitted (output ${resumed.output})`);
            pendingApprovals.delete(jobId);
          } catch (err) {
            // Mirrors pollLoop.ts's resumePending catch: stays tracked, retried
            // next tick rather than dropped on a transient failure.
            console.error(`[acp-provider] [job ${jobId}] resume attempt failed; will retry`, err);
          }
        });
      }
    })();
  }, RESUME_POLL_MS);

  await agent.start(() => console.log("[acp-provider] connected"));
  console.log("[acp-provider] ready, listening for jobs");

  const shutdown = () => {
    console.log("[acp-provider] shutting down...");
    clearInterval(resumeTimer);
    void Promise.allSettled([agent.stop(), memory.close(), mockServer.close()]).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  }
}

main().catch((err: unknown) => {
  console.error("[acp-provider] FAILED:", err);
  process.exitCode = 1;
});
