import type { IntelligencePort } from "../types.js";

/**
 * Placeholder for Sibyl's real x402 /api/evaluate endpoint. Day 5 work
 * (see PLAN.md's day-by-day) replaces this with the real directTx ->
 * X-PAYMENT-TX HTTP client. Exists so the decision core's control flow
 * (memory -> guard -> intelligence -> cache) can be built and exercised
 * end-to-end now, without pretending the x402 integration is done.
 */
export class StubIntelligenceClient implements IntelligencePort {
  invoke(
    input: string,
    paymentTxHash: `0x${string}`,
  ): Promise<{ output: string; raw: unknown; sourceEndpoint: string }> {
    return Promise.resolve({
      output: "unknown-stub",
      raw: { note: "StubIntelligenceClient: real /api/evaluate call not wired until Day 5", input, paymentTxHash },
      sourceEndpoint: "stub://not-yet-wired",
    });
  }
}
