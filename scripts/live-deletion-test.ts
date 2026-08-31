/**
 * Day 8: the cold-start-recall / deletion-test harness — the mechanism
 * this whole project is judged on. Proves, against the real deployed
 * testnet SpendGuard and a real Sibyl Memory DB (not mocks):
 *   1. First call for a fresh contract -> cache miss -> real payment.
 *   2. Second call, same contract -> cache hit -> zero payment.
 *   3. Delete the DB file live.
 *   4. Third call, same contract -> cache miss AGAIN -> real payment again.
 * Step 4 is the actual gate: if memory weren't load-bearing, deleting it
 * wouldn't change behavior.
 *
 * Run: pnpm live:deletion-test
 */
import { unlinkSync, existsSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { handleTokenQuery, type HandleTokenQueryDeps } from "../src/decisionCore.js";
import { SpendGuardChainClient } from "../src/chain/spendGuardClient.js";
import { SibylMemoryClient } from "../src/memory/sibylMemoryClient.js";
import { StubIntelligenceClient } from "../src/intelligence/stubIntelligenceClient.js";

const TEST_CONTRACT = "0x000000000000000000000000000000c0ffee03";

function makeMemory(config: ReturnType<typeof loadConfig>): SibylMemoryClient {
  return new SibylMemoryClient({
    command: config.memoryMcpCommand,
    ...(config.memoryDbPath
      ? { env: { ...process.env, SIBYL_MEMORY_DB: config.memoryDbPath } }
      : {}),
  });
}

async function main() {
  const config = loadConfig();
  if (!config.memoryDbPath) {
    throw new Error(
      "SIBYL_MEMORY_DB must be set to a project-local path for this harness — refusing to delete a real ~/.sibyl-memory DB.",
    );
  }

  if (existsSync(config.memoryDbPath)) {
    unlinkSync(config.memoryDbPath);
    console.log(`[deletion-test] deleted pre-existing ${config.memoryDbPath} for a clean run`);
  }

  const chain = new SpendGuardChainClient({
    rpcUrl: config.rpcUrl,
    guardAddress: config.guardAddress,
    agentPrivateKey: config.agentPrivateKey,
    chain: config.chain,
  });
  const intelligence = new StubIntelligenceClient();
  const commonDeps: Omit<HandleTokenQueryDeps, "memory"> = {
    chain,
    intelligence,
    payTo: config.vendorPayTo,
    priceUsdc6dp: 100_000n,
    staleWindowMs: 60 * 60 * 1000,
  };

  let memory = makeMemory(config);

  console.log(`[deletion-test] call 1 (expect miss -> real payment) for ${TEST_CONTRACT}`);
  const first = await handleTokenQuery(TEST_CONTRACT, { ...commonDeps, memory });
  console.log("[deletion-test] result 1:", first);
  if (first.outcome !== "paid") throw new Error(`expected "paid", got "${first.outcome}"`);

  console.log(`[deletion-test] call 2 (expect cache hit) for ${TEST_CONTRACT}`);
  const second = await handleTokenQuery(TEST_CONTRACT, { ...commonDeps, memory });
  console.log("[deletion-test] result 2:", second);
  if (second.outcome !== "cache_hit") throw new Error(`expected "cache_hit", got "${second.outcome}"`);

  await memory.close();
  console.log(`[deletion-test] deleting ${config.memoryDbPath} live...`);
  unlinkSync(config.memoryDbPath);

  memory = makeMemory(config);
  console.log(`[deletion-test] call 3, same contract, AFTER deletion (expect miss -> real payment again) for ${TEST_CONTRACT}`);
  const third = await handleTokenQuery(TEST_CONTRACT, { ...commonDeps, memory });
  console.log("[deletion-test] result 3:", third);
  if (third.outcome !== "paid") throw new Error(`expected "paid" again after deletion, got "${third.outcome}"`);

  console.log("[deletion-test] PASS: deleting memory forced a real re-payment — dependency proven, not decorative.");
  await memory.close();
}

main().catch((err: unknown) => {
  console.error("[deletion-test] FAILED:", err);
  process.exitCode = 1;
});
