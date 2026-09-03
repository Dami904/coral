# Project plan — Sibyl Labs Hackathon (Sep 1–10, 2026)

Working name TBD. This document is the running plan built up during design —
architecture, verified facts, demo script, and schedule. Update it as things
change; don't let it drift from what's actually built.

## What this is

An agent that:
1. Receives inbound messages over **Ping** (Sibyl Labs' own on-chain
   agent-to-agent messaging protocol, live on Base).
2. Consults **Sibyl Memory** — over the standard **MCP** interface
   (`sibyl-memory-mcp`), the same way Claude Code/Codex/Cursor consume it —
   before ever deciding to act.
3. Only pays for a fresh builder-conviction check via **Sibyl's x402
   Intelligence Endpoints** when memory has no cached tier, or the cached
   one is stale.
4. That payment itself is gated by an on-chain **`SpendGuard`** contract on
   Base — the agent's wallet can only *request* a payment; the contract
   decides, deterministically, whether it's allowed.

Sibyl Memory is the mandatory gate. Ping and the on-chain-enforced spend
policy are the Base partner-multiplier integrations, both meant to be
genuinely exercised in the demo, not decorative.

## Why this design (the judging math that shaped it)

Two-stage judging: a pass/fail **gate** (delete Sibyl Memory — does the core
function still work? If yes, disqualified), then a 100-point rubric
(load-bearing memory 40, innovation 25, technical execution 20, pitch 15),
a PMF bonus (+10, needs a checkable artifact), and a partner multiplier
(+15% first stack, +10% second, capped ×1.25 — only counts if a judge sees
it doing real work in the demo).

Key decisions this drove:
- **Memory's job is decision-caching, not custody.** Deleting the DB file
  must visibly break something — here, the agent stops knowing it already
  has an answer and starts re-paying for checks it used to get free. That's
  the cold-start recall / deletion-test beat the gate explicitly asks for.
- **Innovation is judged relative to this hackathon's field, not the whole
  research literature.** A general prior-art check (see below) found that
  *every* high-level "shape" here — skill libraries, temporal/graph
  contradiction resolution, agent risk-gating, agent reputation — already
  exists somewhere (Voyager, Zep/Graphiti, ERC-8004, 2026 circuit-breaker
  literature). The differentiator is the *specific combination*: Sibyl's own
  undocumented schema tables + a live Base-ecosystem application + an
  honestly-declared prior-art section, not a false novelty claim.
- **The skill-learning pipeline (`skill_proposals`/`learning_runs`) was
  deliberately NOT used** — it's real and interesting, but it's paid-tier
  gated in the SDK (`_require_paid_tier`), which adds cost/friction with no
  rubric benefit for this design. `set_entity`/`get_entity`/`write_event`
  are free-tier, verified directly against `client.py`.
- **`entity_relations` is NOT used** — verified it has no public API in
  `client.py`; it's schema-only, same risk category as `revenue_events`/
  `error_events`/`flagged_actors`, which also have zero exposed methods.
  Building on any of those would mean raw SQL against an unsupported
  internal table. Only `set_entity`/`get_entity`/`write_event`/
  `read_events`/`set_reference`/`get_reference`/`archive_entity`/`search`
  are confirmed-supported, free-tier, tested API surface.

## Architecture

```
Base chain
  │
  ├── Ping (agent-to-agent) ──► Poll loop (ping-onchain, getInboxWithStatus
  │                              on an interval, tracks last-processed block)
  │                                    │
  │                                    ▼
  │                          Decision core ──MCP──► sibyl-memory-mcp ──► local SQLite
  │                                    │                                 (WARM entities +
  │                                    ▼ (cache miss/stale)               COLD journal)
  │                          requestPayment(payTo, amount)
  │                                    │
  │                                    ▼
  └── SpendGuard.sol (Base) ──[rules pass]──► USDC.transfer(payTo, amount)
                                              │
                                              ▼ (agent relays txHash)
                                    X-PAYMENT-TX header ──► Sibyl x402 endpoint (real verdict)
```

The agent's wallet can only call `requestPayment` — it never holds direct
transfer authority. `SpendGuard` decides, not the agent's own reasoning.

## Data model (Sibyl Memory, confirmed-supported API only)

- **WARM entity** — `category="token_verdict"`, `name=<contract address,
  lowercased>`, `body={verdict, raw_response, checked_at, source_endpoint}`.
  One per contract, overwritten on refresh. This is the cache.
- **COLD journal event** per inbound Ping message —
  `write_event(evaluated={contract, sender, ping_msg_id},
  acted={cache_hit, paid, amount_usdc}, forward={responded_via:"ping"})`.
  Not required for the gate, but makes the critical path trivially
  inspectable — a judge can read the journal and see cache hits vs. real
  payments directly.

## Decision logic (the critical path — point the README straight at this)

```
every POLL_INTERVAL:
  inbox = ping.getInboxWithStatus({ address: agentAddress, fromBlock: lastProcessedBlock })
  for message in inbox where not message.replied:
    handle(message)
  lastProcessedBlock = currentBlock

on handle(message):
  contract = extract_address(message.content)
  cached = mcp.get_entity("token_verdict", contract)
  if cached and (now - cached.checked_at) < STALE_WINDOW:
      reply_via_ping(cached.body.verdict)          # no payment
  else:
      decision = guard.requestPayment(SIBYL_PAYTO, priceFor(endpoint))
      if not decision.sentImmediately and decision.requestId == 0:
          reply_via_ping("blocked by policy")       # hard block, no path forward
      elif not decision.sentImmediately:
          wait_for(PaymentApproved(decision.requestId))  # escalation tier
      result = await x402_pay_and_check(contract)    # relays txHash, real endpoint
      mcp.set_entity("token_verdict", contract, {...})
      reply_via_ping(result)
  mcp.write_event(evaluated={...}, acted={...}, forward={})
```

