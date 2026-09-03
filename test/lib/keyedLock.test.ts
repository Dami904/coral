import { describe, expect, it } from "vitest";
import { createKeyedLock } from "../../src/lib/keyedLock.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createKeyedLock", () => {
  it("serializes two calls sharing the same key — the second never starts until the first settles", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const first = deferred<void>();

    const callA = lock("job-1", async () => {
      order.push("A start");
      await first.promise;
      order.push("A end");
    });
    const callB = lock("job-1", async () => {
      order.push("B start");
    });

    // Give the microtask queue a chance to run anything that WOULD start B early.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A start"]);

    first.resolve();
    await callA;
    await callB;
    expect(order).toEqual(["A start", "A end", "B start"]);
  });

  it("does not serialize calls with different keys — B finishes while A is still pending", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const first = deferred<void>();

    const callA = lock("job-1", async () => {
      order.push("A start");
      await first.promise;
      order.push("A end");
    });
    const callB = lock("job-2", async () => {
      order.push("B start");
    });

    // B (a different key) completes without waiting on A's still-pending lock.
    await callB;
    expect(order).toEqual(["A start", "B start"]);

    first.resolve();
    await callA;
    expect(order).toEqual(["A start", "B start", "A end"]);
  });

  it("an error in one call does not break subsequent calls for the same key", async () => {
    const lock = createKeyedLock();
    await expect(
      lock("job-1", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    const result = await lock("job-1", () => Promise.resolve("still works"));
    expect(result).toBe("still works");
  });

  it("returns each call's own resolved value, not a shared one", async () => {
    const lock = createKeyedLock();
    const [a, b] = await Promise.all([lock("k", () => Promise.resolve(1)), lock("k", () => Promise.resolve(2))]);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});
