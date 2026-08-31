# Coral

[![CI](https://github.com/Dami904/coral/actions/workflows/ci.yml/badge.svg)](https://github.com/Dami904/coral/actions/workflows/ci.yml)

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
`tier` — not a safety or scam determination. This agent caches and replies
with that `tier` as-is; it never invents a safe/unsafe verdict the
underlying data doesn't support. See `docs/LIMITATIONS.md` and
`docs/API_NOTES.md` for the verified request/response shape.

No graph or traversal claims either: Sibyl's own homepage calls its memory
"graph-structured"; the shipped SDK exposes no relation-traversal API. This
build doesn't borrow that framing.

## Where memory is load-bearing

The entire critical path lives in one function:
[`handleTokenQuery` in `src/decisionCore.ts`](src/decisionCore.ts). Every
call checks Sibyl Memory (`memory.recallTokenVerdict`) **before** any
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
`handleTokenQuery` path Coral's own queries use: a cache hit costs Coral
nothing further and the gateway fee is pure margin; a cache miss has Coral
pay Sibyl out of the fee that was just collected. No second smart
contract was needed for this — `SpendGuard` already gates Coral's own
outgoing spend, so incoming gateway fees only ever needed a receipt read,
not a new enforcement layer. See `PLAN.md`'s "Gateway direction" entry for
the full design rationale and `docs/LIMITATIONS.md`'s "Gateway (Direction
B)" section for its accepted edge cases (a narrow concurrent-reuse race
on the same tx hash, no refund on a downstream failure).

## Partner stacks (Base)

Both exercised live, both independently checkable on Basescan:

- **Ping (A2A messaging)** — real npm package (`ping-onchain`), poll-loop
  listener (`src/ping/`) built and unit-tested; the real mainnet send is
  deliberately not yet executed (see `docs/LIMITATIONS.md`) but the code
  path is complete and verified against the real SDK source.
- **On-chain-enforced spend policy** — `SpendGuard.sol` deployed to Base
  Sepolia, real payments exercised live end-to-end:
  - Day 3 payment: [`0xc7047761a5ce321dca8ef37add4d708af1fc2b8e71e580b2c0d85b0a410afca2`](https://sepolia.basescan.org/tx/0xc7047761a5ce321dca8ef37add4d708af1fc2b8e71e580b2c0d85b0a410afca2)
  - Day 5 payment (full directTx flow): [`0x369508bea3fb14a11035b4f2b30d34ac7d355f1ae7cdb23261a2493f44c6e320`](https://sepolia.basescan.org/tx/0x369508bea3fb14a11035b4f2b30d34ac7d355f1ae7cdb23261a2493f44c6e320)
  - Contract: [`SpendGuard`](https://sepolia.basescan.org/address/0xc243822863f1770a7187EbD630D150379e58EEdE) · [`MockUSDC`](https://sepolia.basescan.org/address/0xfC10f0A357c74318451A583C30A1fb5C8c7a2407)

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
- [`PLAN.md`](PLAN.md) — the full running design log: architecture,
  verified facts, demo script, and day-by-day build history.

## Going to mainnet (prepared, not executed)

Everything needed to run this on Base mainnet is built and ready — a
mainnet Foundry profile, `script/DeployMainnet.s.sol`, env scaffolding
(`NETWORK=mainnet` + `MAINNET_*` vars in `.env.example`), a Ping
registration script, and a mainnet smoke-test script — but **nothing here
has been broadcast or funded**. This is deliberate: real money and a real,
public, irreversible mainnet footprint should never happen from an
automated build session (see `CLAUDE.md`). When you decide to go live, the
remaining steps are:

1. **Rehearse for free**: `anvil --fork-url $BASE_MAINNET_RPC_URL` (or even
   a plain local `anvil`), then `forge script script/DeployMainnet.s.sol:DeployMainnet
   --rpc-url http://127.0.0.1:8545 --broadcast` to confirm the deploy
   itself is clean before spending anything real.
2. **Fund two wallets** — a deployer/owner wallet and an agent wallet —
   with roughly **0.01 ETH total** on Base mainnet (covers the deploy,
   Ping registration, and a full demo run plus one repeat run's worth of
   gas + Ping message fees). Keeping this minimal isn't just about cost:
   until a multisig replaces the single owner EOA (see
   `docs/THREAT_MODEL.md`), a smaller balance is also a smaller blast
   radius.
3. `pnpm deploy:mainnet` — the real broadcast.
4. Transfer **~$2.50–3.00 real USDC** to the deployed guard address (after
   verifying it on Basescan) — enough for roughly 8–12 real `/api/evaluate`
   calls at the confirmed $0.25 price.
5. `pnpm live:ping-register` — one-time, real gas, registers the agent
   wallet on Ping.
6. `pnpm live:mainnet-smoke` — one real end-to-end query, proving the full
   wiring before recording the demo.

Each of these is a single, separate, deliberate command — never chained or
automated together.

## License

MIT — see [`LICENSE`](LICENSE).
