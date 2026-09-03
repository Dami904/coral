# Limitations

Stated plainly, not to be found by a reviewer first. See `PLAN.md` for the
full day-by-day history and `docs/API_NOTES.md` for the verified facts
behind each of these.

## Contracts (`SpendGuard.sol`)

- **Budget/rate logs are fixed-capacity ring buffers, not unbounded.**
  `budgetLog`/`rateLog` are sized at deploy time (`budgetLogCapacity`/
  `rateLogCapacity`, both `immutable`) via a closed-form formula derived
  from the policy's own bounds (`rateLogCapacity >= rateMax`;
  `budgetLogCapacity >= rateMax * (ceil(budgetSeconds/rateSeconds)+1)`) —
  see `_checkCapacity`. `_windowSum`/`_windowCount` now scan a fixed
  number of slots every call, not "every payment ever." The tradeoff:
  policy can be **tightened** freely post-deploy via `queueSetPolicy`, but
  cannot be **loosened** past the capacity fixed at deploy time without a
  new deployment — `queueSetPolicy`/the constructor revert with
  `"rateMax exceeds fixed capacity"` / `"budget/rate window exceeds fixed
  capacity"` if a proposed policy would need more room than was
  provisioned.
- **No TEE, no EIP-1271 signature validation.** Not an oversight — Sibyl's
  x402 endpoints support a `directTx` payment path (send USDC directly,
  relay the tx hash), which makes both unnecessary: the guard only needs
  to hold USDC and call `transfer()` itself when its own rules pass.
- **Timestamp-window underflow on a very early chain.**
  `_windowSum`/`_windowCount` compute `block.timestamp - budgetSeconds`
  without a floor check; on a chain where `block.timestamp < budgetSeconds`
  (a fresh local anvil instance, not Base itself) this reverts. Never
  triggers on Base mainnet or Sepolia — their timestamps are far larger
  than any reasonable window — so left as-is rather than adding a guard
  for a case that can't happen here. The same assumption now also covers
  the ring buffers' zero-valued unwritten slots (pre-filled at
  construction): they only read as "already expired" once
  `block.timestamp` exceeds the window length, which holds everywhere
  this contract is actually deployed.
- **`owner` is still a single EOA, no multisig.** `setPolicy` and
  `withdraw` now go through a 1-hour queue-then-execute timelock (see
  `docs/THREAT_MODEL.md`), which bounds how fast a compromised or
  malicious owner key can act, but does not require a second signer.
  Given the trivial dollar amount this project actually holds, standing
  up a Gnosis Safe was judged disproportionate to the hackathon timeline.
  Because `owner` is just an `address` with no code-level EOA-vs-contract
  assumption, and two-step ownership transfer (`transferOwnership`/
  `acceptOwnership`) now exists, swapping in a Safe later needs zero
  contract changes — call `transferOwnership(safeAddress)` and have the
  Safe call `acceptOwnership()`.

## Escalation tier — auto-resume after approval

`SpendGuard.ownerApprove` executes the payment on-chain, and the poll loop
now detects that and finishes the job automatically: `src/decisionCore.ts`'s
`resumeAfterApproval` (invoked from `src/ping/pollLoop.ts`'s per-cycle
pending-request tracking) scans for `PaymentApproved`/`PaymentRejected`
events since the request's origin block via
`SpendGuardChainClient.checkPendingResolution` (never a `pending()` state
read — see the stale-read note elsewhere in this file), then runs the same
intelligence-check + cache-write tail a first-touch payment goes through.
Proven end-to-end on Sepolia by `scripts/live-escalation-resume-demo.ts`.
Residual limitation: the pending-request tracking map in `pollLoop.ts` is
in-memory only, same as `lastProcessedBlock` — a process restart loses
track of any request that was pending at the time, and a naive manual
retry (`handleTokenQuery` again for the same contract) still does not
resume it — it calls `requestPayment` fresh, creating a **new** pending
request if still above threshold. No persistence for outstanding pending
requests exists yet, mirroring the same deliberate choice not to widen
`MemoryPort` for poll-loop cursor state.

## `IntelligencePort` / x402

- **`verdict` is a conviction/tier rating, not a safety verdict.** The
  real `/api/evaluate` endpoint scores "builder conviction, community
  seed, on-chain proof of work" (`conviction_score` 0-30 + `tier`) — not
  a scam/rug-pull check. `X402IntelligenceClient` caches `tier` (e.g.
  `"high_conviction"`) as-is. Don't present this project's cached verdicts
  as a safety/scam determination; that's not what Sibyl's data supports.
- **The real mainnet x402 call has not been executed.** `PLAN.md`'s Day 5
  entry: the local-mock half is verified live; the one real mainnet smoke
  test (real USDC to Sibyl's production `payTo`) is deliberately not done
  pending explicit go-ahead. The 120-second `directTx` window's real-world
  behavior is therefore still unverified in practice.

## Ping

- **No testnet exists for Ping at all** — mainnet only. This project's
  `SpendGuard` is currently Sepolia-only (see `PLAN.md` Day 2). A real
  Ping message therefore cannot yet trigger a real `SpendGuard` payment in
  the same run; each half is proven independently, not against the other.
  Resolve before recording the demo: deploy `SpendGuard` (+ funded USDC)
  to Base mainnet, or stage the demo to show the two legs separately.
- **The agent wallet is not registered on Ping** and no real message has
  been sent — registration and any send are real, public, irreversible
  mainnet spend, deliberately not done without explicit go-ahead.
- **The poll cursor (`lastProcessedBlock`) is in-memory only.**
  `runPollLoop` (`src/ping/pollLoop.ts`) does not persist it anywhere; a
  process restart starts over from whatever `startBlock` it's given. No
  Sibyl Memory HOT-state integration for this yet — deliberately kept out
  of scope to avoid widening `MemoryPort` for something that isn't the
  gate's judged mechanism (that's the token-verdict cache, which does
  survive restarts by design).

