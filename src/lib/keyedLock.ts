/**
 * Serializes async calls sharing the same key within this process — calls
 * for different keys still run concurrently. Originally written for
 * httpGatewayServer.ts's per-contract lock (two concurrent /check
 * requests for the same never-cached contract could both pass
 * decisionCore's cache-miss check and both call chain.requestPayment
 * before either result is recorded — a genuine double real USDC payment
 * for a contract priced below humanApprovalThreshold, not just a
 * duplicate escalation proposal) and reused by live-acp-provider.ts for
 * the same class of bug: a duplicate/replayed `job.funded` SSE event, or
 * a resume-poll tick that outruns its own interval, can otherwise run
 * `handleTokenQuery`/`resumeAfterApproval` + `session.submit()` twice for
 * one logical job. See docs/LIMITATIONS.md — this only serializes within
 * one process; a second instance of the same script can still race it.
 */
export function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return (key, fn) => {
    const prior = tails.get(key) ?? Promise.resolve();
    const result = prior.then(fn, fn);
    tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };
}
