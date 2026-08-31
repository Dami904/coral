import { describe, expect, it } from "vitest";
import { withRetry } from "../../src/lib/retry.js";

function fakeSleep(delays: number[]): (ms: number) => Promise<void> {
  return async (ms) => {
    delays.push(ms);
  };
}

describe("withRetry", () => {
  it("returns the result on the first successful attempt, no sleep", async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 100, isRetryable: () => true, sleep: fakeSleep(delays) },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries on a retryable failure and succeeds within maxAttempts", async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { maxAttempts: 5, baseDelayMs: 100, isRetryable: () => true, sleep: fakeSleep(delays) },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2); // slept once before attempt 2, once before attempt 3
  });

  it("exhausts maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    const boom = new Error("still broken");

    await expect(
      withRetry(
        async () => {
          calls++;
          throw boom;
        },
        { maxAttempts: 3, baseDelayMs: 10, isRetryable: () => true, sleep: fakeSleep([]) },
      ),
    ).rejects.toBe(boom);

    expect(calls).toBe(3);
  });

  it("rethrows immediately without retrying when isRetryable returns false", async () => {
    let calls = 0;
    const fatal = new Error("not retryable");

    await expect(
      withRetry(
        async () => {
          calls++;
          throw fatal;
        },
        { maxAttempts: 5, baseDelayMs: 10, isRetryable: () => false, sleep: fakeSleep([]) },
      ),
    ).rejects.toBe(fatal);

    expect(calls).toBe(1);
  });

  it("only calls isRetryable with the actual thrown error", async () => {
    const seen: unknown[] = [];
    const boom = new Error("specific failure");

    await expect(
      withRetry(
        async () => {
          throw boom;
        },
        {
          maxAttempts: 2,
          baseDelayMs: 10,
          isRetryable: (err) => {
            seen.push(err);
            return true;
          },
          sleep: fakeSleep([]),
        },
      ),
    ).rejects.toBe(boom);

    expect(seen).toEqual([boom]);
  });

  it("backs off with growing bounds: each delay is within [0, baseDelayMs * 2^(attempt-1))", async () => {
    const delays: number[] = [];
    let calls = 0;

    await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new Error("transient");
        return "ok";
      },
      { maxAttempts: 5, baseDelayMs: 100, isRetryable: () => true, sleep: fakeSleep(delays) },
    );

    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThan(100); // baseDelayMs * 2^0
    expect(delays[1]).toBeLessThan(200); // baseDelayMs * 2^1
    expect(delays[2]).toBeLessThan(400); // baseDelayMs * 2^2
  });
});
