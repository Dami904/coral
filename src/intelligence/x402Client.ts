import type { IntelligencePort } from "../types.js";
import { IntelligenceResultUnrecoverableError } from "../types.js";
import { withRetry } from "../lib/retry.js";

export type X402ClientConfig = {
  /** e.g. https://sibylcap.com/api/evaluate or the local mock server URL. */
  endpointUrl: string;
  /** Retry tuning for the UNKNOWN (network-failure) case below — rarely
   * needs overriding outside tests. */
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Label for error context only (IntelligenceResultUnrecoverableError) —
   * this class is always "the Sibyl integration" regardless of who
   * instantiates it, so a sane default covers every real call site. */
  hiredAgentId?: string;
};

/**
 * Real x402 directTx client for Sibyl's /api/evaluate — the one real
 * IntelligencePort implementation this codebase has. The payment
 * (SpendGuard.requestPayment) has already happened by the time invoke
 * runs — this only ever relays the resulting tx hash via X-PAYMENT-TX and
 * reads back the tier (returned as the port's generic `output` field),
 * per docs/API_NOTES.md's verified request shape (`?token=<contract>`
 * query param, discovered via the endpoint's own
 * `extensions.bazaar.info.inputSchema`, not assumed).
 */
export class X402IntelligenceClient implements IntelligencePort {
  constructor(private readonly config: X402ClientConfig) {}

  async invoke(
    input: string,
    paymentTxHash: `0x${string}`,
  ): Promise<{ output: string; raw: unknown; sourceEndpoint: string }> {
    const url = new URL(this.config.endpointUrl);
    url.searchParams.set("token", input);

    let attempt = 0;
    // A request timeout or connection drop while relaying X-PAYMENT-TX is
    // the one UNKNOWN case in this codebase that's safe to blind-retry with
    // the SAME hash: the endpoint's 120s directTx window is single-use, so
    // a duplicate attempt either succeeds (the first response was merely
    // lost) or 409s harmlessly (the first actually landed) — see
    // docs/API_NOTES.md. `fetch` only throws on a genuine transport
    // failure; an HTTP error status (400/409/etc.) resolves normally and is
    // handled once, below, never retried here.
    const response = await withRetry(
      () => {
        attempt++;
        return fetch(url, { headers: { "X-PAYMENT-TX": paymentTxHash } });
      },
      {
        maxAttempts: this.config.maxAttempts ?? 3,
        baseDelayMs: this.config.baseDelayMs ?? 200,
        isRetryable: () => true,
      },
    );

    if (response.status === 400) {
      throw new Error(`x402 evaluate rejected the tx hash as malformed: ${await response.text()}`);
    }
    if (response.status === 409) {
      if (attempt > 1) {
        // A retry (not the first attempt) hit "already used" — the
        // original relay almost certainly succeeded server-side and its
        // response was what got lost, not the request. There is no verdict
        // payload left to recover from this call.
        throw new IntelligenceResultUnrecoverableError(this.config.hiredAgentId ?? "sibyl-conviction-check", input, paymentTxHash);
      }
      throw new Error(`x402 evaluate: tx hash already used (single-use, per docs/API_NOTES.md): ${await response.text()}`);
    }
    if (!response.ok) {
      throw new Error(`x402 evaluate returned unexpected status ${String(response.status)}: ${await response.text()}`);
    }

    const raw: unknown = await response.json();
    return { output: X402IntelligenceClient.deriveTier(raw), raw, sourceEndpoint: url.toString() };
  }

  /**
   * The endpoint scores "builder conviction, community seed, and on-chain
   * proof of work" (0-30 conviction_score + tier) — a project-conviction
   * rating, not a safe/unsafe token-safety verdict. `tier` is the closest
   * categorical field it actually returns; don't invent a binary this
   * data doesn't have. See docs/API_NOTES.md.
   */
  private static deriveTier(raw: unknown): string {
    if (typeof raw === "object" && raw !== null && "tier" in raw && typeof raw.tier === "string") {
      return raw.tier;
    }
    return "unknown";
  }
}
