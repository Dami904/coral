import { describe, expect, it } from "vitest";
import { runPollLoop, type ResumePendingOutcome } from "../src/ping/pollLoop.js";
import type { PingMessage, PingPort } from "../src/types.js";

const CONTRACT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function msg(block: bigint): PingMessage {
  return {
    from: "0x000000000000000000000000000000000000a1",
    to: "0x0000000000000000000000000000000000dead",
    content: "no address here",
    block,
    transactionHash: `0x${block.toString(16)}`,
    isBroadcast: false,
    replied: false,
    replyBlock: null,
  };
}

function pendingMsg(block: bigint): PingMessage {
  return { ...msg(block), content: `check ${CONTRACT} please` };
}

/** Fake ping backend: each call to getInboxWithStatus returns the next
 * queued batch (simulating new messages arriving between poll cycles) and
 * records what fromBlock it was actually called with. */
function makeQueuedPing(
  batches: PingMessage[][],
): PingPort & { fromBlockCalls: bigint[]; replies: { to: string; content: string }[] } {
  const fromBlockCalls: bigint[] = [];
  const replies: { to: string; content: string }[] = [];
  let i = 0;
  return {
    fromBlockCalls,
    replies,
    async getInboxWithStatus(fromBlock) {
      fromBlockCalls.push(fromBlock);
      const batch = batches[i] ?? [];
      i++;
      return batch;
    },
    async sendReply(to, content) {
      replies.push({ to, content });
      return { txHash: "0xreply" };
    },
  };
}

describe("runPollLoop", () => {
  it("advances the cursor across cycles and passes it to the next getInboxWithStatus call", async () => {
    const ping = makeQueuedPing([[msg(10n)], [msg(25n)], []]);
    const controller = new AbortController();
    let cycles = 0;

    await runPollLoop(
      {
        ping,
        pollIntervalMs: 0,
        startBlock: 1n,
        handle: async () => ({ outcome: "blocked", reason: "n/a" }),
        onCycle: () => {
          cycles++;
          if (cycles === 3) controller.abort();
        },
      },
      controller.signal,
    );

    expect(ping.fromBlockCalls).toEqual([1n, 10n, 25n]);
    expect(cycles).toBe(3);
  });

  it("stops promptly when the signal is already aborted before the first cycle", async () => {
    const ping = makeQueuedPing([[msg(10n)]]);
    const controller = new AbortController();
    controller.abort();
    let cycles = 0;

    await runPollLoop(
      {
        ping,
        pollIntervalMs: 50,
        startBlock: 1n,
        handle: async () => ({ outcome: "blocked", reason: "n/a" }),
        onCycle: () => {
          cycles++;
        },
      },
      controller.signal,
    );

    expect(cycles).toBe(0);
  });

  it("auto-resumes an approved escalated payment once detected, then stops tracking it", async () => {
    const ping = makeQueuedPing([[pendingMsg(10n)], [], []]);
    const controller = new AbortController();
    let resumeCalls = 0;

    await runPollLoop(
      {
        ping,
        pollIntervalMs: 0,
        startBlock: 1n,
        handle: async () => ({ outcome: "pending_approval", requestId: 7n, fromBlock: 10n }),
        resumePending: async (contract, requestId, fromBlock): Promise<ResumePendingOutcome> => {
          resumeCalls++;
          expect(contract).toBe(CONTRACT);
          expect(requestId).toBe(7n);
          expect(fromBlock).toBe(10n);
          if (resumeCalls < 2) return { outcome: "still_pending" };
          return { outcome: "paid", tier: "high_conviction", txHash: "0xresolved" };
        },
        onCycle: () => {
          if (resumeCalls >= 2) controller.abort();
        },
      },
      controller.signal,
    );

    expect(resumeCalls).toBe(2);
    // pending_approval reply from the first cycle, plus the resumed reply once approved.
    expect(ping.replies).toHaveLength(2);
    expect(ping.replies[0]?.content).toContain("sign-off");
    expect(ping.replies[1]?.content).toContain("high_conviction");
  });

  it("replies distinctly and stops tracking when a pending request is rejected", async () => {
    const ping = makeQueuedPing([[pendingMsg(10n)], []]);
    const controller = new AbortController();
    let resumeCalls = 0;

    await runPollLoop(
      {
        ping,
        pollIntervalMs: 0,
        startBlock: 1n,
        handle: async () => ({ outcome: "pending_approval", requestId: 9n, fromBlock: 10n }),
        resumePending: async (): Promise<ResumePendingOutcome> => {
          resumeCalls++;
          return { outcome: "rejected" };
        },
        onCycle: () => controller.abort(),
      },
      controller.signal,
    );

    expect(resumeCalls).toBe(1);
    expect(ping.replies).toHaveLength(2);
    expect(ping.replies[1]?.content.toLowerCase()).toContain("rejected");
  });

  it("sends no extra reply while a resume check keeps reporting still_pending", async () => {
    const ping = makeQueuedPing([[pendingMsg(10n)], [], [], []]);
    const controller = new AbortController();
    let resumeCalls = 0;
    let cycles = 0;

    await runPollLoop(
      {
        ping,
        pollIntervalMs: 0,
        startBlock: 1n,
        handle: async () => ({ outcome: "pending_approval", requestId: 5n, fromBlock: 10n }),
        resumePending: async (): Promise<ResumePendingOutcome> => {
          resumeCalls++;
          return { outcome: "still_pending" };
        },
        onCycle: () => {
          cycles++;
          if (cycles === 4) controller.abort();
        },
      },
      controller.signal,
    );

    expect(resumeCalls).toBe(4);
    // Only the original pending_approval reply — never spammed on
    // subsequent still-pending cycles.
    expect(ping.replies).toHaveLength(1);
    expect(ping.replies[0]?.content).toContain("sign-off");
  });

  it("skips pending-request tracking entirely when resumePending is not configured", async () => {
    const ping = makeQueuedPing([[pendingMsg(10n)], []]);
    const controller = new AbortController();

    await runPollLoop(
      {
        ping,
        pollIntervalMs: 0,
        startBlock: 1n,
        handle: async () => ({ outcome: "pending_approval", requestId: 5n, fromBlock: 10n }),
        onCycle: () => controller.abort(),
      },
      controller.signal,
    );

    expect(ping.replies).toHaveLength(1);
    expect(ping.replies[0]?.content).toContain("sign-off");
  });
});
