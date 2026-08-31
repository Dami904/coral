# Threat model

Kept short and current. States trust assumptions explicitly so they can
be checked, not meant to be exhaustive. See `docs/LIMITATIONS.md` for
what's simplified and `PLAN.md` for the design rationale.

## Trusted parties / keys

- **Agent wallet** (`AGENT_PRIVATE_KEY`, `SpendGuard.agent`) — can only
  call `SpendGuard.requestPayment`. Never holds direct USDC transfer
  authority; every path from this key to real funds moving goes through
  the guard's own rule checks first.
- **Owner wallet** (`DEPLOYER_PRIVATE_KEY`, `SpendGuard.owner`) — can queue
  and, after a 1-hour delay, execute a new policy (`queueSetPolicy` /
  `executeSetPolicy`) or a withdrawal (`queueWithdraw` / `executeWithdraw`);
  can call `ownerApprove`/`ownerReject` on an already-proposed escalated
  payment **immediately, with no added delay** (deliberate — see below);
  and can transfer ownership via a two-step `transferOwnership`/
  `acceptOwnership`. This is the single most powerful key in the system.
  **Why `ownerApprove`/`ownerReject` skip the timelock**: they only ever
  act on one specific, previously-capped (`maxPerPayment`) payment that the
  agent already proposed — they *are* the human-in-the-loop control this
  system is built around, not a bypass of it. Adding a second delay on top
  would double-gate the same escalation and break the core demo beat
  (propose → owner approves on camera → funds move in one transaction).
- **Vendor/payTo address** — the only address the guard will ever send
  money to (enforced by the allowlist check, first of the four rules).
  Receives funds automatically once policy checks pass; holds no other
  power over the system.
- **Sibyl's x402 payment wallet** (`agent.paymentWallet` in the real
  `/api/evaluate` 402 response, distinct from `agent.identityWallet` —
  see `docs/API_NOTES.md`) — trusted to actually deliver a real evaluation
  once paid via the `directTx`/`X-PAYMENT-TX` flow. Independently
  verifiable against Sibyl's own published agent registration at
  `/.well-known/agent-registration.json`, not just trusted from one
  response.
- **`sibyl-memory-mcp` (local process)** — trusted to store and return
  what this agent writes/reads. Runs entirely locally against a SQLite
  file (`SIBYL_MEMORY_DB`); no third party has network access to it.
- **Ping message senders** — untrusted. Anyone can send the agent a
  message; message content is treated as attacker-controlled input (see
  "What's explicitly out of scope" below).
