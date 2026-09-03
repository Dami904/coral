import "dotenv/config";
import { z } from "zod";
import { base, baseSepolia, type Chain } from "viem/chains";

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte address");
const hexPrivateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x-prefixed 32-byte private key");

// Real Base mainnet USDC — https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
const MAINNET_USDC_DEFAULT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const envSchema = z.object({
  /** Selects which set of below vars is actually required. Defaults to the
   * free/testnet path so nothing here changes for existing sepolia usage. */
  NETWORK: z.enum(["sepolia", "mainnet"]).default("sepolia"),

  BASE_SEPOLIA_RPC_URL: z.url().optional(),
  SPEND_GUARD_ADDRESS: hexAddress.optional(),
  VENDOR_PAYTO_ADDRESS: hexAddress.optional(),

  BASE_MAINNET_RPC_URL: z.url().optional(),
  MAINNET_SPEND_GUARD_ADDRESS: hexAddress.optional(),
  /** Must be the real payTo from a live /api/evaluate 402 response — see
   * docs/API_NOTES.md — never a placeholder, this is where real funds go. */
  MAINNET_VENDOR_PAYTO_ADDRESS: hexAddress.optional(),
  MAINNET_USDC_ADDRESS: hexAddress.default(MAINNET_USDC_DEFAULT),

  AGENT_PRIVATE_KEY: hexPrivateKey,
  SIBYL_MEMORY_MCP_COMMAND: z.string().default("sibyl-memory-mcp"),
  SIBYL_MEMORY_DB: z.string().optional(),
  /** Owner key — only needed by owner-only scripts (ownerApprove/ownerReject/withdraw demos, deploys). */
  DEPLOYER_PRIVATE_KEY: hexPrivateKey.optional(),

  /** Direction B (gateway): USDC (6dp) another agent must pay the deployed
   * SpendGuard contract to redeem one check over Ping. Default is above
   * Sibyl's real $0.25 price so a cache miss is break-even-or-better and a
   * cache hit is pure margin — see PLAN.md's "Gateway direction" entry. */
  GATEWAY_FEE_USDC_6DP: z.coerce.bigint().default(500_000n),

  /** Virtuals Protocol ACP (Agent Commerce Protocol) — a third "another
   * agent pays Coral" surface alongside Ping's gateway mode, discovered
   * through Virtuals' own marketplace instead of Ping's. Only required by
   * scripts/live-acp-provider.ts, checked there (not here) the same way
   * DEPLOYER_PRIVATE_KEY is optional at this level and checked by its own
   * callers — see docs/API_NOTES.md's ACP section. */
  ACP_WALLET_ADDRESS: hexAddress.optional(),
  ACP_WALLET_ID: z.string().optional(),
  /** A Privy "authorization key" (base64 PKCS#8 P-256, ~155 chars, starts
   * "MIGH") from the agent's Signers tab on the Virtuals dashboard — NOT a
   * 0x-prefixed EOA hex key like every other private key in this file. */
  ACP_SIGNER_PRIVATE_KEY: z.string().optional(),
  /** Must match the offering name registered on the Virtuals dashboard —
   * read back from the registry at boot (see seller.ts's own pattern in
   * @virtuals-protocol/acp-node-v2), not hardcoded, but still needed here
   * to know which offering this process actually serves. */
  ACP_OFFERING_NAME: z.string().optional(),
});

function required(value: string | undefined, name: string, network: string): string {
  if (!value) {
    throw new Error(`missing required environment variable for NETWORK=${network}: ${name}`);
  }
  return value;
}

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`invalid/missing environment variables: ${parsed.error.message}`);
  }
  const env = parsed.data;
  const network = env.NETWORK;
  const isMainnet = network === "mainnet";

  const rpcUrl = required(
    isMainnet ? env.BASE_MAINNET_RPC_URL : env.BASE_SEPOLIA_RPC_URL,
    isMainnet ? "BASE_MAINNET_RPC_URL" : "BASE_SEPOLIA_RPC_URL",
    network,
  );
  const guardAddress = required(
    isMainnet ? env.MAINNET_SPEND_GUARD_ADDRESS : env.SPEND_GUARD_ADDRESS,
    isMainnet ? "MAINNET_SPEND_GUARD_ADDRESS" : "SPEND_GUARD_ADDRESS",
    network,
  );
  const vendorPayTo = required(
    isMainnet ? env.MAINNET_VENDOR_PAYTO_ADDRESS : env.VENDOR_PAYTO_ADDRESS,
    isMainnet ? "MAINNET_VENDOR_PAYTO_ADDRESS" : "VENDOR_PAYTO_ADDRESS",
    network,
  );

  return {
    network,
    chain: (isMainnet ? base : baseSepolia) as Chain,
    rpcUrl,
    guardAddress: guardAddress as `0x${string}`,
    agentPrivateKey: env.AGENT_PRIVATE_KEY as `0x${string}`,
    vendorPayTo: vendorPayTo as `0x${string}`,
    usdcAddress: (isMainnet ? env.MAINNET_USDC_ADDRESS : undefined) as `0x${string}` | undefined,
    memoryMcpCommand: env.SIBYL_MEMORY_MCP_COMMAND,
    memoryDbPath: env.SIBYL_MEMORY_DB,
    deployerPrivateKey: env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined,
    gatewayFeeUsdc6dp: env.GATEWAY_FEE_USDC_6DP,
    acpWalletAddress: env.ACP_WALLET_ADDRESS as `0x${string}` | undefined,
    acpWalletId: env.ACP_WALLET_ID,
    acpSignerPrivateKey: env.ACP_SIGNER_PRIVATE_KEY,
    acpOfferingName: env.ACP_OFFERING_NAME,
  };
}