## SpendGuard — on-chain enforced policy (not just an in-process check)

Ported the actual rule-evaluation algorithm from AgentVault's
`go/pkg/policy/policy.go` (a different, Flare-hackathon project — cited
honestly, not claimed as invented here): four rules, fixed order
(allowlist → max-per-payment → budget-window → rate-limit), inclusive
boundaries, rolling windows via lazy-pruned timestamp lists, counted at
issuance not settlement. Reimplemented in Solidity instead of Go+TEE,
because Sibyl's x402 endpoints support a `directTx` payment path (send USDC
directly to `payTo`, then relay the tx hash via `X-PAYMENT-TX` within 120s)
— confirmed live against the real endpoint, see Verified facts below. That
path means the guard contract doesn't need EIP-1271 signature validation;
it just needs to hold USDC and call `transfer()` itself when its own rules
pass.

Added on top of AgentVault's four rules: a **human-approval escalation
tier** (idea sourced from a separate banking-assistant architecture
doc — also cited, not claimed as invented here). Above
`humanApprovalThreshold`, the agent can *propose* a payment
(`PaymentPending` event) but cannot execute it — only `ownerApprove()` can.
This is the strongest demo beat: it's filmable, on-chain, and proves "the
agent is blind to and can't reason around its limits" instead of just
asserting it.

Files: `contracts/SpendGuard.sol`, `contracts/MockUSDC.sol`,
`script/Deploy.s.sol`, `foundry.toml`, `.env.example`.

## Verified facts (checked directly, not assumed — dates noted)

- **`set_entity`/`get_entity`/`write_event`/`read_events` are free-tier**,
  no `_require_paid_tier` decorator — confirmed against
  `sibyl-memory-client/src/sibyl_memory_client/client.py`.
- **`learner`/`learn`/`list_skill_proposals`/`accept_skill_proposal`/
  `reject_skill_proposal`/`lint` ARE paid-tier gated** — same file. Not used
  in this design for that reason.
- **`entity_relations` has no public client API** — schema-only, like
  `revenue_events`/`error_events`/`flagged_actors`. Not used.
- **Real 402 response from `https://sibylcap.com/api/evaluate`**, captured
  live 2026-08-25:
  ```json
  {"x402Version":1,"accepts":[{"scheme":"exact","network":"base",
  "maxAmountRequired":"250000",
  "asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "payTo":"0xe3e14118238b5693c854674f7c276136a2dd311f", ...}],
  "alt":{"directTx":{"header":"X-PAYMENT-TX","instructions":"Send
  maxAmountRequired (USDC, 6dp) to payTo on Base, then resend with header
  X-PAYMENT-TX:<txHash> within 120s. Single-use."}}}
  ```
  `asset` is Base's real USDC contract; `payTo` matches the same wallet
  found live in `/api/portfolio` — genuinely operational, not a stub.
  `/api/check` and `/api/score` 404'd at the paths implied by their pricing
  page — **not yet confirmed live**, re-check before relying on them.
- **Ping**: live, 31 users (9 agents, 22 humans), 195+ on-chain messages,
  real npm package `ping-onchain`, 0.00003 ETH per message (~$0.07).
- **AgentVault** (`github.com/Vasqq/agent-vault`) is a *different*
  hackathon's project (Flare, Coston2 testnet, TEE-based) — not reused
  directly, only its policy algorithm, ported and cited.
- **Sibyl's own marketing overstates the product**: `sibyllabs.org`'s
  product features section calls Sibyl Memory "Graph-structured,
  file-based memory an agent queries like a database, not a guess." Their
  own docs page (`docs.sibyllabs.org/memory`) never mentions graphs at
  all, and `entity_relations` — the one table shaped like a graph edge —
  has zero public methods in `client.py`: no create-relation call, no
  traversal, nothing reachable from the shipped SDK. "Graph-structured" is
  homepage framing, not a shipped capability. Worth stating plainly in the
  Prior Work section: this build makes no graph claims Sibyl's own product
  doesn't actually ship.

## Day 1 verification — resolved

- **`sibyl-memory-mcp` exposes 8 tools**, read directly from `server.py`:
  `memory_remember`, `memory_recall`, `memory_search`, `memory_list`,
  `memory_forget`, `memory_set_state`, `memory_get_state`,
  `memory_record_event`. They do **not** map 1:1 to the Python client's
  method names — e.g. `memory_remember(category, name, body)` wraps
  `set_entity`, and `memory_record_event(kind, body, category, name)`
  wraps `write_event(acted={kind, body}, extra={category, name})`, a
  translated shape, not a passthrough. Reads are fenced against prompt
  injection (`_untrusted_context` wrapper, fence-marker stripping) and
  size-capped — worth knowing since stored bodies are attacker-controlled
  once a Ping sender can write content the agent might store.
