import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MemoryPort, TokenVerdictRecord } from "../types.js";
import { withRetry } from "../lib/retry.js";

const CATEGORY = "token_verdict";
const PAYMENT_CATEGORY = "incoming_payment";
const TRANSPORT_RETRY = { maxAttempts: 3, baseDelayMs: 200 };

export type SibylMemoryClientConfig = {
  /** Defaults to "sibyl-memory-mcp" — must be on PATH (pip install sibyl-memory-mcp). */
  command?: string;
  args?: string[];
  /** Typically used to pin SIBYL_MEMORY_DB to a project-local path — see docs/API_NOTES.md. */
  env?: Record<string, string>;
};

type ToolTextResult = { ok: boolean; isError: boolean; parsed: unknown };

/** A well-formed tool rejection (isError:true, a real ToolError) — FAILED
 * per docs/API_NOTES.md's three-state model, never worth retrying or
 * reconciling. Distinct from a transport-level throw (subprocess crash,
 * broken pipe, RPC timeout — UNKNOWN), which never reaches this class. */
export class MemoryToolRejectedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly parsed: unknown,
  ) {
    super(`memory tool "${tool}" rejected the call: ${JSON.stringify(parsed)}`);
    this.name = "MemoryToolRejectedError";
  }
}

/**
 * Adapter over the real `sibyl-memory-mcp` stdio server. Tool shapes below
 * are taken from docs/API_NOTES.md, which was written from reading
 * sibyl_memory_mcp/server.py directly and round-tripping the underlying
 * SDK — not assumed from the marketing page.
 */
