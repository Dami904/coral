/**
 * Acts as a BUYER on Virtuals Protocol ACP to hire Coral's own live
 * offering ("coral_cache") and watch a real job resolve end-to-end —
 * the mirror of live-acp-provider.ts, which only ever runs the seller
 * side. This is how you actually see a job go
 * created -> requirement -> budget.set -> funded -> submitted -> completed
 * against the real deployed provider, not just confirm it boots.
 *
 * Verified against the real SDK source before writing this (per
 * docs/API_NOTES.md's ACP section and this file's own doc comments
 * below) — including a real bug in the SDK's own buyer.ts example, same
 * class as the one already found in seller.ts: it calls
 * `AcpAgent.create({ provider: ... })`, but the actual code only ever
 * checks `evmProvider`/`solanaProvider` (traced createAcpClients
 * directly). Uses `evmProvider:` here, not `provider:`.
 *
 * Uses `createJobByOfferingName` (looks up the provider + offering by
 * name in one call) rather than the example's manual
 * getAgentByWalletAddress + offerings.find(...) — simpler since both
 * Coral's wallet address and its offering name are already known
 * constants below.
 *
 * Runs in SELF-EVALUATION mode (evaluatorAddress: the buyer's own
 * address) rather than skip-evaluation, deliberately: per
 * createJobByOfferingName's own doc comment, omitting evaluatorAddress
 * defaults to skip-evaluation, where the job goes straight to
 * job.completed and job.submitted never fires on the buyer side — you'd
 * never see the deliverable text print, only the final completion. Self-
 * evaluation costs one extra session.complete() call but actually shows
 * what came back, which is the point of this script.
 *
 * NOT independently verified (flagged, not guessed past):
 *   - Whether a buyer needs the same dashboard registration flow
 *     (app.virtuals.io/acp/new) as a seller, or a separate one. The
 *     credential shape (walletAddress/walletId/signerPrivateKey) is
 *     identical to the seller's, which strongly implies the same flow,
 *     but this is a server-side/dashboard rule the SDK source can't
 *     confirm either way.
 *   - Whether gas is unconditionally sponsored on Base Sepolia for this
 *     buyer wallet (ERC20_SPONSORED_CHAINS includes baseSepolia and the
 *     adapter does construct real paymaster fields, but whether
 *     sponsorship applies without an Alchemy-side policy Virtuals
 *     configures per-agent is not confirmed).
 *   - Whether there's a faucet for the ACP-designated Base Sepolia USDC
 *     (0xECc22a8F6fD62388498fBa19813E214605a2BDb3) — NOT the same token
 *     as Coral's own MockUSDC used by SpendGuard. Check the Virtuals
 *     dashboard/docs/Discord before attempting to fund a real job.
 *
 * Requires a SEPARATE buyer identity from Coral's own ACP_* vars —
 * ACP_BUYER_WALLET_ADDRESS/ACP_BUYER_WALLET_ID/ACP_BUYER_SIGNER_PRIVATE_KEY.
 *
 * Run: pnpm live:acp-buyer-test
 */
import { baseSepolia } from "viem/chains";
import { AcpAgent, PrivyAlchemyEvmProviderAdapter, type JobRoomEntry, type JobSession } from "@virtuals-protocol/acp-node-v2";

// Coral's own real, deployed ACP identity — confirmed live this session
// (see docs/API_NOTES.md's ACP section).
const CORAL_PROVIDER_WALLET_ADDRESS = "0x90d9a36d8a262409c4f1f796f001a309ee6bf58e";
const CORAL_OFFERING_NAME = "coral_cache";
// A token Coral already has cached (confirmed cache_hit this session) —
// picked so this test resolves to a real deliverable fast instead of
// tripping SpendGuard's human-approval escalation.
const TEST_TOKEN = "0x0000000000000000000000000000000000000001";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const walletAddress = requireEnv("ACP_BUYER_WALLET_ADDRESS") as `0x${string}`;
  const walletId = requireEnv("ACP_BUYER_WALLET_ID");
  const signerPrivateKey = requireEnv("ACP_BUYER_SIGNER_PRIVATE_KEY");

  const buyer = await AcpAgent.create({
    evmProvider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress,
      walletId,
      signerPrivateKey,
      chains: [baseSepolia],
    }),
  });

  const buyerAddress = (await buyer.getAddress()).toLowerCase();
  console.log(`[acp-buyer-test] buyer address: ${buyerAddress}`);

  let done = false;
  let exitCode = 0;

  buyer.on("entry", (session: JobSession, entry: JobRoomEntry) => {
    void (async () => {
      if (entry.kind !== "system") return;
      switch (entry.event.type) {
        case "job.created":
          console.log(`[acp-buyer-test] [job ${session.jobId}] created`);
          return;
        case "budget.set":
          console.log(`[acp-buyer-test] [job ${session.jobId}] budget set — funding...`);
          try {
            await session.fetchJob();
            await session.fund();
            console.log(`[acp-buyer-test] [job ${session.jobId}] funded`);
          } catch (err) {
            console.error(`[acp-buyer-test] [job ${session.jobId}] fund() failed`, err);
            exitCode = 1;
            done = true;
          }
          return;
        case "job.submitted":
          console.log(`[acp-buyer-test] [job ${session.jobId}] DELIVERABLE: ${entry.event.deliverable}`);
          try {
            await session.complete("looks good");
          } catch (err) {
            console.error(`[acp-buyer-test] [job ${session.jobId}] complete() failed`, err);
            exitCode = 1;
            done = true;
          }
          return;
        case "job.completed":
          console.log(`[acp-buyer-test] [job ${session.jobId}] COMPLETED`);
          console.log("---- transcript ----");
          console.log(await session.toContext());
          console.log("---- end transcript ----");
          done = true;
          return;
        case "job.rejected":
          console.error(`[acp-buyer-test] [job ${session.jobId}] REJECTED by ${entry.event.rejector}: ${entry.event.reason}`);
          exitCode = 1;
          done = true;
          return;
        case "job.expired":
          console.error(`[acp-buyer-test] [job ${session.jobId}] EXPIRED — Coral likely needed human sign-off longer than the job's deadline (see docs/LIMITATIONS.md's ACP section)`);
          exitCode = 1;
          done = true;
          return;
      }
    })();
  });

  await buyer.start(() => console.log("[acp-buyer-test] connected"));

  console.log(`[acp-buyer-test] hiring Coral (${CORAL_PROVIDER_WALLET_ADDRESS}) for offering "${CORAL_OFFERING_NAME}"...`);
  const jobId = await buyer.createJobByOfferingName(
    baseSepolia.id,
    CORAL_OFFERING_NAME,
    CORAL_PROVIDER_WALLET_ADDRESS,
    { token: TEST_TOKEN },
    { evaluatorAddress: buyerAddress },
  );
  console.log(`[acp-buyer-test] job created: ${jobId.toString()}`);

  const deadline = Date.now() + 3 * 60 * 1000;
  while (!done && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!done) {
    console.error("[acp-buyer-test] timed out after 3 minutes waiting for the job to resolve");
    exitCode = 1;
  }

  await buyer.stop();
  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  console.error("[acp-buyer-test] FAILED:", err);
  process.exitCode = 1;
});