- **`ping-onchain` v0.1.5 is poll-only — there is no subscribe/watch/on()
  method.** Pulled and read the real published source (registry tarball,
  not npm's page — that fetch got blocked, 403). The only way to see
  inbound messages is `getInbox({ address, fromBlock, toBlock })`, which
  fetches historical logs in chunks with retry/backoff and merges v1 +
  v2 ("Diamond" upgrade) + broadcast sources. **This changes the
  architecture**: the "Ping listener" is a polling loop, not an event
  subscription — call on an interval, track the last-processed block,
  diff against it. `getInboxWithStatus()` is the more useful call for
  this design specifically: it annotates each message with `replied`
  (bool) and `replyBlock`, so the poll loop can skip messages already
  answered without maintaining its own dedup state.
  Message shape, confirmed from source: `{ from, to, content, block,
  transactionHash, isBroadcast, broadcastId? }` — `content` is a plain
  string, auto-split into numbered `(1/N)` chunks above 1024 chars.
  One correction to earlier notes: the message fee is **not** a fixed
  0.00003 ETH constant — `getMessageFee()` reads it live from the
  contract; treat the earlier figure as a snapshot, not a constant, and
  call the getter at runtime rather than hardcoding it.
- **`/api/check` and `/api/score` are NOT live at any path variant
  tried** (9 attempts: case variants, trailing slash, alternate names —
  all 404, the one 308 was just Vercel's trailing-slash normalization
  redirecting to the same 404). Meanwhile `/api/pingcast` and `/api/fund`
  ARE confirmed live (real usage-error JSON bodies), alongside the
  already-confirmed `/api/evaluate` and `/api/advisory`. Treat Sibyl's
  pricing table as aspirational for `/check` and `/score` specifically —
  don't build the token-safety-check flow against a path that doesn't
  exist; use `/api/evaluate` ($0.25) as the confirmed-live endpoint for
  that role instead.

## Still open — resolve before the relevant build day

- [ ] The 120s `directTx` window in practice, once the real mainnet smoke
      test happens (Day 5).

## Cost plan (kept deliberately near-zero)

1. Testnet (Base Sepolia) for all `SpendGuard` development — free, mock
   USDC. Deploy via `forge script script/Deploy.s.sol:Deploy --rpc-url
   base_sepolia --broadcast`.
2. Local mock of Sibyl's endpoint (`mock-x402-server/server.mjs`) for all
   decision-core/client iteration — free. Note: it trusts any well-formed
   tx hash, it does not verify on-chain — passing against it proves client
   logic only, not real settlement.
3. **One deliberate real mainnet smoke test** once 1 and 2 are solid — a
   couple dollars of real USDC, one real call to `/api/evaluate` ($0.25),
   to confirm the `X-PAYMENT-TX` flow actually closes end-to-end before
   recording the demo.
4. Ping messages: ~$0.07 each, real cost throughout, negligible.

## Demo script (2–5 min, maps to every required beat)

1. **Problem** (0:00–0:25) — repeat "is this token safe" questions flood
   crypto communities; re-paying every time is wasteful, never checking is
   unsafe, forgetting a past bad verdict is dangerous.
2. **First contact** (0:25–1:15) — real Ping message asks about contract A.
   Real payment fires (Basescan link), WARM entity written.
3. **Cold-start recall — the required beat** (1:15–1:50) — kill the
   process, fresh terminal, same on-disk DB, ask about A again. Instant
   answer, zero payment, on-screen timestamp. Single most important shot,
   one continuous take.
4. **Escalation beat** (1:50–2:35) — ask via the pricier endpoint (crosses
   the deliberately-low $0.15 demo threshold) → `PaymentPending`, agent
   says it needs sign-off, no funds move → `ownerApprove` on camera →
   `PaymentSent` → check completes.
5. **New contract** (2:35–2:55) — proves it's conditional, not silent.
6. **Deletion test** (2:55–3:25) — delete the DB file live, restart, ask
   about A a third time → pays again. Proves dependence, not decoration.
7. **Repo tour + close** (3:25–4:00) — point at the decision-core function.

## README requirements (map directly to submission rules)

- What it does / the problem
- Where memory is load-bearing → link straight to the decision-core function
- Partner stacks: Base — real Ping (A2A) + on-chain-enforced spend policy,
  both exercised live, both Basescan-verifiable
- "How memory made this possible" — one paragraph
- Note this build makes no graph/traversal claims — Sibyl's own homepage
  calls the product "graph-structured" but ships no relation-traversal API
  (see Verified facts), and this design deliberately doesn't borrow that
  framing
- License: MIT (see `LICENSE`)
- `docs/LIMITATIONS.md`: unbounded loops in `SpendGuard`'s budget/rate logs
  (fine at demo volume, wouldn't scale as-is); mock server doesn't verify
  tx on-chain
- `docs/THREAT_MODEL.md`: agent wallet can only call `requestPayment`,
  never holds transfer authority; owner can `withdraw` any time

## Day-by-day (Sep 1–10 build window)

- **Day 1**: done — see "Day 1 verification — resolved" above. Net
  effect on the build: Ping is poll-based (interval loop, not a
  subscription), the decision core targets `/api/evaluate` not
  `/api/check`, and the MCP tool names are `memory_*`, not the raw SDK
  method names.
- **Day 2**: done. 38 Foundry unit tests (`test/SpendGuard.t.sol`,
  `test/MockUSDC.t.sol`) cover all four policy rules, their fixed
  evaluation order, boundary/window edge cases, and the escalation tier —
  one order-check was mutation-tested live (temporarily swapped two
  rules, confirmed the test fails) to confirm the suite isn't vacuous.
  Deployed to Base Sepolia (chain 84532) 2026-08-26:
  - `MockUSDC`: `0xfC10f0A357c74318451A583C30A1fb5C8c7a2407`
  - `SpendGuard`: `0xc243822863f1770a7187EbD630D150379e58EEdE`
  - Owner/deployer: `0x2993f576Aa99C82188242735806b3a0Dce96B787`
  - Agent: `0x004e643E3C9043755d623637F59537c49E6613F7`
  - Vendor/payTo (allowlisted): `0x475c19CA186BB81AD3bFA803df378b1B05Afb543`
  - Post-deploy on-chain read confirmed: `owner`, `agent`,
    `maxPerPayment` (500_000), `humanApprovalThreshold` (150_000), and
    the guard's mUSDC balance (100e6) all match `script/Deploy.s.sol`.
  - All three wallets are fresh, testnet-only keys generated for this
    project; private keys live in local `.env` (gitignored), never
    committed.
- **Day 3–4**: done. `src/decisionCore.ts` implements `PLAN.md`'s
  `handle()` against three injected ports (`MemoryPort`, `ChainPort`,
  `IntelligencePort`) — memory is unconditionally checked before any
  chain call, enforced by a passing test
  (`test/decisionCore.test.ts`: "checks memory before ever calling the
  chain (non-negotiable invariant)"), 10 tests total covering cache hit,
  stale-as-miss, blocked, pending/escalation, paid, and two distinct
  paid-but-then-failed reconciliation gaps from `docs/API_NOTES.md`'s
  "dangerous ordering" note (intelligence check fails after payment;
  memory write fails after payment). The second of those was a real bug
  caught by self-applying the `reliability-auditor` checklist (that
  subagent isn't registered in this Windows-side session, so applied its
  5-point list by hand) — the first implementation only logged-before-throw
  for the intelligence-failure case, not the memory-write-failure case,
  which is the one that actually matters for preventing a silent re-pay.
  Fixed (`CacheWriteFailedAfterPaymentError`), and mutation-tested live
  the same way the Solidity rule-order test was: reverted the fix,
  confirmed the new test fails, restored it.
  `IntelligencePort` is stubbed (`StubIntelligenceClient`) — the real
  x402 `/api/evaluate` client is Day 5 work, not pulled forward.
  Real adapters, both exercised live end-to-end 2026-08-26
  (`pnpm live:day3-smoke`, not part of `pnpm test` — needs a funded
  wallet, hence the `live:` prefix):
  - `SibylMemoryClient` (`src/memory/sibylMemoryClient.ts`) — real
    `sibyl-memory-mcp` stdio server, project-local venv (`.venv/`,
    gitignored). Caught a real wire-format bug only visible by running it
    (the Python MCP SDK prefixes error text with
    `Error executing tool <name>: ` before the tool's own JSON payload —
    see `docs/API_NOTES.md`).
  - `SpendGuardChainClient` (`src/chain/spendGuardClient.ts`) — real
    `requestPayment` call against the deployed Base Sepolia contract,
    outcome decoded from the mined receipt's event log, not the
    simulated return value.
  - Live run result: first call for a fresh contract → cache miss → real
    payment, tx `0xc7047761a5ce321dca8ef37add4d708af1fc2b8e71e580b2c0d85b0a410afca2`,
    confirmed by reading `SpendGuard`'s mUSDC balance drop by exactly
    100_000 and the vendor's balance rise by exactly 100_000. Second call
    for the same contract → cache hit, zero additional payment.
  - Funded the agent wallet (`0x004e643E3C9043755d623637F59537c49E6613F7`)
    with 0.002 testnet ETH from the deployer wallet so it can pay its own
    gas as `requestPayment`'s signer — it had none after Day 2 (only the
    deployer/owner wallet was funded then).
  - `pnpm lint` / `typecheck` / `test` / `build` all pass; TypeScript
    pinned to the 6.x line (`typescript-eslint` doesn't yet support the
    new 7.0 native compiler — see `package.json`).
- **Day 5**: mock-server half done, mainnet smoke test deliberately not
  yet done (needs explicit user go-ahead — see below).
  - Closed a real gap first: `PLAN.md`'s Day 1 capture never confirmed
    *how* a contract gets submitted to `/api/evaluate`. A free (no-payment)
    `curl` against the real endpoint surfaced an `extensions.bazaar.info`
    block showing `GET /api/evaluate?token=<contract>` is the actual
    request shape — see `docs/API_NOTES.md`. Without this the x402 client
    would have been built against a guess.
  - Also found: the endpoint scores "builder conviction, community seed,
    on-chain proof of work" (`conviction_score` 0-30 + `tier`) — a project-
    conviction rating, not a safe/unsafe token-safety verdict. The cached
    `verdict` is `tier` (e.g. `"high_conviction"`); no binary safety claim
    is invented that Sibyl's data doesn't actually support.
  - `IntelligencePort.checkToken` gained a required `paymentTxHash`
    parameter (the port didn't originally anticipate needing to relay the
    SpendGuard tx hash) — widened with a test-first change, all call sites
    (decision core, stub, test fakes) updated together.
  - `src/intelligence/x402Client.ts` implements the real directTx client.
    Tested against a real in-process HTTP server
    (`test/x402Client.test.ts` spins up `mock-x402-server/server.mjs`'s
    actual handler on an ephemeral port — refactored the mock to export
    `requestHandler` for this, only auto-listening when run directly) —
    3 tests: relay + verdict shape, malformed-hash 400, single-use 409.
  - Live end-to-end run (`pnpm live:day5-smoke`, 2026-08-26): real
    Base Sepolia `SpendGuard` payment (tx
    `0x369508bea3fb14a11035b4f2b30d34ac7d355f1ae7cdb23261a2493f44c6e320`)
    relayed via real `X-PAYMENT-TX` HTTP header to the local mock server
    (no mainnet spend) → verdict `"high_conviction"` cached → second call
    for the same contract → cache hit, zero payment, zero HTTP call.
    Confirmed by reading the guard's and vendor's mUSDC balances move by
    another exactly-100,000 each (cumulative with the Day 3 run).
  - **The one real mainnet smoke test is intentionally not done yet.** It
    needs a *mainnet*-funded wallet (real USDC + ETH for gas — the
    testnet wallets generated for Days 2-5 don't work here) and spends
    real, non-refundable money against Sibyl's production endpoint. Per
    this repo's own rule ("don't deploy to mainnet from an agent
    session") and general judgment about irreversible real-money spend,
    this needs the user to explicitly decide to do it and provide/fund
    the mainnet wallet themselves — not something to do autonomously.
- **Day 6–7**: code done, real execution deliberately not done (mainnet
  spend — see below).
  - Verified `ping-onchain` for real (installed it, read `index.js`
    directly — see `docs/API_NOTES.md`). Two corrections to plan
    assumptions: `getInboxWithStatus` exists but the README's method
    table omits it entirely (source is authoritative); and `register()`
    is a hard prerequisite before the agent can send anything, on Ping's
    mainnet-only contracts — not previously called out.
  - `src/ping/pollOnce.ts` — one poll cycle as pure, fully-tested logic:
    skip broadcasts, skip already-replied messages, extract a contract
    address from message content, run the decision core, reply with a
    formatted outcome, never let one message's failure stop the others.
    9 tests.
  - `src/ping/pollLoop.ts` — the recurring runner wrapping `pollOnce`:
    advances the block cursor across cycles, sleeps between them, stops
    cleanly on an abort signal. 2 tests, including that the cursor from
    cycle N actually gets passed into cycle N+1's `getInboxWithStatus`
    call (not just that one cycle works in isolation).
  - `src/ping/pingChainClient.ts` — real adapter over the verified
    `ping-onchain` API, plus a hand-written ambient `.d.ts`
    (`src/types/ping-onchain.d.ts`, the package ships no types) covering
    only the surface actually used.
  - `scripts/live-ping-listener.ts` — the real entry point, written and
    type-checked, **never run**.
  - **Real architecture gap found while wiring this, not previously
    visible**: Ping has no testnet deployment at all — mainnet only. This
    project's `SpendGuard` is currently Sepolia-only (Day 2). A live Ping
    message therefore can't yet trigger a live `SpendGuard` payment in
    the same run; the two halves are each proven independently (Days 3-5
    for the payment/memory/x402 leg, this entry for the Ping leg) but not
    against each other on one chain. Before recording the real demo:
    either deploy `SpendGuard` (+ funded USDC) to Base mainnet, or plan
    for a staged demo that shows the two legs separately. Flagged for a
    human decision, not resolved here.
  - 24 TS tests total now (was 13 after Day 5), all passing, plus
    lint/typecheck/build/`forge test` all green.
  - **Registration and any real send are deliberately not done.** Same
    reasoning as the Day 5 mainnet x402 test: real, irreversible,
    *public* spend (permanently visible on Basescan tied to the agent's
    address) — needs explicit user go-ahead, not an autonomous call.
- **Day 8**: done. `README.md`, `docs/LIMITATIONS.md`, `docs/THREAT_MODEL.md`
  written; both harnesses run live against the real deployed testnet
  contract, 2026-08-26.
  - `pnpm live:deletion-test`
    (`scripts/live-deletion-test.ts`) — the gate this project is judged
    on, proven end-to-end: call 1 (miss → real payment) → call 2 (hit →
    zero payment) → delete `.sibyl-memory-demo/memory.db` live → call 3,
    same contract → miss again → real payment again. All three outcomes
    matched expectations; PASS.
  - `pnpm live:escalation-demo`
    (`scripts/live-escalation-demo.ts`) — proposed a 200_000 payment
    (above the deployed `humanApprovalThreshold` of 150_000), confirmed
    `PaymentPending` with no funds moved, then called `ownerApprove` as
    the deployer/owner key and confirmed `PaymentApproved` + `PaymentSent`
    in the same receipt. Does not demonstrate the check auto-completing
    after approval — that's not built (see `docs/LIMITATIONS.md`'s
    "no automatic resume after approval").
  - **Real bug caught running this live, not by reading code**: the first
    version of the escalation script verified state with a
    `publicClient.readContract({ functionName: "pending" })` call right
    after each write, and got **stale data back both times** — `exists`
    and `approved` both read `false` immediately after transactions that
    had already returned `status: "success"`, confirmed correct
    (`exists:true, approved:true`) moments later via `cast call`. The
    public multi-node RPC almost certainly lacks sticky routing. Fixed by
    verifying exclusively from each transaction's own mined receipt/event
    instead of a follow-up read — see `docs/API_NOTES.md`'s new note
    under Base Sepolia / SpendGuard. This is now the enforced rule
    everywhere in this codebase that verifies a write.
- **Production-hardening pass** (2026-08-28, between Day 8 and Day 9):
  resolved all six items from the post-Day-8 limitations review, at
  production-grade depth for the code, with mainnet execution deliberately
  held at a gate (per this file's own "explicit user go-ahead" rule for
  real spend, applied consistently).
  - **Owner key custody**: `SpendGuard.sol` gained a hand-rolled
    queue-then-execute timelock (1hr recommended) on `setPolicy`/
    `withdraw` — the two functions that can unilaterally change future
    behavior or drain funds. `ownerApprove`/`ownerReject` deliberately
    keep zero added delay (they're the human-in-the-loop control itself,
    not a bypass — a second delay on top would double-gate the escalation
    demo beat). Also added two-step ownership transfer
    (`transferOwnership`/`acceptOwnership`), a zero-code path to swap in a
    Safe later. No multisig built now — judged disproportionate to the
    few-dollar balance this project actually holds on a hackathon
    timeline; documented as deferred, not dropped, in
    `docs/THREAT_MODEL.md`.
  - **Unbounded budget/rate logs**: replaced with fixed-capacity ring
    buffers, sized by a closed-form formula derived from the policy's own
    bounds (`rateLogCapacity >= rateMax`; `budgetLogCapacity >= rateMax *
    (ceil(budgetSeconds/rateSeconds)+1)`), validated on every policy
    change. `_windowSum`/`_windowCount` now scan a fixed number of slots,
    not every payment ever issued. Constructor signature changed (delay +
    capacities + inline initial policy, bootstrapped atomically instead of
    a separate post-deploy `setPolicy` call) — this forced a near-total
    rewrite of `test/SpendGuard.t.sol`'s `setUp()`, budgeted for and done;
    48 tests now pass (was 40-ish), plus `via_ir = true` added to
    `foundry.toml` since the wider constructor tripped solc's stack-depth
    limit.
  - **Conviction-tier vs "safety verdict" framing**: `verdict` renamed to
    `tier` throughout the TS core (`TokenVerdictRecord`, `IntelligencePort`,
    `HandleOutcome`) — compiler-guided, so every call site got caught.
    `PLAN.md`/`CLAUDE.md`'s "token safety/health check" language corrected
    to "builder-conviction check"; `README.md` gained an explicit
    statement of what `/api/evaluate` actually returns (a conviction tier,
    not a safety/scam verdict), which it never stated before. The
    Problem-statement framing ("is this token safe" as the motivating user
    question) was kept — that's honest scene-setting, not a claim about
    what the check itself returns.
  - **Auto-resume after escalation approval**: `resumeAfterApproval` (new,
    `src/decisionCore.ts`) plus a new `ResumableChainPort.checkPendingResolution`
    (`src/chain/spendGuardClient.ts`) — scans for `PaymentApproved`/
    `PaymentRejected` events since the request's origin block (never a
    `pending()` state read, consistent with the Day 8 stale-read rule).
    `src/ping/pollLoop.ts` now tracks pending requests cross-cycle the same
    way it already tracked `lastProcessedBlock`, and auto-detects/resumes
    them without spamming a reply every cycle while still pending. Proven
    by a new harness, `scripts/live-escalation-resume-demo.ts` — this
    finally closes the gap the Day 8 escalation-demo entry above
    explicitly named ("does not demonstrate the check auto-completing
    after approval").
  - **Retry/backoff**: new `src/lib/retry.ts` (exponential backoff, full
    jitter), wired per-client per the three-state model, not blindly
    everywhere — `SibylMemoryClient` reads retry, writes reconcile via
    `memory_recall` before resending rather than blind-resending;
    `X402IntelligenceClient` blind-retries the same tx hash on a network
    failure only (safe because of the 120s single-use window), and a
    retry landing 409 now throws a distinguishable
    `IntelligenceResultUnrecoverableError`; `SpendGuardChainClient` never
    resends once a tx hash exists, only retries polling that hash's
    receipt; `PingChainClient` retries reads, never writes (real mainnet
    spend, no idempotency key to make a resend safe). Ping's three-state
    failure-mode writeup was missing entirely before this — backfilled
    into `docs/API_NOTES.md`, closing a real gap against `CLAUDE.md`'s own
    "map failure modes before writing the client" rule.
  - **Ping(mainnet)/SpendGuard(Sepolia) mismatch**: built and dry-run
    everything needed for a mainnet deploy — `foundry.toml`'s
    `base_mainnet` profile, `script/DeployMainnet.s.sol` (separate file
    from `Deploy.s.sol`, never a flag/branch, so the free testnet path can
    never accidentally broadcast to mainnet), `NETWORK=mainnet` +
    `MAINNET_*` env scaffolding in `src/config.ts`/`.env.example`,
    `scripts/live-ping-register.ts`, `scripts/live-mainnet-smoke.ts`.
    `DeployMainnet.s.sol` was dry-run successfully against a local anvil
    instance (fake chain, zero real funds) — constructor args and policy
    math deploy cleanly. **Nothing has been broadcast to real Base
    mainnet or funded with real money** — that needs the user's explicit
    go-ahead and a funded wallet, per this file's own established rule for
    every other real-spend action (Day 5's mainnet x402 test, Day 6-7's
    Ping registration). See `README.md`'s "Going to mainnet" section for
    the exact remaining steps and the ~0.01 ETH + ~$2.50–3.00 USDC minimal
    funding target.
  - Full regression green throughout: `pnpm lint && pnpm typecheck &&
    pnpm test && pnpm build` (66 tests, up from 24) and `forge test` (56
    tests, up from 40-ish).
  - **Self-review, not skipped**: `CLAUDE.md`'s "Review gates" require
    `reliability-auditor`/`dx-auditor` to PASS before calling a task done.
    Neither is registered as an invokable subagent in this session (same
    gap Day 3-4 already hit), even though both are sitting in
    `.claude/agents/` — applied both checklists by hand instead. Caught a
    real bug this way: `SpendGuardChainClient.requestPayment`'s retry
    fetched a fresh nonce on every attempt, so a network failure *after* a
    real broadcast (response merely lost) could sign and send a second,
    independently valid transaction — a genuine double-payment risk on a
    contract that moves real funds. Fixed by pinning one nonce across the
    whole retry sequence, with a regression test proving it. Also found
    and fixed two silent-failure logging gaps (`pollOnce.ts`'s catch block,
    `sibylMemoryClient.ts`'s reconcile path) and one real dx gap: **zero
    CI existed** despite `CLAUDE.md` requiring it — closed by adding
    `.github/workflows/ci.yml` (lint/typecheck/build/test/forge-test as
    separate jobs, adapted from the `integration-dev-experience` skill's
    template) plus a CI status badge on the README.
- **Local environment fix + first real live proof of item 5** (2026-08-28,
  same day): this Windows machine's `.venv/` for `sibyl-memory-mcp` was
  created on a different machine (`/home/userdammy/...` shebang paths,
  `.venv/bin/python` an empty file) and never worked here, which is why
  item 5's live proof was missing from the hardening-pass entry above.
  Fixed using Sibyl's own documented install path
  (`pip install 'sibyl-memory-cli[mcp]'` against a real system Python,
  not the `curl | sh` one-liner also documented — piping an unreviewed
  remote script into a shell isn't something to run unexamined) and
  pointing `SIBYL_MEMORY_MCP_COMMAND` at the new install.
  - `pnpm live:escalation-resume-demo` finally ran for real — and caught
    two live-only bugs unit tests couldn't: (1) `checkPendingResolution`'s
    very first check after a real `ownerApprove` came back `still_pending`
    because Base Sepolia's public RPC hadn't yet indexed `getLogs` for the
    block that had *just* mined — correct, documented behavior for the
    mechanism itself (the real poll loop just tries again next cycle), but
    the demo script only checked once; fixed by giving it a short retry
    loop. (2) A fresh `ownerApprove` call reverted "invalid request" on
    its very first attempt in both `live-escalation-demo.ts` and
    `live-escalation-resume-demo.ts` — viem's automatic pre-broadcast gas
    estimate (an `eth_call`) hit the same stale-RPC-node lag as the
    original Day 8 bug, on a call site that had no retry wrapper; fixed
    both with `withRetry`. Neither is a bug in `SpendGuard.sol` or in
    `resumeAfterApproval`/`checkPendingResolution` themselves — both are
    exactly the class of "public multi-node RPC has no sticky routing"
    issue this project already has a standing rule for, just two call
    sites that hadn't been hardened against it yet because they'd never
    actually been run live before today.
  - Re-ran `live:deletion-test` (the actual judged gate) end-to-end after
    the fix too: miss → real payment → cache hit → delete live → miss
    again → real payment again. PASS, same as every prior run.
  - `pnpm lint && pnpm typecheck && pnpm test && pnpm build` and
    `forge test` all still green (67 / 56 tests) after these fixes.
- **Gateway direction (Coral as a paid service for *other* agents, not
  just a payer)** (2026-08-31): scoped a second mode that sits next to the
  existing one, not replacing it. Existing behavior — Coral pays Sibyl for
  a check, caches it — is "Direction A." This is "Direction B": another
  agent pays *Coral* over Ping for the same conviction-tier lookup, and
  Coral's own cache is what lets it avoid re-paying Sibyl on a hit while
  still collecting its own fee — the "cache to avoid paying twice" idea
  applied outward instead of just inward.
  - **Message shape**: a caller Pings a message containing both a token
    contract address (40 hex chars) and a payment tx hash (64 hex chars) —
    distinguishable by length alone, no keyword needed. A message with
    only an address keeps using the existing free path unchanged (that's
    Coral's own/demo entry point, untouched).
  - **Payment target: the deployed `SpendGuard` contract itself**, not a
    new wallet or contract. `SpendGuard.usdc` is already a public
    `immutable` — reading it gives the exact token address to check —
    and `SpendGuard` is already the treasury Coral's own outgoing spend
    draws from. Routing gateway fees there means an inbound payment funds
    the exact balance that's already policy-gated on the way out; no new
    receiving authority is introduced, keeping the existing invariant
    ("the agent's own wallet must never hold direct USDC transfer
    authority") intact.
  - **Verification is receipt-only**, same principle as every other
    payment check in this codebase: read the claimed tx hash's real mined
    receipt, decode the USDC `Transfer` event, confirm it moved ≥ the
    gateway fee to `SpendGuard`'s address. Never trusts the caller's claim
    or a balance snapshot (a snapshot can't prove *this specific*
    transfer happened).
  - **Replay protection lives in Sibyl Memory** (new `incoming_payment`
    category, keyed by tx hash, checked-then-marked-consumed before any
    paid work happens) — deliberately, so deleting Sibyl Memory breaks
    Direction B's double-spend guarantee too, not just Direction A's
    cache. Consumption is marked *before* the downstream check runs, which
    means a downstream failure (rare — same failure class already
    documented in `docs/API_NOTES.md`'s "dangerous ordering" note) burns
    that payment with no cache entry delivered; a retry needs a fresh
    payment. Accepted tradeoff over the alternative (mark-after, which
    reopens a race where two concurrent requests both pass the
    not-yet-consumed check on the same tx hash before either marks it).
  - **No new Solidity contract.** Direction A needed `SpendGuard.sol`
    because Coral doesn't fully control where its own outgoing funds go
    without a policy gate; Direction B only needs Coral to *read* a
    receipt, which needs no on-chain enforcement of its own.
  - Implementation: `IncomingPaymentPort`/`SpendGuardIncomingPaymentVerifier`
    (`src/gateway/incomingPaymentVerifier.ts`), `handleGatewayQuery` in
    `decisionCore.ts` (delegates to the existing `handleTokenQuery` once
    payment is verified and consumed — cache hit/miss/pending/blocked all
    behave exactly as they already do), `MemoryPort.wasPaymentConsumed`/
    `markPaymentConsumed`, and a `pollOnce.ts` branch that only activates
    when both an address and a tx hash are present in one message.
- **Day 9**: record demo, run the whole thing a second time to confirm it
  survives a repeat (Technical Execution criterion). The mainnet-vs-staged
  decision from the hardening pass above needs to be made before this.
- **Day 10**: buffer, submit, two build-log posts tagging @sibylcap and
  Base.
- **Generalizing the job cache beyond Sibyl** (2026-09-04): the core
  (`handleTokenQuery`, `TokenVerdictRecord`, `MemoryPort.recallTokenVerdict`/
  `rememberTokenVerdict`, `IntelligencePort.checkToken`) was hardcoded to
  one hired agent's shape (contract address in, Sibyl conviction tier
  out) since Day 1's original data-model sketch above — never a drift,
  the original design just never grew past the one integration that got
  built. Generalized so a future different hired-agent integration is
  architecturally possible without another rearchitecture: `handleTokenQuery`
  → `handleJobQuery(hiredAgentId, input, deps, requester?)`,
  `TokenVerdictRecord` → `JobRecord`, `IntelligencePort.checkToken` →
  `invoke(input, paymentTxHash): Promise<{output, raw, sourceEndpoint}>`,
  the fixed `token_verdict` memory category replaced by a caller-supplied
  `hiredAgentId` (`sibyl-conviction-check` for the one real integration
  today, centralized in `scripts/lib/liveHarness.ts`).
  - Compiler-guided rename, same proven approach as the earlier
    `verdict`→`tier` rename (see "Naming/framing hardening" above): change
    the types first, let `tsc --noEmit` turn the whole build red, fix
    every call site it points at. Touched all three entry points (HTTP
    gateway, Ping, ACP), all `scripts/live-*.ts` harnesses, and every
    test file with a hand-written port fake — no shared fixture helper
    exists in this codebase, so `test/decisionCore.test.ts` and
    `test/http/httpGatewayServer.test.ts` each got the same mechanical
    edit independently, matching how the prior rename handled it.
  - **Deliberate scope boundary**: internal generalization only, external
    wire shapes unchanged. `GET /check`'s JSON response and ACP's job
    deliverable both still say `tier`, mapped explicitly at each entry
    point's own response-building edge — the live, public HTTP gateway
    and its deployed frontend widget (`coral-landing/index.html`, reading
    `data.tier`) depend on that exact shape, and propagating the rename
    to the wire level had zero architectural payoff.
  - A `reliability-auditor`-adjacent design-review pass (a dedicated Plan
    agent, since this touched the most heavily-tested part of the
    codebase) caught real issues before implementation: a pending-escalation
    key collision risk across hired agents sharing the same input space
    (fixed by composing `hiredAgentId` into the underlying MCP key inside
    `SibylMemoryClient`, not just the port signature), and confirmed
    `httpGatewayServer.ts`'s response construction needed to become an
    explicit field-by-field build rather than `{...outcome}` — a blind
    spread would have leaked the new `output` field name into the live
    JSON response and silently broken the deployed widget.
  - Verified live, not just by the type checker: re-ran
    `pnpm live:deletion-test` and `pnpm live:day5-smoke` against the real
    deployed Base Sepolia `SpendGuard` after the change — cache miss →
    real payment → cache hit → delete → real payment again, all still
    correct under the new `hiredAgentId`-scoped category. `pnpm lint &&
    pnpm typecheck && pnpm build && pnpm test` (143 tests) and
    `forge test` (56 tests) all green.
  - Real, accepted consequence: existing Sibyl Memory entries under the
    old fixed `token_verdict` category become unreachable after this
    deploys — the same effect as deleting memory (an already-tested,
    understood event this project is judged on), not data loss. See
    `docs/DEPLOYMENT.md`'s redeploy section and `docs/API_NOTES.md`'s
    generalization entry for the full detail.