export class SibylMemoryClient implements MemoryPort {
  private readonly config: SibylMemoryClientConfig;
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(config: SibylMemoryClientConfig = {}) {
    this.config = config;
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const transport = new StdioClientTransport({
          command: this.config.command ?? "sibyl-memory-mcp",
          args: this.config.args ?? [],
          ...(this.config.env ? { env: this.config.env } : {}),
        });
        const client = new Client({ name: "coral-decision-core", version: "0.1.0" });
        await client.connect(transport);
        this.client = client;
        return client;
      })();
    }
    return this.connecting;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.connecting = null;
  }

  /** The raw MCP RPC call only. Anything thrown directly from here
   * (connection refused, subprocess crash, request timeout) is a
   * transport-level UNKNOWN failure — distinct from a well-formed
   * MemoryToolRejectedError (never thrown from here) or a malformed-but-
   * received response (thrown by callTool's own parsing below, also never
   * retried — that's a real protocol mismatch, not a transient hiccup). */
  private async rawCallTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.getClient();
    return client.callTool({ name, arguments: args });
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { retryTransportFailures?: boolean } = {},
  ): Promise<ToolTextResult> {
    const result: unknown = opts.retryTransportFailures
      ? await withRetry(() => this.rawCallTool(name, args), { ...TRANSPORT_RETRY, isRetryable: () => true })
      : await this.rawCallTool(name, args);

    if (typeof result !== "object" || result === null) {
      throw new Error(`memory tool "${name}" returned a non-object result`);
    }
    const isError = "isError" in result && result.isError === true;
    const contentField = "content" in result ? result.content : undefined;
    const content = Array.isArray(contentField) ? contentField : [];
    const first: unknown = content[0];
    const text =
      typeof first === "object" &&
      first !== null &&
      "type" in first &&
      first.type === "text" &&
      "text" in first &&
      typeof first.text === "string"
        ? first.text
        : undefined;
    if (text === undefined) {
      throw new Error(`memory tool "${name}" returned no text content block: ${JSON.stringify(result)}`);
    }
    // On an error result, the underlying Python MCP SDK wraps the tool's
    // raw JSON payload as `Error executing tool <name>: <json>` before it
    // ever reaches server.py's own ToolError text (verified live 2026-08-26,
    // not visible from reading server.py alone — see docs/API_NOTES.md).
    // Extract the trailing JSON object rather than assuming the whole
    // string parses.
    const jsonStart = text.indexOf("{");
    const candidate = jsonStart >= 0 ? text.slice(jsonStart) : text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw new Error(`memory tool "${name}" returned non-JSON text content: ${text}`);
    }
    return { ok: !isError, isError, parsed };
  }

  private static isNotFound(parsed: unknown): boolean {
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "code" in parsed &&
      (parsed as { code?: unknown }).code === "NOT_FOUND"
    );
  }

  async recallTokenVerdict(contract: string): Promise<TokenVerdictRecord | null> {
    // Reads are safe to blind-retry on a transport-level (UNKNOWN) failure —
    // SQLite reads are local and atomic, there's no double-read hazard.
    const result = await this.callTool(
      "memory_recall",
      { category: CATEGORY, name: contract },
      { retryTransportFailures: true },
    );
    if (result.isError) {
      if (SibylMemoryClient.isNotFound(result.parsed)) return null;
      throw new MemoryToolRejectedError("memory_recall", result.parsed);
    }
    const payload = result.parsed as { entity?: { body?: unknown } };
    const body = payload.entity?.body;
    if (!body || typeof body !== "object") {
      throw new Error(`memory_recall returned an entity with no usable body: ${JSON.stringify(result.parsed)}`);
    }
    return body as TokenVerdictRecord;
  }

  private async writeRemember(contract: string, record: TokenVerdictRecord): Promise<void> {
    const result = await this.callTool("memory_remember", { category: CATEGORY, name: contract, body: record });
    if (result.isError) {
      throw new MemoryToolRejectedError("memory_remember", result.parsed);
    }
  }

  async rememberTokenVerdict(contract: string, record: TokenVerdictRecord): Promise<void> {
    try {
      await this.writeRemember(contract, record);
    } catch (err) {
      // A well-formed rejection (validation, cap exceeded) is FAILED, not
      // UNKNOWN — surface it as-is, there's nothing to reconcile.
      if (err instanceof MemoryToolRejectedError) throw err;
      // Anything else is a transport-level (UNKNOWN) failure: the write may
      // have already landed before the connection dropped. memory_remember
      // is idempotent on (category, name), but per docs/API_NOTES.md the
      // default here is to re-check via memory_recall rather than blindly
      // resending — only resend once we've confirmed the fresh record
      // genuinely isn't there yet. Logged either way: this is non-obvious
      // recovery behavior a future debugger would otherwise have no trace
      // of if it never surfaces as a thrown error.
      const reread = await this.recallTokenVerdict(contract).catch(() => null);
      if (reread && reread.checked_at === record.checked_at) {
        console.error("memory_remember: transport failure after a write that had already landed — not resending", {
          contract,
          err,
        });
        return;
      }
      console.error("memory_remember: transport failure, reconcile found no fresh write yet — resending once", {
        contract,
        err,
      });
      await this.writeRemember(contract, record);
    }
  }

  async recordEvent(
    kind: string,
    body: Record<string, unknown>,
    ref: { category: string; name: string },
  ): Promise<void> {
    // Deliberately no retry/reconcile here, unlike rememberTokenVerdict:
    // each call appends a new journal event with no idempotency key, so a
    // resend after an ambiguous UNKNOWN failure would risk a duplicate
    // audit-trail entry — worse than the single lost event this would be
    // guarding against. Callers on a failure-recovery path already use
    // decisionCore's recordEventBestEffort, which logs to stderr instead of
    // throwing further.
    const result = await this.callTool("memory_record_event", {
      kind,
      body,
      category: ref.category,
      name: ref.name,
    });
    if (result.isError) {
      throw new MemoryToolRejectedError("memory_record_event", result.parsed);
    }
  }

  async wasPaymentConsumed(txHash: `0x${string}`): Promise<boolean> {
    // Same reasoning as recallTokenVerdict: a local SQLite read is safe to
    // blind-retry on a transport failure.
    const result = await this.callTool(
      "memory_recall",
      { category: PAYMENT_CATEGORY, name: txHash },
      { retryTransportFailures: true },
    );
    if (result.isError) {
      if (SibylMemoryClient.isNotFound(result.parsed)) return false;
      throw new MemoryToolRejectedError("memory_recall", result.parsed);
    }
    return true;
  }

  private async writeMarkPaymentConsumed(txHash: `0x${string}`, body: Record<string, unknown>): Promise<void> {
    const result = await this.callTool("memory_remember", { category: PAYMENT_CATEGORY, name: txHash, body });
    if (result.isError) {
      throw new MemoryToolRejectedError("memory_remember", result.parsed);
    }
  }

  async markPaymentConsumed(txHash: `0x${string}`, body: Record<string, unknown>): Promise<void> {
    try {
      await this.writeMarkPaymentConsumed(txHash, body);
    } catch (err) {
      // A well-formed rejection is FAILED, not UNKNOWN — nothing to
      // reconcile, surface it as-is (same split as rememberTokenVerdict).
      if (err instanceof MemoryToolRejectedError) throw err;
      // Anything else is transport-level (UNKNOWN): the write may have
      // already landed before the connection dropped. memory_remember is
      // idempotent on (category, name) — txHash is unique per payment, so
      // any existing record under it can only be from this exact write,
      // making plain existence (unlike rememberTokenVerdict's content
      // match, needed there because a stale unrelated entry can already
      // exist for the same contract) enough to reconcile against. Blindly
      // resending without checking would be fine content-wise but would
      // mask this as a silent no-op; checking first keeps the log honest
      // about what actually happened.
      const reread = await this.wasPaymentConsumed(txHash).catch(() => false);
      if (reread) {
        console.error("markPaymentConsumed: transport failure after a write that had already landed — not resending", {
          txHash,
          err,
        });
        return;
      }
      console.error("markPaymentConsumed: transport failure, reconcile found no write yet — resending once", {
        txHash,
        err,
      });
      await this.writeMarkPaymentConsumed(txHash, body);
    }
  }
}
