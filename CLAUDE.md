# Repo instructions for Claude Code

## Mission
An agent, built for the Sibyl Labs Hackathon (Sep 1–10, 2026), that:
receives inbound messages over **Ping** (Sibyl Labs' on-chain
agent-to-agent messaging protocol on Base), consults **Sibyl Memory** —
over the standard MCP interface (`sibyl-memory-mcp`) — before ever acting,
and only pays for a fresh builder-conviction check via Sibyl's **x402**
Intelligence Endpoints when memory has no cached tier or the cached one
is stale. (The endpoint scores builder conviction/community seed/on-chain
proof of work, not a safety/scam verdict — see docs/LIMITATIONS.md.) That payment is gated by an on-chain **`SpendGuard`** contract on
Base: the agent's wallet can only *request* a payment; the contract, not
the agent's own reasoning, decides whether it's allowed. Full design
rationale, verified facts, and the demo script live in `PLAN.md` — read it
before making an architectural change, not just this file.

## Source of truth, in order
1. Behavior actually reproduced (a script run, a response logged) — not
   behavior assumed an API has. `PLAN.md`'s "Verified facts" section is
   the running record of this; add to it, don't let claims outrun it.
2. Current official docs for Sibyl Memory, Ping, and the x402 endpoints.
3. This repo's own tests and deployed contract source
   (`contracts/SpendGuard.sol`).
4. This file and `PLAN.md`.
5. Model output / assumptions — lowest priority, must be checked against
   1–4 before shipping.

## Non-negotiable invariants
- `SpendGuard.requestPayment` must never transfer USDC without every one
  of the four policy rules (allowlist, max-per-payment, budget-window,
  rate-limit) passing first, in that fixed order.
- Above `humanApprovalThreshold`, a payment must never execute without a
  separate `ownerApprove` call — the agent proposes, it does not execute
  alone past that line.
- The agent's own wallet must never hold direct USDC transfer authority —
  only `SpendGuard` moves funds.
- The decision core must always check Sibyl Memory before attempting an
  x402 payment. Deleting the memory DB must visibly change behavior (the
  cold-start-recall / deletion-test gate this whole project is judged on)
  — if a code path can pay without checking memory first, that's a bug,
  not an optimization.
- Memory content itself must never leave the local machine. Only account
  metadata crosses the network (matches Sibyl's own falsifiable privacy
  claim in `_capcheck.py` — don't build anything that quietly regresses
  that boundary).

## Engineering rules
- Before integrating any external API that moves money or state (x402,
  Ping, a chain RPC), spend real time (or delegate to a subagent) mapping
  its failure modes: what does a timeout mean, is a 2xx synchronous or
  just "accepted", what's the actual idempotency guarantee. Write it down
  in `docs/API_NOTES.md` before writing the client.
- Use pnpm. Commit `pnpm-lock.yaml`. Never mix in a `package-lock.json` or
  `yarn.lock`.
- Keep TypeScript strict. Do not suppress type, lint, or test failures to
  get something green.
- Write or update a failing test before changing behavior, not after.
- Any script that needs a funded wallet, a live API key, or talks to
  mainnet gets a name prefix (`live:`, `deploy:`) so it's never
  accidentally run in CI or by a reviewer cloning the repo cold. Testnet
  and the local mock x402 server are the default for everything else —
  see `PLAN.md`'s Cost plan.
- Don't read `.env*`, keystores, or secret directories. Don't deploy to
  mainnet from an agent session.

## Required checks
Run the real package scripts once scaffolded. Intended gate list:
```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
forge test          # SpendGuard rule + escalation coverage
```
Wire all into CI on every push and PR, not just the contract test step. A
CI that only runs `forge test` is not testing the decision core or the
Ping/MCP wiring that ships with it.

## Durable docs
Create and keep these current — they cost an afternoon and are the
difference between a project that looks finished and one that just looks
demoed:
- `docs/API_NOTES.md` — measured behavior of Sibyl's MCP tools, Ping's
  message mechanics, and the x402 `directTx` flow, once the Day 1
  verification pass in `PLAN.md` closes those open items.
- `docs/LIMITATIONS.md` — state plainly: `SpendGuard`'s budget/rate logs
  are unbounded loops (fine at demo volume, wouldn't scale as-is); the
  mock x402 server trusts any well-formed tx hash and doesn't verify
  on-chain; no TEE/EIP-1271 (the `directTx` alt path made that
  unnecessary, not skipped for lack of trying).
- `docs/THREAT_MODEL.md` — the agent wallet can only call
  `requestPayment`, never holds transfer authority; the owner can
  `withdraw` at any time; who's trusted at each layer (Ping sender
  identity, Sibyl's x402 verification, the contract's own state).

## Review gates
After implementing a change, before calling it done, run the relevant
subagent:
- reliability/error-handling/retry/logging changes, or anything touching
  `SpendGuard`, the x402 client, or Ping: `reliability-auditor`
- CI, scripts, packaging, repo structure, onboarding changes:
  `dx-auditor`

A task is not done until its subagent returns PASS.
