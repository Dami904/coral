# API notes — measured behavior, not assumed

Written before the decision-core client code, per `CLAUDE.md`'s engineering
rules. Everything below was reproduced directly (a script run, a real
testnet call) — dated, so it can be told apart from earlier assumptions in
`PLAN.md`.

## Sibyl Memory (`sibyl-memory-mcp` 0.1.14 / `sibyl-memory-client` 0.7.0)

Verified 2026-08-26 by installing both packages into an isolated venv and
reading `sibyl_memory_mcp/server.py` directly, then round-tripping
`set_entity`/`get_entity`/`write_event` against a scratch SQLite DB via the
same `MemoryClient` class the MCP server wraps.

### Transport
Stdio only (`sibyl-memory-mcp` console-script entry point → `run_stdio()`).
No HTTP/SSE mode in this version. Our client spawns it as a subprocess via
`StdioClientTransport`; the command is configurable
(`SIBYL_MEMORY_MCP_COMMAND`, default `sibyl-memory-mcp`) since it must be on
`PATH` — document the `pip install sibyl-memory-mcp` prerequisite in the
README, it is not an npm package.

### Storage location — this IS the deletion-test target
Default: `~/.sibyl-memory/memory.db`, overridable via `SIBYL_MEMORY_DB`.
Confirmed live: deleting this file and reopening a client makes
`get_entity` raise `NotFoundError` for a key that existed before deletion —
the gate's "kill memory, does the core function still work" test is a real
file-delete against a real SQLite file, not a mock. For the demo, pin
`SIBYL_MEMORY_DB` to a project-local path so "delete the DB" is unambiguous
and doesn't touch the operator's real Sibyl memory.

### The 8 tools — exact signatures (confirmed from source, not the marketing page)
| Tool | Args | Success shape | Not-found shape |
|---|---|---|---|
| `memory_remember` | `category, name, body` | `{ok:true, category, name}` | n/a (upsert) |
| `memory_recall` | `category, name` | `{ok:true, entity:{id, tenant_id, category, name, status, body, created_at, updated_at}, _untrusted_context}` | **raises** `ToolError` (isError=true), JSON message `{code:"NOT_FOUND", ...}` |
| `memory_record_event` | `kind, body, category?, name?` | `{ok:true, event_id, kind}` | — |
| `memory_get_state` | `key` | `{ok:true, key, body, updated_at, _untrusted_context}` | returns `{ok:false, code:"NOT_FOUND", key}` as a **normal result** (isError=false) |
| `memory_search` | `query, limit?, tiers?` | `{ok:true, query, count, results[], _untrusted_context}` | empty query → `{count:0}`, not an error |
| `memory_list` | `category?, limit?` | `{ok:true, category, count, results[], _untrusted_context}` | — |
| `memory_forget` | `category, name, reason?` | `{ok:true, archived:{category, name}}` | — |
| `memory_set_state` | `key, body` | `{ok:true, key}` | — |

**Load-bearing asymmetry**: `memory_recall`'s cache-miss path is a
protocol-level error (`isError:true`, catch + JSON.parse the message,
`code==="NOT_FOUND"`), but `memory_get_state`'s cache-miss path is a
*successful* result with `ok:false`. The decision core only uses
`memory_recall` (WARM entity cache) and `memory_record_event` (COLD
journal) per `PLAN.md`'s data model, so only the `recall` shape matters —
but don't copy its error-handling into anything that later calls
`get_state`, they're not the same contract.

**Wire-format gotcha, only visible by actually running it (2026-08-26,
`live:day3-smoke`)**: an error result's text content is NOT the raw
`json.dumps(payload)` string `_err()` builds in `server.py`. The
underlying Python `mcp` SDK's own tool dispatcher wraps it first:
```
Error executing tool memory_recall: {"error": "NotFoundError", "message": "...", "code": "NOT_FOUND"}
```
Reading `server.py` alone gives no hint of this prefix — it's added by a
layer underneath the file we read. `SibylMemoryClient.callTool`
(`src/memory/sibylMemoryClient.ts`) extracts the JSON substring starting
at the first `{` rather than assuming the whole text parses. Any other
MCP client (Python, another TS project) hand-rolled against this server
needs the same tolerance — this is exactly the kind of assumption the
Day 1 read-the-source pass couldn't have caught, and only the live smoke
run did.

### Idempotency
`memory_remember` is documented and confirmed idempotent on
`(category, name)` — a second call with the same key overwrites, not
appends. This is exactly the WARM-entity cache-refresh semantics
`PLAN.md`'s data model needs; no separate upsert-guard logic required.

### Failure modes (three-state model)
- **CONFIRMED**: `{ok:true, ...}` returned — the write/read genuinely
  happened against the SQLite file (synchronous, local, no network hop
  inside the tool call itself).
- **FAILED**: `ToolError` with a parseable `{code, message}` — validation
  error, cap-exceeded (2 MB free-tier body cap), tier-gated. These are
  real rejections, safe to surface and stop, not retry blind.