- **Gateway callers (Direction B)** — untrusted, same as any Ping sender,
  plus a payment claim: a message carrying both a contract address and a
  tx hash (`src/ping/pollOnce.ts`'s `extractGatewayRequest`) is only ever
  served after `SpendGuardIncomingPaymentVerifier` independently confirms
  that exact tx hash moved real USDC to `SpendGuard`'s own address — the
  claim itself is never trusted. See `docs/LIMITATIONS.md`'s "Gateway
  (Direction B)" section for the accepted check-then-mark race.

## What happens if each one is compromised

- **Agent private key leaks**: attacker can call `requestPayment`
  repeatedly, but every call still passes through the guard's allowlist,
  max-per-payment, budget-window, and rate-limit checks in that fixed
  order (`test/SpendGuard.t.sol` proves the order is enforced, including
  a live mutation test — see `PLAN.md` Day 2). Worst case is bounded by
  `budgetAmount` per `budgetSeconds` window, capped further by
  `maxPerPayment` per call and `rateMax` calls per `rateSeconds` — not an
  unbounded drain. The attacker also cannot redirect funds anywhere but
  the allowlisted vendor address.
- **Owner private key leaks**: bounded by the 1-hour timelock on
  `executeWithdraw`/`executeSetPolicy` — an attacker who queues a
  withdrawal or a malicious policy change cannot execute it for an hour,
  giving a real (if manual) window to notice and react, e.g. by moving
  funds via a legitimate `queueWithdraw` first, or watching for
  `WithdrawQueued`/`PolicyQueued` events. It does **not** fully close the
  risk: within that hour the same key can still call `ownerApprove` on any
  pending escalated payment immediately (deliberately undelayed, see
  above) — bounded by the same allowlist/`maxPerPayment` checks the agent
  path already enforces, so this doesn't let a leaked owner key redirect
  funds anywhere but the allowlisted vendor or exceed per-payment/budget/
  rate limits. This key still needs the strongest protection in the
  system; it currently sits in a plaintext local `.env` file (fine for a
  hackathon testnet demo, unacceptable for anything holding real funds —
  see "out of scope" below).
- **Vendor/payTo private key leaks**: no impact on this system's own
  funds — it only ever *receives* USDC the guard already decided to send.
  Whoever holds it can move what's already been paid to it, which is
  expected vendor behavior, not a breach of this project's guarantees.
- **`sibyl-memory-mcp` / the local SQLite file is deleted or corrupted**:
  by design, not a security failure — this is the cold-start-recall gate
  the whole project is judged on. The agent stops knowing it already has
  an answer and starts re-paying for checks it used to get free; it does
  not lose the ability to function, and it never pays *more* than the
  policy allows regardless of memory state, since `SpendGuard`'s rules
  are enforced independently of whatever the agent believes about its
  cache.
- **A Ping sender is malicious**: they can make the agent believe any
  string is a token contract address, prompting a real (policy-gated)
  payment for a worthless check, and can write arbitrary content that
  ends up stored via `memory_remember`. `sibyl-memory-mcp` fence-scrubs
  and size-caps anything read back out (see `docs/API_NOTES.md`), so a
  malicious body can't inject instructions into anything that later reads
  it as trusted context. It cannot, however, make the agent pay *more*
  than `SpendGuard`'s own limits allow, or pay to any address but the
  allowlisted vendor — the contract's rules don't trust the Ping layer at
  all.
- **A gateway caller is malicious (Direction B)**: they can claim a
  payment tx hash that doesn't exist, doesn't pay `SpendGuard`, or pays
  less than the gateway fee — all three are independently checked against
  the real mined receipt and rejected before any paid work runs (see
  `IncomingPaymentPort`). Reusing a genuinely valid payment tx hash is
  blocked by the `incoming_payment` replay ledger in Sibyl Memory, with
  one narrow exception: two requests citing the *same* tx hash sent
  concurrently could both pass the check before either marks it consumed
  — bounded to at most one extra Sibyl check, itself still fully
  policy-gated by `SpendGuard` the same as any other outgoing spend (see
  `docs/LIMITATIONS.md`).

## What's explicitly out of scope

- **Owner key custody.** No multisig, no hardware wallet requirement — a
  single EOA private key in a local `.env` file, protected only by the
  1-hour timelock on `setPolicy`/`withdraw` (see above), not a second
  signer. Fine for a hackathon testnet demo; a Safe or hardware wallet as
  `owner` (a zero-contract-change swap via `transferOwnership`) is the
  next thing to add before this design could hold meaningfully real
  value.
- **Rate/budget log pruning.** Unbounded arrays scanned on every call —
  see `docs/LIMITATIONS.md`. Not a security hole at demo volume, would
  become a gas-cost/DoS-adjacent concern at real scale.
- **Verifying Ping message senders are who they claim.** Ping messages
  are on-chain and the `from` address is authentic (it's the actual
  sender), but nothing here verifies the sender is a "real" or trustworthy
  agent/human beyond that — same trust level as any other public,
  permissionless messaging system.
- **RPC provider trust.** `https://sepolia.base.org` / Base's public
  mainnet RPC are trusted for both reads and the eventual mined-receipt
  event decoding that `SpendGuardChainClient` treats as ground truth
  (`docs/API_NOTES.md`). A malicious or compromised RPC could theoretically
  lie about receipt contents; no independent verification (e.g. a second
  RPC, or Basescan cross-check) is implemented.
- **The x402 endpoint's own correctness.** This project trusts Sibyl's
  `/api/evaluate` result once payment is verified via `X-PAYMENT-TX` — no
  independent verification that the returned `conviction_score`/`tier` is
  itself accurate or unmanipulated.

## Known limitations

See `docs/LIMITATIONS.md` for the full list — most relevant here: no
automatic resume after an escalated payment is approved (a human must
also manually trigger the follow-up check today), and the Ping/SpendGuard
chain mismatch (Ping is mainnet-only, `SpendGuard` is currently
Sepolia-only) means the two halves of the trust boundary described above
haven't yet been exercised together in one live run.
