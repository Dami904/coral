/**
 * THE GATE, mechanically enforced.
 *
 * CLAUDE.md's non-negotiable invariant: memory is always consulted before any
 * chain call. `test/decisionCore.test.ts` proves this behaviorally (a mock
 * memory/chain pair, asserting call order at runtime) — this file proves it
 * structurally, by reading decisionCore.ts's own source, so a future edit
 * that reorders the two calls fails the build even if nobody thinks to run
 * the behavioral test against the new code path. Mirrors the same technique
 * Cairn's own deletion-gate suite uses on executor.py: read the real source
 * file, strip comments so the check can't be fooled by a stray mention in
 * prose, then assert on the code that's actually there.
 *
 * Cairn's version asserts certain names never appear at all, because its
 * replay path is a wholly separate function that should never import
 * payment/commons machinery. Coral's shape is different: handleJobQuery
 * legitimately calls both memory and payment in one function, just in a
 * required order — so the right check here is source order, not absence.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function extractFunctionBody(source: string, exportedFnName: string): string {
  const startMarker = `export async function ${exportedFnName}`;
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`could not find "${startMarker}" in decisionCore.ts — has it been renamed?`);
  }
  const rest = source.slice(start + startMarker.length);
  // The next top-level export (a sibling function/type) marks the end of
  // this function's body, however many closing braces it takes to get there.
  const nextExport = rest.search(/\nexport (async function|type) /);
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

describe("decisionCore invariant: memory is checked before any payment (structural, not just behavioral)", () => {
  const source = stripComments(
    readFileSync(join(__dirname, "..", "src", "decisionCore.ts"), "utf8"),
  );

  it("handleJobQuery's own source calls memory.recallJob strictly before chain.requestPayment", () => {
    const body = extractFunctionBody(source, "handleJobQuery");

    const recallIndex = body.indexOf(".recallJob(");
    const paymentIndex = body.indexOf(".requestPayment(");

    expect(recallIndex, "handleJobQuery no longer calls memory.recallJob at all").toBeGreaterThan(-1);
    expect(paymentIndex, "handleJobQuery no longer calls chain.requestPayment at all").toBeGreaterThan(-1);
    expect(
      recallIndex,
      "chain.requestPayment now appears before memory.recallJob in handleJobQuery's source — " +
        "this breaks the non-negotiable invariant in CLAUDE.md: a payment path must never be " +
        "reachable without checking memory first",
    ).toBeLessThan(paymentIndex);
  });

  it("resumeAfterApproval never calls chain.requestPayment again (it only resolves an existing escalation)", () => {
    const body = extractFunctionBody(source, "resumeAfterApproval");
    expect(
      body.includes(".requestPayment("),
      "resumeAfterApproval must never re-request a payment — it only checks whether an " +
        "already-proposed escalation was approved/rejected on-chain",
    ).toBe(false);
  });
});