- **UNKNOWN**: the subprocess itself dies, the stdio pipe breaks, or the
  MCP `CallTool` request times out. Unlike an HTTP call there's no partial
  "did it commit" ambiguity for reads (SQLite transactions are local and
  atomic), but a `memory_remember` call whose response was lost due to a
  broken pipe is genuinely unknown — the local disk write may have
  committed before the pipe died. Treat a lost response after
  `memory_remember` as UNKNOWN: re-read via `memory_recall` before deciding
  whether to write again, don't blindly resend (it's idempotent so a
  resend is harmless here, but blind resend is not the reason to skip the
  check when a payment write happened first — see below).

### The dangerous ordering (why memory writes come *after* payment, not before)
Per `PLAN.md`'s `handle()`: on a cache miss, the guard is asked to pay
*before* `memory_remember` is called with the fresh verdict. If the MCP
write then fails (crashed subprocess, disk full, cap exceeded), the agent
has a real on-chain payment with no cache entry for it — next inbound
message for the same contract will pay again. This is a real gap, not
hypothetical: nothing upstream of the MCP call can guarantee the write
succeeds. Mitigation adopted: the decision core logs the pre-write payment
result (tx hash / requestId, contract, amount) to a local structured log
line *before* attempting `memory_remember`, so a human can reconcile a
lost cache write without re-paying — see `src/decisionCore.ts`. This does
not make the memory write itself idempotent-safe against double-payment;
it makes the failure recoverable instead of silent.

## Base Sepolia / SpendGuard (chain RPC)

Verified 2026-08-26 against the real deployed contracts (see `PLAN.md`
Day 2 entry for addresses) using `https://sepolia.base.org` (Base's public
RPC, no key required — rate limits are unknown/undocumented, worth having
a fallback RPC env var for the live demo).

**Confirmed live (Day 8): read-after-write on this RPC can be stale.**
`scripts/live-escalation-demo.ts`'s first version called
`publicClient.readContract({ functionName: "pending", ... })` immediately
after `requestPayment` and again immediately after `ownerApprove` — both
reads came back showing the pre-write state (`exists:false` and
`approved:false` respectively), even though both transactions had already
returned `status: "success"` from `waitForTransactionReceipt`, and a
direct `cast call` moments later showed the correct post-write state.
Almost certainly the public RPC load-balances across multiple backend
nodes without sticky routing, so a read right after your own write can
land on a node that hasn't replicated it yet. **Practical rule for this
codebase, now enforced everywhere it matters**: never verify a write by
reading contract state back afterward — decode the mined receipt's own
event log instead (what `SpendGuardChainClient` already did; the
escalation harness was fixed to match, see its file header).

