/**
 * Quantifies what Sibyl Memory's cache actually saved — the "here's the
 * dollar amount memory saved" table this project's docs were honest about
 * not having. Reads back the COLD journal `decisionCore.ts` already writes
 * on every branch (`memory_record_event("decision", {...})`) via
 * `memory_search(tiers:"journal")` and tallies cache hits (avoided a real
 * payment) against real payments.
 *
 * Not a `live:*` script — needs no funded wallet or live API key, only the
 * local `sibyl-memory-mcp` server and whatever's already in
 * SIBYL_MEMORY_DB. Safe to run anytime, changes nothing.
 *
 * Run: pnpm report:cache-savings
 */
import { loadConfig } from "../src/config.js";
import { SibylMemoryClient, type JournalHit } from "../src/memory/sibylMemoryClient.js";

/** Sibyl's one confirmed-live real price (docs/API_NOTES.md, captured
 * 2026-08-25 from the real /api/evaluate 402 response) — used as the one
 * honest reference cost for the "savings" estimate below. Many of this
 * project's own live:* runs paid different, lower demo/test prices
 * (SpendGuard's escalation threshold made $0.25 deliberately always
 * escalate), so this is a stated assumption, not a claim that every
 * counted payment cost exactly this — see the caveat printed at the end. */
const SIBYL_REAL_PRICE_USDC = 0.25;

/** memory_search's journal tier caps at floor(limit/4) of whatever's
 * requested (confirmed by reading sibyl_memory_client's own search()
 * source — see SibylMemoryClient.searchJournal's doc comment), and this
 * MCP tool's own `limit` caps at 50 — so ~12 is the real ceiling per call,
 * with no pagination. Querying a few different exact-match terms that
 * appear in every recorded event (the literal "decision" kind, and the
 * hired-agent id split into its FTS5 tokens) samples more broadly than one
 * query alone would, without pretending this is exhaustive. */
const SAMPLE_QUERIES = ["decision", "conviction", "sibyl", "check"];

type Tally = {
  cacheHits: number;
  realPayments: number;
  blocked: number;
  pendingOrRejected: number;
  seenEventIds: Set<string>;
};

function tallyHit(hit: JournalHit, tally: Tally): void {
  if (tally.seenEventIds.has(hit.key)) return; // same event can match >1 query
  tally.seenEventIds.add(hit.key);

  const acted = hit.body?.acted;
  if (!acted || acted.kind !== "decision") return; // not one of decisionCore's own events
  const body = acted.body;

  if (body.cache_hit === true) {
    tally.cacheHits += 1;
  } else if (body.paid === true) {
    tally.realPayments += 1;
  } else if (typeof body.blocked_reason === "string") {
    tally.blocked += 1;
  } else if (body.pending_request_id !== undefined) {
    tally.pendingOrRejected += 1;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const memory = new SibylMemoryClient({
    command: config.memoryMcpCommand,
    ...(config.memoryDbPath ? { env: { ...process.env, SIBYL_MEMORY_DB: config.memoryDbPath } } : {}),
  });

  const tally: Tally = { cacheHits: 0, realPayments: 0, blocked: 0, pendingOrRejected: 0, seenEventIds: new Set() };

  for (const query of SAMPLE_QUERIES) {
    const hits = await memory.searchJournal(query, 50);
    for (const hit of hits) tallyHit(hit, tally);
  }

  const estimatedSaved = tally.cacheHits * SIBYL_REAL_PRICE_USDC;
  const totalDecisions = tally.cacheHits + tally.realPayments + tally.blocked + tally.pendingOrRejected;

  console.log("=== Sibyl Memory cache-savings report ===");
  console.log(`Journal events sampled: ${totalDecisions.toString()} (${tally.seenEventIds.size.toString()} unique event ids across ${SAMPLE_QUERIES.length.toString()} queries)`);
  console.log("");
  console.log(`  Cache hits (zero payment):     ${tally.cacheHits.toString()}`);
  console.log(`  Real payments made:            ${tally.realPayments.toString()}`);
  console.log(`  Blocked by policy:             ${tally.blocked.toString()}`);
  console.log(`  Pending/rejected escalations:  ${tally.pendingOrRejected.toString()}`);
  console.log("");
  console.log(`  Estimated saved by caching:    $${estimatedSaved.toFixed(2)} (${tally.cacheHits.toString()} hits x Sibyl's real $${SIBYL_REAL_PRICE_USDC.toFixed(2)} price)`);
  console.log("");
  console.log("Caveats, stated plainly rather than left implicit:");
  console.log("  - This is a sample, not an exhaustive count. memory_search's journal tier");
  console.log("    caps at ~12 hits per call with no pagination in this MCP interface — a");
  console.log("    few differently-worded queries were run to sample more broadly, but a");
  console.log("    journal larger than that isn't fully counted here.");
  console.log("  - The $ estimate applies Sibyl's one confirmed-live real price to every");
  console.log("    counted cache hit, even though many of this project's own live:* test");
  console.log("    runs paid lower demo prices for the underlying 'real payments' bucket —");
  console.log("    it answers 'what would this have cost against the real endpoint', not");
  console.log("    'what these specific test runs actually spent'.");

  await memory.close();
}

main().catch((err: unknown) => {
  console.error("[cache-savings-report] FAILED:", err);
  process.exitCode = 1;
});
