// ping-onchain 0.1.5 ships no types. This declares only the surface this
// project actually uses, verified by reading the real package source
// (node_modules/.../ping-onchain/index.js) — see docs/API_NOTES.md.
declare module "ping-onchain" {
  export type PingRawMessage = {
    from: `0x${string}`;
    to: `0x${string}` | "broadcast";
    content: string;
    block: bigint;
    transactionHash: `0x${string}`;
    isBroadcast: boolean;
    broadcastId?: bigint;
    replied?: boolean | null;
    replyBlock?: number | null;
  };

  export type PingTxResult = { hash: `0x${string}`; receipt: unknown };

  export class Ping {
    static fromPrivateKey(privateKey: `0x${string}`, opts?: { rpcUrl?: string }): Ping;
    static readOnly(opts?: { rpcUrl?: string }): Ping;

    register(username: string): Promise<PingTxResult>;
    sendMessage(to: string, content: string): Promise<PingTxResult>;
    getInboxWithStatus(opts?: {
      address?: `0x${string}`;
      fromBlock?: bigint;
      toBlock?: bigint;
    }): Promise<PingRawMessage[]>;
    isRegistered(address: `0x${string}`): Promise<boolean>;
    getMessageFee(): Promise<bigint>;
  }
}
