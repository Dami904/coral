/**
 * One-time, real-gas mainnet transaction: registers the agent wallet on
 * Ping — a hard prerequisite before it can send/reply to anything (see
 * docs/API_NOTES.md's "Registration is a hard prerequisite" note).
 * Idempotent in effect (checks isRegistered first and no-ops if already
 * registered), but the underlying register() call itself is real,
 * irreversible, public mainnet spend, permanently visible on Basescan
 * tied to the agent's address — never run this without deliberately
 * deciding to (see CLAUDE.md: "don't deploy to mainnet from an agent
 * session" — the same principle applies here).
 *
 * Run: AGENT_PRIVATE_KEY=0x... PING_USERNAME=... pnpm live:ping-register
 */
import { PingChainClient } from "../src/ping/pingChainClient.js";

async function main() {
  const privateKey = process.env["AGENT_PRIVATE_KEY"];
  if (!privateKey) throw new Error("AGENT_PRIVATE_KEY required");
  const username = process.env["PING_USERNAME"];
  if (!username) throw new Error("PING_USERNAME required — the name to register the agent wallet under on Ping");

  const ping = new PingChainClient({ privateKey: privateKey as `0x${string}` });

  const already = await ping.isRegistered();
  if (already) {
    console.log(`[ping-register] ${ping.address} is already registered — nothing to do.`);
    return;
  }

  console.log(`[ping-register] registering ${ping.address} as "${username}" (real mainnet gas)...`);
  const result = await ping.register(username);
  console.log(`[ping-register] PASS: registered, tx ${result.txHash}`);
}

main().catch((err: unknown) => {
  console.error("[ping-register] FAILED:", err);
  process.exitCode = 1;
});