### `requestPayment` does not give you its return value once broadcast
`requestPayment(payTo, amount) returns (bool sentImmediately, uint256 requestId)`
is only directly readable via `eth_call` (simulation) — a normal signed
`eth_sendTransaction` from the agent EOA gets you a tx hash, not a decoded
return value. The actual outcome must come from the **emitted event** in
the mined receipt: `PaymentSent`, `PaymentBlocked`, or `PaymentPending`
(one and only one of these fires per call, verified by reading
`SpendGuard.sol`'s four `return` branches). `SpendGuardChainClient`
(`src/chain/spendGuardClient.ts`) sends the transaction, waits for the
receipt, and decodes that event as the sole source of truth — it does
*not* call `eth_call` first, because nothing in the Day 3–4 scope consumes
a pre-mine preview value, and a call whose result is thrown away is worse
than not making it. If a fast "is this likely to be blocked" read is
needed later (e.g. for perceived latency in a Ping reply), add
`simulateContract` back deliberately at that point, feeding a real
consumer — chain state between simulate and mine can still change (another
payment consuming the same budget/rate window), so the simulated result
would never become the returned outcome, only ever a hint.

### Three-state model applied to the tx lifecycle
- **CONFIRMED**: receipt fetched, `status === 1`, event decoded.
- **FAILED**: receipt fetched, `status === 0` (reverted) — should not
  normally happen since the contract returns/emits `PaymentBlocked`
  instead of reverting for policy failures; a real revert here means
  something unexpected (e.g. `usdc.transfer` failed inside
  `_issueAndSend`, or the guard ran out of gas). Treat as FAILED, log the
  full revert reason.
- **UNKNOWN**: `eth_sendTransaction`/`waitForTransactionReceipt` times out
  or the RPC connection drops. The tx may still be pending or may have
  been dropped from the mempool. Do **not** resend with a fresh nonce —
  that risks a genuine double-send if the original lands late. Poll the
  same tx hash / nonce first; only replace-by-fee (same nonce, higher gas)
  if confirmed still pending, never fire a second logically-new
  `requestPayment` call for the same decision until the original nonce is
  resolved one way or the other.

### Nonce ownership
The agent's `PRIVATE_KEY` is the only signer calling `requestPayment`
(`onlyAgent` modifier). Since this project runs one decision-core process
against one agent EOA, nonce management is a single monotonic counter, not
a pool — but the code must still read the nonce from the chain
(`eth_getTransactionCount(..., "pending")`) rather than assuming a local
counter is authoritative, in case a prior process run (or the deploy
script's owner key doing something unrelated — different account, doesn't
apply here but worth the general habit) left in-flight transactions.

### Confirmed on-chain state (2026-08-26, chain 84532)
`SpendGuard.owner`, `.agent`, `.maxPerPayment` (500_000), `.humanApprovalThreshold`
(150_000) and the guard's mUSDC balance (100e6) all read back exactly as
set by `script/Deploy.s.sol` — see `PLAN.md` Day 2 entry for addresses and
the read values.

### Not yet verified — resolve before Day 6-7
- `ping-onchain`'s actual message-fee getter and poll-loop behavior under
  real network conditions (source was read, per `PLAN.md`, but not yet
  exercised end-to-end from this codebase).

## Sibyl x402 `/api/evaluate` — request shape (verified 2026-08-26, closes a real gap)

`PLAN.md`'s Day 1 capture recorded the 402 challenge body but never
confirmed **how a specific token gets submitted for evaluation** — a
free (no-payment) `curl -i https://sibylcap.com/api/evaluate` closes
that:

```json
"extensions": {"bazaar": {"info": {
  "input": {"type": "http", "method": "GET",
    "queryParams": {"token": "0x...", "twitter": "handle", "github": "user"}},
  "inputSchema": {"properties": {
    "token": {"type": "string", "description": "ERC-20 contract address on Base"},
    "twitter": {"type": "string"}, "github": {"type": "string"}},
    "required": ["token"]}
}}}
```

So: `GET /api/evaluate?token=<contract>` (required; `twitter`/`github`
optional and unused by this project), same request repeated with the
`X-PAYMENT-TX` header once paid. This is load-bearing — without it there
was no verified way to tell the endpoint *which* contract to evaluate.
`src/intelligence/x402Client.ts` builds the request this way.

The same free probe also surfaced Sibyl's own agent registration
(`agent.registry`, `agent.identityWallet` vs `agent.paymentWallet`,
verifiable at `/.well-known/agent-registration.json`) — worth a line in
`docs/THREAT_MODEL.md` when that's written: Sibyl's payment wallet is
independently checkable against their published identity, not just
trusted from this one response.

**Mock server gap, by design**: `mock-x402-server/server.mjs`'s
`challenge()` response doesn't include an `extensions.bazaar` block and
ignores query params entirely — it was written before this fact was
verified. Left as-is rather than reverse-engineered to match, since the
mock's job is proving client *request* logic (headers, retry-on-402,
single-use enforcement), not mirroring every response field; the client
sends `?token=` regardless of what the mock does with it.

### Real bug found live: the paid response's own tier field name (2026-09-09)

The endpoint's own `extensions.bazaar.info.output.example` (captured
above) documents the paid response as `{"conviction_score":24,"tier":
"high_conviction",...}`. **That's wrong — not what the live endpoint
actually returns.** Confirmed via a real mainnet ACP job (WETH,
`0x4200...0006`, real $0.25 payment, tx logged in `PLAN.md`): the real
field is `conviction_tier`, and the value itself is a bare word
(`"medium"`), not the `_conviction`-suffixed form the example implies:

```json
{"agent":"SIBYL #20880","version":"evaluate-v1","token":"0x4200...0006",
 "conviction_score":19,"conviction_max":30,"conviction_tier":"medium",
 "criteria":{"builder_conviction":{...},"community_seed":{...},
 "onchain_proof":{...}},"summary":"WETH conviction score: 19/30 (medium)...",
 ...}
```