## Gateway (Direction B) — Coral as a paid service for other agents

`handleGatewayQuery` (`src/decisionCore.ts`) lets another agent pay Coral
over Ping for the same lookup `handleTokenQuery` already does for Coral's
own use — see `PLAN.md`'s "Gateway direction" entry for the design.

- **Check-then-mark race on a reused tx hash.** `wasPaymentConsumed` is
  checked, then `markPaymentConsumed` is written, as two separate calls —
  not one atomic operation. Two concurrent gateway requests citing the
  *same* payment tx hash could both pass the not-yet-consumed check before
  either marks it, both getting served off one payment. Bounded, not
  unbounded: the extra cost is at most one additional Sibyl check Coral
  pays for out of its own `SpendGuard` treasury, itself still fully
  policy-gated (allowlist/max-per-payment/budget/rate) the same as any
  other outgoing spend — this cannot drain funds beyond what `SpendGuard`
  already allows. Closing it fully would need a single atomic
  check-and-mark primitive in Sibyl Memory, which doesn't exist today.
- **No refund on a downstream failure.** `markPaymentConsumed` runs
  *before* the delegated `handleTokenQuery` call, closing the replay
  window immediately. If that downstream call then throws (the same
  `IntelligenceCheckFailedAfterPaymentError`/`CacheWriteFailedAfterPaymentError`
  class already documented above) or resolves to `pending_approval`, the
  caller's payment is already spent with no tier ever delivered and no
  automatic refund path — a retry needs an entirely new payment. Accepted
  tradeoff over the alternative (mark-after, which reopens the race above).
- **Flat, static fee.** `GATEWAY_FEE_USDC_6DP` is one fixed price
  regardless of cache hit/miss or the underlying Sibyl price changing —
  no dynamic pricing, no per-caller discount/allowlist of the kind
  `SpendGuard` applies to Coral's own outgoing spend.
- **Payment verification trusts the same RPC as everything else.**
  `SpendGuardIncomingPaymentVerifier` reads a receipt and decodes a
  `Transfer` event the same way `SpendGuardChainClient` does for outgoing
  payments — see "RPC provider trust" in `docs/THREAT_MODEL.md`, which
  now also covers this read.
- **Not yet exercised live.** Wired into `scripts/live-ping-listener.ts`
  but, like the rest of that script, not run — real use needs a real
  gateway-paying counterparty, which doesn't exist yet.

## General

- **Retry/backoff exists, but only where it's actually safe (`src/lib/retry.ts`).**
  Policy is per-client, per-call, driven by `docs/API_NOTES.md`'s
  three-state (CONFIRMED/FAILED/UNKNOWN) model:
  - `SibylMemoryClient`: reads blind-retry on a transport failure; writes
    don't blind-resend — `rememberTokenVerdict` reconnects and re-reads via
    `memory_recall` before deciding whether to resend; `recordEvent` never
    retries at all (no idempotency key on a journal append — a duplicate
    entry would be worse than one lost entry).
  - `X402IntelligenceClient`: blind-retries the same tx hash on a network
    failure only (the 120s single-use window makes this safe); a retry
    that then hits 409 throws `IntelligenceResultUnrecoverableError`
    instead of the generic single-use error, since that shape means the
    original attempt likely succeeded and its response was what got lost.
  - `SpendGuardChainClient`: retries before a tx hash exists (nothing sent
    yet); once a hash exists, never resends — only retries polling for
    that hash's own receipt, surfacing `TransactionStatusUnknownError` if
    exhausted rather than assuming success or failure.
  - `PingChainClient`: reads retry; writes (`sendMessage`/`register`)
    deliberately do not — real mainnet spend with no idempotency key to
    make a blind resend safe (see `docs/API_NOTES.md`'s Ping section).
- **`mock-x402-server/server.mjs` doesn't verify anything on-chain** — it
  trusts any well-formed tx hash. Passing against it proves client logic,
  not real settlement; only the real mainnet call (not yet run) proves
  that.
- **Caddy's TLS setup (`deploy/setup.sh`) starts Caddy before the firewall
  section opens `80`/`443` in `ufw`.** Harmless on a genuinely fresh VM
  (`ufw` defaults to inactive until the script's own `ufw --force enable`
  runs later in the same pass), but re-running `setup.sh` against an
  already-hardened box only recovers because Caddy retries certificate
  issuance in the background — the script doesn't sequence this
  deliberately. Let's Encrypt also rate-limits certificate issuance per
  domain; a nip.io hostname is derived per-IP so this is unlikely to bite
  in practice, but repeatedly tearing down and recreating the same EC2
  instance (same IP → same nip.io hostname) in a short window could hit
  it. See `docs/DEPLOYMENT.md`'s TLS section for the recovery steps.
