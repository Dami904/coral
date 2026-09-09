# Coral

[![CI](https://github.com/Dami904/coral/actions/workflows/ci.yml/badge.svg)](https://github.com/Dami904/coral/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-155%20passing-1A8A5F)
![Foundry](https://img.shields.io/badge/foundry-56%20passing-1A8A5F)
[![Base mainnet](https://img.shields.io/badge/Base%20mainnet-live-0B79A6)](https://basescan.org/address/0xfC10f0A357c74318451A583C30A1fb5C8c7a2407)
![License](https://img.shields.io/badge/license-MIT-blue)

**The agent that never pays twice.**

An agent for the Sibyl Labs Hackathon (Sep 1–10, 2026) that receives
inbound messages over **Ping** (Sibyl's on-chain agent-to-agent messaging
protocol on Base), consults **Sibyl Memory** before ever acting, and only
pays for a fresh token/project evaluation via Sibyl's **x402** endpoint
when memory has no cached verdict or the cached one is stale. That
payment is gated by an on-chain **`SpendGuard`** contract on Base — the
agent's wallet can only *request* a payment; the contract, not the
agent's own reasoning, decides whether it's allowed.

Coral is not itself a memory/cache layer — that's Sibyl Memory, used here
over the standard MCP interface. Coral is the payment-gated decision layer
built on top of it: the part that turns "have I already answered this"
into "then don't pay again," and enforces that on-chain instead of just
hoping the agent remembers to check.

## Demo

[![Coral demo video](https://img.youtube.com/vi/7tjGCRmZ16w/maxresdefault.jpg)](https://youtu.be/7tjGCRmZ16w)

## The problem

Repeat "is this token safe / worth looking at" questions flood crypto
communities. Re-paying for the same check every time is wasteful; never
checking is unsafe; forgetting a past bad verdict is dangerous. This
agent caches verdicts so it only pays once per contract per staleness
window, and proves that dependency is real, not decorative — delete its
memory and it starts paying again for checks it used to answer for free.

## What the paid check actually returns

Sibyl's `/api/evaluate` scores **builder conviction** — community seed,
on-chain proof of work, a `conviction_score` (0–30) plus a categorical
`conviction_tier` — not a safety or scam determination. This agent caches
and replies with that tier as-is (wire field: `output`); it never invents
a safe/unsafe verdict the underlying data doesn't support. See
`docs/LIMITATIONS.md` and `docs/API_NOTES.md` for the verified
request/response shape — including a real bug found live on 2026-09-09:
Sibyl's own self-documented example schema says `tier`, but the real
endpoint returns `conviction_tier`. Fixed in `X402IntelligenceClient`,
with a fallback to `tier` kept in case a different API version uses it.

No graph or traversal claims either: Sibyl's own homepage calls its memory
"graph-structured"; the shipped SDK exposes no relation-traversal API. This
build doesn't borrow that framing.

## Where memory is load-bearing

The entire critical path lives in one function:
[`handleJobQuery` in `src/decisionCore.ts`](src/decisionCore.ts). Every
call checks Sibyl Memory (`memory.recallJob`) **before** any
payment is even considered — not as an optimization, as a hard ordering
enforced by a passing test
(`test/decisionCore.test.ts`: *"checks memory before ever calling the
chain (non-negotiable invariant)"*). Delete the local memory DB
(`SIBYL_MEMORY_DB`, default `~/.sibyl-memory/memory.db`) and the next
lookup for a previously-cached contract is provably a cache miss again —
see `docs/API_NOTES.md`'s Sibyl Memory section for the live-verified
deletion behavior, and `PLAN.md`'s Day 8 entry for the deletion-test
harness proving it end-to-end against the real, deployed testnet
contract.

### How memory made this possible

Without a persistent, queryable cache in front of the payment, every
inbound question about a token would cost real money — the agent would
either have to pay every single time (expensive, wasteful, and slow) or
skip the check entirely (unsafe). Sibyl Memory turns "have I already
answered this" into a fast, free, structured lookup instead of something
the agent has to guess at or re-derive, and its journal
(`memory_record_event`) makes the whole decision trail — cache hits vs.
real payments — trivially inspectable by a human after the fact, not just
by re-reading logs.

## Try it live

Coral's free HTTP gateway is running continuously at
`https://3-216-178-169.nip.io` (a real Base Sepolia deployment, not a
staged demo — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)):

```bash
curl "https://3-216-178-169.nip.io/check?token=0x0000000000000000000000000000000000000001"
```

The landing page (`coral-landing/index.html`) has a live "Try it now"
widget wired to this same endpoint.

## Gateway mode: other agents can pay Coral, too

Everything above is Coral spending its own money to answer its own
queries. `handleGatewayQuery` (`src/decisionCore.ts`) adds the mirror
case: another agent pays *Coral*, over Ping, for the same lookup.

A Ping message carrying both a contract address and a payment tx hash is
treated as a gateway request instead of the free path — no keyword or
prefix convention needed, the two are unambiguous by length alone (see
`extractGatewayRequest` in `src/ping/pollOnce.ts`). The claimed payment is
never trusted on the caller's word: `SpendGuardIncomingPaymentVerifier`
(`src/gateway/incomingPaymentVerifier.ts`) reads the real mined receipt
for that tx hash and decodes the USDC `Transfer` event itself, confirming
it actually moved the required fee to `SpendGuard`'s own address — the
same treasury Coral's own outgoing spend already draws from, so accepting
gateway fees there introduces no new fund-holding authority. Each payment
tx hash can only ever be redeemed once: a replay ledger in Sibyl Memory
(`wasPaymentConsumed`/`markPaymentConsumed`) is checked before, and marked
immediately after, verification — so deleting Sibyl Memory breaks this
double-spend guarantee too, not just the cache.

Once a payment verifies, the request delegates straight into the same
`handleJobQuery` path Coral's own queries use: a cache hit costs Coral
nothing further and the gateway fee is pure margin; a cache miss has Coral
pay Sibyl out of the fee that was just collected. No second smart
contract was needed for this — `SpendGuard` already gates Coral's own
outgoing spend, so incoming gateway fees only ever needed a receipt read,
not a new enforcement layer. See `PLAN.md`'s "Gateway direction" entry for
the full design rationale and `docs/LIMITATIONS.md`'s "Gateway (Direction
B)" section for its accepted edge cases (a narrow concurrent-reuse race
on the same tx hash, no refund on a downstream failure).

## What's real vs. staged

| Piece | Status | Detail |
|---|---|---|
| Sibyl Memory | ✅ Live | Real `sibyl-memory-mcp` over stdio, real SQLite, deletion-tested against both deployed contracts. |
| `SpendGuard`, Base mainnet | ✅ Live | Deployed, Basescan-verified, funded, and paying out real USDC through a real, on-chain-executed policy. |
| `SpendGuard`, Base Sepolia | ✅ Live | Timelocked policy, fixed-capacity ring buffers, two-step ownership. |
| x402 payment, real Sibyl endpoint | ✅ Live | Real `directTx` settlement against Sibyl's production endpoint on mainnet — real USDC paid, real conviction data returned. |
| Coral on Virtuals ACP | ✅ Live | Listed and hireable; one full real job completed end-to-end on mainnet (funded → paid → delivered). |
| Free HTTP gateway | ⏸ Testnet only | Wired to the mock evaluator on purpose — flipping to real mainnet money needs the same fix already applied to the ACP path. |
| Ping messaging | ⏸ Staged | Built and unit-tested against the real SDK. Ping has no testnet — a real send is real, public, irreversible mainnet spend, held for a deliberate go-ahead. |
| Gateway mode (paid, via Ping) | ⏸ Staged | Another agent pays Coral over Ping for the same lookup. Unit-tested against decoded receipts, not yet exercised against a real paying counterparty. |

## Partner stacks (Base)

- **Ping (A2A messaging)** — real npm package (`ping-onchain`), poll-loop
  listener (`src/ping/`) built and unit-tested; the real mainnet send is
  deliberately not yet executed (see `docs/LIMITATIONS.md`) but the code
  path is complete and verified against the real SDK source.
- **On-chain-enforced spend policy** — `SpendGuard.sol`, real payments
  exercised live end-to-end on **both** networks:
  - **Base mainnet** (chain 8453) — [`SpendGuard`](https://basescan.org/address/0xfC10f0A357c74318451A583C30A1fb5C8c7a2407) (verified source), real [Base USDC](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913):
    - Deploy: [`0xf74e724a80bc7e28c170e1f677bfdac0ecfff305126c5d0741fbee9743050d1f`](https://basescan.org/tx/0xf74e724a80bc7e28c170e1f677bfdac0ecfff305126c5d0741fbee9743050d1f)
    - First real escalated payment: [`0xe70d3765e7955850cd22c22345a5e877f358d5776eaff0880ec65bac985ead8b`](https://basescan.org/tx/0xe70d3765e7955850cd22c22345a5e877f358d5776eaff0880ec65bac985ead8b)
    - Policy raised above Sibyl's real price (removes the escalation race for ordinary queries): [queue](https://basescan.org/tx/0x7f6b449f459caab01945c99f8c210cbdf0aac0201becb4797d64d1ec162135e0) · [execute](https://basescan.org/tx/0xb3e8c286dbcf809bcd2275d4484e287ddfd795eb8215485f64e7d7da28280ace)
    - Real ACP-mediated payment (job below), auto-paid: [`0x0f8c8ce6bc987275e9d320dfdb7b66f7d2e24fd629890824fc8939172c5b02d6`](https://basescan.org/tx/0x0f8c8ce6bc987275e9d320dfdb7b66f7d2e24fd629890824fc8939172c5b02d6)
  - **Base Sepolia** (chain 84532) — [`SpendGuard`](https://sepolia.basescan.org/address/0x1367B24C8377F659124f22ABC00fb07e5835404b), real Circle testnet [USDC](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e):
    - [`0xc7047761a5ce321dca8ef37add4d708af1fc2b8e71e580b2c0d85b0a410afca2`](https://sepolia.basescan.org/tx/0xc7047761a5ce321dca8ef37add4d708af1fc2b8e71e580b2c0d85b0a410afca2)
    - [`0x369508bea3fb14a11035b4f2b30d34ac7d355f1ae7cdb23261a2493f44c6e320`](https://sepolia.basescan.org/tx/0x369508bea3fb14a11035b4f2b30d34ac7d355f1ae7cdb23261a2493f44c6e320)
- **Coral on Virtuals ACP** — a third "another agent pays Coral" surface,
  listed on Virtuals' marketplace as offering `coral_cache` (0.1 USDC).
  Job `77783`: a real buyer funded 0.1 real USDC to evaluate WETH's own
  mainnet contract (deliberately uncached, so the miss was genuine) —
  Coral's guard balance dropped exactly $0.25 on-chain (the tx above),
  matching the real Sibyl payment, before the buyer received their
  result. [Listing](https://app.virtuals.io/acp/agents/01a06873-3eee-777e-8f64-5d337d6d6342?tab=console).

## Setup

```bash
pnpm install
cp .env.example .env   # fill in a testnet-funded deployer/agent/vendor wallet
pip install sibyl-memory-mcp   # or point SIBYL_MEMORY_MCP_COMMAND at a venv
```

```bash
pnpm lint
pnpm typecheck
pnpm test         # no secrets, no network calls to anything paid — see below
pnpm build
forge test         # SpendGuard rule + escalation coverage
```

`pnpm test` is fully reproducible cold: no API keys, no funded wallet
required. Anything that needs one is named `live:*` or `deploy:*` and
never runs as part of the default test suite — see the `scripts` block in
`package.json`.

## Docs

- **[Technical docs](https://dami904.github.io/coral/docs.html)** — the
  detailed reference: architecture, every real testnet and mainnet
  transaction, the full test list (all 155 unit + 56 Foundry tests, by
  name), and the trust model. **[Landing page](https://dami904.github.io/coral/)**
  has a live "try it now" widget against the real deployed gateway.
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) — stated plainly: `SpendGuard`'s
  budget/rate logs are now fixed-capacity ring buffers, not unbounded, but
  policy can't be loosened past the capacity fixed at deploy time; the
  owner key has no multisig, only a 1-hour timelock on `setPolicy`/
  `withdraw`; the mock x402 server trusts any well-formed tx hash and
  doesn't verify on-chain; and more.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — the agent wallet can
  only call `requestPayment`, never holds transfer authority; `setPolicy`/
  `withdraw` go through a queue-then-execute timelock; `ownerApprove` is
  deliberately immediate (it's the human-in-the-loop control itself, not a
  bypass of one); who's trusted at each layer.
- [`docs/API_NOTES.md`](docs/API_NOTES.md) — measured behavior of every
  external integration (Sibyl Memory MCP, the chain RPC, x402, Ping),
  written from what was actually reproduced, not assumed.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — running Coral continuously
  (not just a local demo recording) on a persistent-disk VM (AWS Lightsail/
  EC2, or any Ubuntu box) — why an ephemeral-filesystem PaaS breaks the
  memory-persistence invariant this project is judged on, and the
  `systemd`-based setup in `deploy/`.
- [`PLAN.md`](PLAN.md) — the full running design log: architecture,
  verified facts, demo script, and day-by-day build history.

## Mainnet — live, not just prepared

`SpendGuard` is deployed to Base mainnet at
[`0xfC10f0A357c74318451A583C30A1fb5C8c7a2407`](https://basescan.org/address/0xfC10f0A357c74318451A583C30A1fb5C8c7a2407)
(verified source), funded with real USDC, and has paid out real money —
including one full real job hired through Virtuals ACP, end to end. Every
transaction is linked in [Partner stacks](#partner-stacks-base) above, and
the full chronological detail (plus every real testnet transaction and
the complete test list) lives in the
[technical docs](https://dami904.github.io/coral/docs.html).

`humanApprovalThreshold` is deliberately set above Sibyl's real $0.25
price ($0.50, raised from an initial $0.20 via a real, timelocked
`queueSetPolicy`/`executeSetPolicy` pair), so an ordinary real query
auto-pays in one continuous step — no separate human-approval round trip,
and no race against Sibyl's 120-second `directTx` relay window. That race
was real and was lost once, on this project's own first mainnet payment
(a real $0.25 spent with no cached result) — see
`docs/API_NOTES.md`'s x402 section for the full account, root cause, and
fix.

**Still deliberately not done**: real Ping registration and a real Ping
send. Ping has no testnet — a real message is real, public, irreversible
mainnet spend, held for an explicit go-ahead per `CLAUDE.md`'s own rule
against unattended mainnet actions. `pnpm live:ping-register` and the
Ping poll listener are built and unit-tested, ready to run when that
decision is made.

## License

MIT — see [`LICENSE`](LICENSE).