**Real, live consequence before this was caught**: `X402IntelligenceClient
.deriveTier()` only checked for `raw.tier`, which doesn't exist on the
real response — so it silently fell through to `"unknown"` on every real
call. No error was thrown (the HTTP round trip and payment both
genuinely succeeded), so this shipped a wrong-but-not-crashing result:
the first real ACP-mediated mainnet job (job 77783, real payment
confirmed by the guard's on-chain balance dropping by exactly $0.25)
delivered `{"output":"unknown",...}` to the buyer instead of the real
`"medium"` tier.

**Fixed**: `deriveTier()` now checks `conviction_tier` first (the
confirmed-live field), falling back to `tier` only if `conviction_tier`
is absent — never assumed away entirely, since `raw_response.version`
(`"evaluate-v1"`) hints a different API version could genuinely use the
documented field name. `mock-x402-server/server.mjs`'s wire response
renamed to match (`conviction_tier`, not `tier`) so the mock stays
representative of the real behavior, not the endpoint's own inaccurate
docs. This is exactly the kind of gap `CLAUDE.md`'s "source of truth"
ordering exists to catch — the endpoint's self-documented schema was
trusted over reproduced behavior, and it was wrong.

### x402 client failure modes (three-state model)
- **CONFIRMED**: HTTP 200 with `X-PAYMENT-RESPONSE` header matching the
  submitted tx hash — parse the verdict body.
- **FAILED**: HTTP 400 (malformed hash) or 409 (hash already used,
  single-use enforced) — real rejections, don't retry with the same hash.
- **UNKNOWN**: request timeout or connection drop while relaying
  `X-PAYMENT-TX`. The 120-second single-use window means a blind retry
  risks nothing extra (a second attempt with the *same* hash either
  succeeds if the first response was merely lost, or 409s harmlessly if
  the first actually landed) — this is the one place in this codebase
  where retrying a "write" (the HTTP relay, not the payment itself,
  which already happened on-chain before this call) is safe, precisely
  because the endpoint declares single-use semantics keyed on the hash.

## Ping (`ping-onchain` 0.1.5) — real API surface, verified 2026-08-26

Verified by installing the real package and reading `index.js` directly
(not the README, which is incomplete — see below).

### No testnet — every call here is real, mainnet, irreversible spend
`Ping.fromPrivateKey`/`readOnly` default `rpcUrl` to
`https://mainnet.base.org`. There is no Sepolia deployment of the v1/v2/
Diamond contracts — unlike `SpendGuard` and the x402 client, there is no
free/cheap way to exercise a real Ping send. Registration and every
`sendMessage`/`broadcast` cost real ETH (message fee is dynamic, fetched
from the contract — confirmed by reading `getMessageFee()`'s
implementation, not assumed). Treat any live Ping test the same way as
the mainnet x402 smoke test: deliberate, costly, public (permanently
visible on Basescan tied to the agent's real address), and gated on
explicit user go-ahead — not something to run from an agent session on a
whim.

### `getInboxWithStatus` is real but undocumented in the README
The README's method table omits it entirely; it exists in `index.js` with
full JSDoc. Trust the source over the README here. Its `replied` flag is
coarser than "was this exact message answered": it's
`replyBlock !== null && replyBlock > msg.block`, where `replyBlock` is the
sender's *most recent* block we've sent them anything — i.e. "have I sent
this sender anything since this message arrived," not per-message
tracking. Fine for a poll loop that also tracks its own `lastProcessedBlock`
cursor (which this project does), not fine as the sole source of truth if
a sender sends multiple messages between polls.

### Registration is a hard prerequisite, not mentioned in `PLAN.md`
`sendMessage`/`broadcast` throw `NotRegistered` if the sender isn't
registered on Ping (`register(username)`, one-time, costs gas). This
project's agent wallet (`0x004e643E3C9043755d623637F59537c49E6613F7`) is
**not yet registered** — it can't reply to anything until it is, and that
registration is itself a real mainnet transaction requiring the same
go-ahead as any other real spend here.

### Architecture consequence
Because every real Ping interaction costs money and can't be sandboxed,
the poll-loop / reply logic (`src/ping/pollOnce.ts`) is built behind a
`PingPort` the same way `MemoryPort`/`ChainPort`/`IntelligencePort` are —
fully unit-tested with fakes, zero real network calls in `pnpm test`. The
real adapter (`src/ping/pingChainClient.ts`) wraps the verified SDK calls
above 1:1 and is exercised live only with explicit confirmation.

### Ping client failure modes (three-state model), backfilled for retry/backoff work
Not written before Day 6-7's client code (a real gap against `CLAUDE.md`'s
own "map failure modes before writing the client" rule) — added here once
`PingChainClient` needed retry logic, per the same rule applied late rather
than skipped.
- **`getInboxWithStatus` (read)**: CONFIRMED = array returned, however
  short. FAILED = doesn't really apply — there's no documented "rejection"
  shape distinct from a thrown error for this call. UNKNOWN = RPC
  timeout/connection drop. Safe to blind-retry: it's a read, no funds move,
  no double-send risk. `PingChainClient.getInboxWithStatus` retries on any
  thrown error, same as every other read-side port in this codebase.
- **`sendMessage`/`register` (writes)**: CONFIRMED = `{hash, receipt}`
  returned. FAILED = `NotRegistered` thrown (the sender isn't registered) —
  a real, non-transient rejection, never retried. UNKNOWN = RPC timeout or
  connection drop mid-send. **Deliberately not retried**, unlike x402's
  UNKNOWN case: there is no client-visible idempotency key on a Ping send
  (no single-use hash, nothing to key a safe duplicate off of), and every
  send is real, irreversible mainnet spend. A blind resend risks sending
  the same reply twice; a lost send risks not sending at all — between
  those two failure shapes, this codebase chooses to fail loud rather than
  risk a duplicate public, on-chain message. `pollOnce.ts`'s existing
  per-message try/catch means one failed reply never stops the others, and
  a fresh poll cycle gets another chance at the same underlying decision.

## Virtuals Protocol ACP (Agent Commerce Protocol) — verified 2026-09-03

Researched before writing any client, per this file's own standard.
**Implemented** in `src/acp/acpProvider.ts` (pure, unit-tested requirement
parsing/deliverable formatting) and `scripts/live-acp-provider.ts` (the
real long-lived Provider process) — see `docs/LIMITATIONS.md`'s ACP
section for what's still unverified (idempotency on a dropped
`fund()`/`submit()`, real-counterparty job flow).

Confirmed live: `AcpAgent.create()` successfully authenticates against
Virtuals' real backend using real dashboard-issued credentials
(`ACP_WALLET_ADDRESS`/`ACP_WALLET_ID`/`ACP_SIGNER_PRIVATE_KEY`) and reads
back the agent's own registry entry via `getAgentByWalletAddress` — not
yet confirmed against a real funded job (no registered offering / real
counterparty at time of writing).

**A real bug found in the SDK's own published example, live**: `seller.ts`
(the Provider-side example in `@virtuals-protocol/acp-node-v2`) calls
`AcpAgent.create({ provider: ... })`, but the actual `createAcpClients`
function it delegates to destructures `evmProvider`/`solanaProvider` —
never `provider`. As published, the example throws
`"At least one provider (evmProvider or solanaProvider) must be
provided."` at runtime. Confirmed by tracing `clientFactory.ts` directly,
not by running the example itself. Use `evmProvider:`, not `provider:`.

**A second confirmed unit-conversion trap**: `AssetToken.usdc(amount,
chainId)` takes `amount` as a human-readable decimal (e.g. `0.5` for
$0.50) — confirmed reading `assetToken.js`: it feeds straight into
viem's `parseUnits` with no further scaling, unlike this codebase's own
`*_USDC_6DP` convention (a raw integer, e.g. `500_000n`). Converting the
wrong way would set a job's budget a million times too high.
`src/acp/acpProvider.ts`'s `usdc6dpToDollars` is the one place this
conversion happens, with a regression test.

**Real early-failure resource leak, found running the actual script**:
before the fix in `scripts/live-acp-provider.ts`, a thrown error during
setup (e.g. "offering not found," the exact case that surfaced this) left
the local mock x402 server and the Sibyl Memory connection open, so the
process hung indefinitely instead of exiting — confirmed by running it
for real against live dashboard credentials, not caught by any test.
Fixed by closing both in a catch block wrapping everything after they're
opened, before rethrowing.

**A fourth real bug, caught by review before ever running against a real
job**: an earlier draft used one `PRICE_USDC_6DP` constant for two
different prices — what Coral pays Sibyl per check, and what an ACP
buyer pays Coral for the job. Split into `SIBYL_PRICE_USDC_6DP` (fixed,
matches Sibyl's real price) and the registered offering's own
`priceValue` (read from the registry, whatever's actually configured on
the dashboard) — setting a buyer's job budget to Coral's *cost* rather
than the *dashboard-configured offering price* would have silently
ignored any price the offering was actually registered at.

**Two real concurrency bugs found by `reliability-auditor`, before any
real job existed to trigger them**: neither the `job.funded` handler nor
the resume-poll `setInterval` tick serialized against a duplicate/
overlapping invocation for the same job — a replayed SSE event, or a
resume attempt slower than `RESUME_POLL_MS`, could have run
`handleJobQuery`/`resumeAfterApproval` + `session.submit()` twice for
one logical job. Fixed by extracting `httpGatewayServer.ts`'s existing,
already-tested per-contract lock into `src/lib/keyedLock.ts` and reusing
it here, keyed by `jobId`, for both paths.

- **Real current package: `@virtuals-protocol/acp-node-v2`** on npm
  (confirmed via `Virtual-Protocol/acp-node-v2` on GitHub, `main`,
  last pushed 2026-08-19). v1 (`@virtuals-protocol/acp-node`, no `-v2`
  suffix) is deprecated — don't use it.
- **Base Sepolia is genuinely supported** (confirmed reading
  `src/core/chains.ts`: `EVM_TESTNET_CHAINS = [baseSepolia, bscTestnet,
  robinhoodTestnet]`) — unlike Ping (mainnet-only, see above), ACP has a
  real free testnet path, matching this repo's Sepolia-first pattern.
  `EVM_MAINNET_CHAINS = [base, robinhood]`.
- **Architecture is event-driven**, not phase-polled like v1:
  `AcpAgent.on("entry", ...)` over a persistent SSE connection. A
  Provider is a **long-lived process** holding that connection open —
  structurally like `live-ping-listener.ts`, not like the request/response
  free HTTP gateway. No inbound webhook URL needed.
- **Provider registration is a web dashboard signup**
  (`app.virtuals.io/acp/new`), required before any SDK call — the
  README states this as a hard prerequisite, not optional. **Not** a
  smart-contract call.
- **Wallets are Privy-managed, not a raw EOA.** The dashboard issues a
  `walletAddress` + `walletId`; a `signerPrivateKey` is generated
  separately under the agent's Signers tab and is **not** a
  `0x`-prefixed hex key like every other secret in this repo — it's a
  base64 PKCS#8 P-256 "Privy authorization key" (~155 chars, starts
  `MIGH`). None of the existing viem-based `ChainPort` wallet handling
  reuses here as-is; a new adapter layer is needed
  (`PrivyAlchemyEvmProviderAdapter`, per the SDK).
- **Job lifecycle is real on-chain transactions at every step**
  (confirmed reading `src/core/operations.ts`'s `CreateJobParams`/
  `SetBudgetParams`/`FundParams`/`SubmitParams`/`CompleteParams`), not a
  pure off-chain webhook flow: `job.created` → provider `setBudget()` →
  client `fund()` (escrows on-chain) → provider `submit(deliverable)` →
  evaluator `complete()`/`reject()` (releases/returns escrow). Each
  transition is a real signed tx via the Privy adapter, surfaced as an
  `entry` SSE event.
- **Maps onto `handleGatewayQuery` (Direction B — another agent pays
  Coral), not `handleJobQuery`.** ACP's Provider role gets paid for a
  job; that's the same direction as Coral's existing Ping-based gateway
  mode, not Coral's own outbound SpendGuard-gated spend to Sibyl.
- **Not yet verified** (next required step before writing a client, per
  this file's own rule): exact timeout/retry semantics per phase,
  idempotency guarantees on a dropped `fund()`/`submit()` call (need to
  read `evmAcpClient.ts`'s actual send/wait logic), whether registration
  itself costs a fee or requires KYC (gated behind the dashboard, not
  discoverable from the SDK/README), and the per-job protocol fee
  schedule.

## Generalizing the job cache beyond Sibyl (verified 2026-09-04)

Coral's core (`src/decisionCore.ts`) used to cache exactly one thing — a
token contract address's conviction tier from Sibyl's x402 endpoint —
with every type and method name hardcoded to that single use case
(`TokenVerdictRecord`, `recallTokenVerdict`, `CATEGORY = "token_verdict"`,
`IntelligencePort.checkToken(contract, ...): Promise<{tier, ...}>`).
Generalized so a future different hired-agent integration is
architecturally possible without another rearchitecture — real interface
changes, not just a rename, but deliberately without inventing a second
fake integration (no real second hired agent exists yet, and this
project's own rule is never to guess at unverified external API
behavior).

**What changed**: `MemoryPort.recallJob(hiredAgentId, input)`/
`rememberJob(hiredAgentId, input, record: JobRecord)` replace the
contract-specific pair; `IntelligencePort.invoke(input, paymentTxHash):
Promise<{output, raw, sourceEndpoint}>` replaces `checkToken`;
`handleTokenQuery` is now `handleJobQuery(hiredAgentId, input, deps,
requester?)`. Sibyl Memory's own MCP interface needed zero changes —
confirmed by reading `sibyl_memory_mcp/server.py`'s tool signatures
(above): `category`/`name` are arbitrary caller-controlled strings with
no protocol-level constraint, so `hiredAgentId` doubling as the memory
category is not a new pattern, just a new value.

**Wire-level compatibility was originally a deliberate, separate
decision** to keep both `GET /check`'s JSON response and ACP's job
deliverable saying `tier`, not `output`, since both `coral-landing`'s
widget and any external ACP buyer already depended on that exact shape.
**Both wire points have since been renamed to `output`** (2026-09-07,
PLAN.md's "HTTP wire field rename" and "ACP wire field rename" entries):
`GET /check`/`GET /resume` first, `src/acp/acpProvider.ts`'s
`formatAcpDeliverable` next. `coral-landing/index.html`'s widget was
updated in the first change. No real ACP buyer has ever successfully
completed a purchase against the live `coral_cache` offering (the buyer
side's `wallet_prepareCalls` 400 — no ACP-designated testnet USDC — is
still unresolved as of this writing), so there was no live external
consumer of the old `tier` field to break.

**Real, accepted consequence, confirmed live**: `hiredAgentId` (e.g.
`sibyl-conviction-check`, centralized in `scripts/lib/liveHarness.ts`'s
`SIBYL_HIRED_AGENT_ID`) is now the Sibyl Memory category the job cache
writes under, replacing the old fixed `"token_verdict"` constant.
Existing cache entries under the old category become unreachable on
redeploy — the same effect as deleting memory (an already-tested,
understood event in this project via the deletion-test gate), not a bug.
Re-ran `pnpm live:deletion-test` and `pnpm live:day5-smoke` against the
real deployed Base Sepolia `SpendGuard` after this change: cache miss →
real payment → cache hit → delete → real payment again, all still work
correctly under the new category scheme — confirmed live, not just by
the type checker passing.

### `GET /search` — non-authoritative memory_search lookup (2026-09-08)

Added `SibylMemoryClient.searchSimilar(query, limit?)` and a new
`GET /search?q=&limit=` route on the HTTP gateway, for querying the job
cache by something other than the exact contract address `/check`
requires (a name, ticker, or any text that was ever cached).

**Deliberately kept outside the payment-gating path.** `searchSimilar` is
not on `MemoryPort` and is never called from `decisionCore.ts` —
`handleJobQuery`'s cache-hit-vs-pay decision still only ever uses
`recallJob`'s exact `(category, name)` match. `HttpGatewayDeps.searchSimilar`
is an optional plain function, not the concrete `SibylMemoryClient`, so a
deployment that omits it just gets `501` on `/search`; every existing
`/check`/`/resume` behavior, test, and invariant is untouched.

**Entity-tier hit shape confirmed live, not assumed** (2026-09-08): wrote
a probe entity via `memory_remember`, then called
`memory_search(query, tiers:"entity")` for it. Real response:
```json
{"tier":"entity","key":"weth-test-token","category":"coral_scope_probe",
 "body":{"hiredAgentId":"...","output":"high_conviction", ...},
 "snippet":"...","rank":-0.000004375,"ts":"..."}
```
`body` is the stored `JobRecord` as-is — a different shape from the
journal-tier `JournalHit` above (`{evaluated, acted, forward, extra}`),
so `searchSimilar`'s mapper reads `body.output`/`body.checked_at`
directly rather than reusing `JournalHit`'s decode logic.

**`tiers:"entity"` is passed explicitly, not omitted.** Per the live tool
description for `memory_search`: omitting `tiers` runs
`multi_record_search()`, which abstains (`count:0`) the moment one query
token is content-shaped with zero corpus support anywhere — a precision
gate meant for cross-tier queries, not Coral's case of "search this one
cache." `tiers:"entity"` calls `client.search()` directly and skips that
gate, so an ordinary partial-name query reliably finds an exact substring
match instead of sometimes silently returning nothing.

## ACP buyer side (verified 2026-09-04)

Researched before writing `scripts/live-acp-buyer-test.ts`, same standard
as the provider side. The SDK's own `src/examples/basic/buyer.ts` example
has the **same real bug** already found in `seller.ts`: it calls
`AcpAgent.create({ provider: ... })`, but `createAcpClients` only ever
checks `evmProvider`/`solanaProvider` — use `evmProvider:`.

- **Discovery**: `agent.getAgentByWalletAddress(walletAddress)` for a
  known seller (Coral's case), or `agent.browseAgents(keyword, params?)`
  for keyword search.
- **Job creation**: `createJobByOfferingName(chainId, offeringName,
  providerAddress, requirementData, opts?)` — simpler than the example's
  manual `getAgentByWalletAddress` + `offerings.find(...)` +
  `createJobFromOffering`, since both Coral's wallet address and offering
  name are already known. `requirementData` is a plain object; the SDK
  stringifies it.
- **Funding**: on `budget.set`, `await session.fetchJob(); await
  session.fund();` — no amount, reads the on-chain-set budget directly.
- **Receiving the deliverable — evaluation mode matters.** Omitting
  `evaluatorAddress` defaults to skip-evaluation: the job jumps straight
  to `job.completed`, and `job.submitted` (which carries
  `entry.event.deliverable`) never fires on the buyer side — you'd never
  see the answer print. Passing `evaluatorAddress: buyerAddress` (self-
  evaluation) makes `job.submitted` fire with the deliverable, at the
  cost of one extra `session.complete()` call to release payment.
  `live-acp-buyer-test.ts` uses self-evaluation deliberately, to actually
  show what came back.
- **Funding token is NOT Coral's own MockUSDC.** The ACP contract's
  designated Base Sepolia USDC is `0xECc22a8F6fD62388498fBa19813E214605a2BDb3`
  (`USDC_ADDRESSES[baseSepolia.id]`, `dist/core/constants.js`) — a
  completely separate token from `0xfC10f0A357c74318451A583C30A1fb5C8c7a2407`
  (Coral's `MockUSDC`, used by `SpendGuard`). Two unrelated testnet
  tokens for two unrelated systems.
- **Gas is very likely sponsored on Base Sepolia.** `ERC20_SPONSORED_CHAINS`
  includes `baseSepolia`, and `privyAlchemyEvmProviderAdapter.js`
  constructs real `paymaster`/`paymaster_data` fields (Alchemy's ERC-4337
  gas sponsorship) — a buyer wallet likely doesn't need native Base
  Sepolia ETH, only the ACP-designated USDC above. **Not fully
  verified**: whether sponsorship is unconditional or needs an
  Alchemy-side policy Virtuals configures per-agent.
- **Still not verified** (server-side/dashboard rules, out of reach from
  SDK source): whether a buyer needs the same `app.virtuals.io/acp/new`
  registration flow as a seller, and whether `createJobFromOffering` does
  any client-side requirement-schema validation before the chain call.
- **Buyer registration answered, partially**: a separate buyer identity
  (own `ACP_BUYER_*` credentials, no seller-side dashboard setup beyond
  what was already needed to obtain those credentials) successfully
  authenticated and reached `createJobByOfferingName` against Coral's
  real registered offering — so full seller-style onboarding is NOT a
  hard prerequisite for a buyer to at least initiate a job.
- **The ACP-designated Base Sepolia USDC faucet question is answered: no
  public faucet, root-caused not guessed (2026-09-06).** The job-creation
  call reproducibly hit a `400 Bad Request` from
  `api.acp.virtuals.io/wallets/alchemy-rpc`'s `wallet_prepareCalls`
  method on every attempt. Root cause, confirmed on-chain via `cast call
  balanceOf`, not assumed: the buyer wallet held `0` of the
  ACP-designated token (`0xECc22a8F6fD62388498fBa19813E214605a2BDb3`) —
  a faucet claim had landed 20 USDC on **Circle's real Base Sepolia USDC**
  (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) instead, a completely
  different token from the one ACP actually requires (see the entry
  above — this is now the *third* distinct testnet USDC-shaped token in
  play across this repo: Coral's own `MockUSDC`, Circle's real testnet
  USDC used by the redeployed `SpendGuard`, and this ACP-designated one).
  Checking the ACP token's on-chain holder count showed only ~35
  addresses ever held it — strong evidence it's a limited/permissioned
  token Virtuals distributes manually on request, not a public
  self-serve faucet. **Getting a real ACP buyer job to complete on
  testnet requires asking Virtuals directly (Discord/dashboard support)
  for an allocation to the buyer wallet** — nothing else in this repo can
  work around that.
- **This is a testnet-only problem — confirmed via the SDK's own
  `dist/core/constants.js` (2026-09-06).** `USDC_ADDRESSES[base.id]`
  (Base mainnet) is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — the
  same real, ordinary Circle USDC already used everywhere else mainnet
  is referenced in this repo (Sibyl's real x402 `payTo`/`asset`,
  `MAINNET_USDC_ADDRESS`'s default in `src/config.ts`). The limited
  `0xECc22a8F...` token is Base Sepolia/BSC Testnet/Robinhood-Testnet
  only — Virtuals' own testnet stand-in, not something ACP inherently
  needs. A mainnet buyer with ordinary USDC would hit none of this.
  Also confirmed from the same file: `ACP_CONTRACT_ADDRESSES[base.id]`
  (`0x238E541BfefD82238730D00a2208E5497F1832E0`) differs from the
  testnet ACP contract (`0x0b93793923CD5De81850aF8604a233f3f24d461e`) —
  moving Coral's ACP provider to mainnet means re-registering against a
  different contract, not just swapping the USDC address.

## Privy signer keys can be rotated with no notification (confirmed 2026-09-06)

A Privy-managed wallet's authorization key (the `ACP_SIGNER_PRIVATE_KEY`/
`ACP_BUYER_SIGNER_PRIVATE_KEY` shape, `MIGH...`-prefixed PKCS#8) is not
guaranteed to stay valid for the life of a deployment — Coral's provider
wallet had one silently rotated on Privy/Virtuals' side sometime between
Sep 4 and Sep 6, with no notification to this repo. Every `signMessage`
call (`AcpApiClient.authenticate`, via
`privyAlchemyEvmProviderAdapter.ts`'s `serverPost` to
`api.privy.io/v1/wallets/...`) then failed with a consistent `Server
error 500` — not a `401`/`403`, which is why this reads as a backend
error rather than an obviously-stale-credential error at first glance.

How this was actually diagnosed, not guessed:
- Confirmed Privy's general API was reachable and healthy (a plain
  unauthenticated request returned a normal `308`, not `500`) and the
  host's clock was in sync — ruled out a broad Privy outage or a
  clock-skew signature-validity issue.
- Ran a second, completely independent wallet (`scripts/live-acp-buyer-test.ts`)
  through the identical SDK code path — its `signMessage`/`authenticate`
  call succeeded cleanly. This isolated the failure to one specific
  wallet's credential, not a systemic Privy or SDK problem.
- Confirmed directly, without ever exposing the private key value: `openssl
  pkey -in <keyfile> -pubout -outform DER | base64` derives the public key
  from a PKCS#8 private key; run inside a single remote shell command that
  only ever returned a MATCH/NO-MATCH boolean, this showed the deployed
  key's derived public key did NOT match the public key shown on the
  Virtuals dashboard's Signers tab for that wallet — conclusive proof of a
  stale key, not an inference.

Fix: regenerate the signer on the dashboard (scope it "Virtuals only" —
this wallet never needs to sign anything outside Virtuals/ACP calls) and
redeploy the new key. No code change needed or possible; this is a
third-party credential lifecycle fact, not a bug in this repo.
