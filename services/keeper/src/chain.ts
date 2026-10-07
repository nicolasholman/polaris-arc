/**
 * Clients for the keeper's chain, and the one way it sends: an estimated gas
 * limit plus headroom, priced at or above Arc's 20 gwei floor. Gas is USDC.
 */

import { type Account, type Address, type Chain, createPublicClient, createWalletClient, defineChain, type Hex, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

import type { KeeperConfig } from "./config.ts";

export const ARC_MIN_FEE = 20_000_000_000n;
const HEADROOM_BPS = 2_000n;

export function chainFor(config: Pick<KeeperConfig, "chainId" | "rpcUrl" | "explorerUrl">): Chain {
  const base = config.chainId === arc.id ? arc : config.chainId === arcTestnet.id ? arcTestnet : null;
  return defineChain({
    ...(base ?? { id: config.chainId, name: `Chain ${config.chainId}`, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 } }),
    id: config.chainId,
    rpcUrls: { default: { http: [config.rpcUrl] } },
    ...(config.explorerUrl ? { blockExplorers: { default: { name: "Explorer", url: config.explorerUrl } } } : {}),
  } as Chain);
}

export type Clients = { chain: Chain; public: PublicClient; wallet: WalletClient | null; account: Account | null };

export function clientsFor(config: KeeperConfig): Clients {
  const chain = chainFor(config);
  const pub = createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: 2, timeout: 20_000 }), pollingInterval: 250 }) as PublicClient;
  if (!config.privateKey) return { chain, public: pub, wallet: null, account: null };
  const account = privateKeyToAccount(config.privateKey);
  const wallet = createWalletClient({ chain, account, transport: http(config.rpcUrl, { retryCount: 1, timeout: 20_000 }) });
  return { chain, public: pub, wallet, account };
}

/** EIP-1559 fees at or above Arc's floor (a local chain keeps its own pricing). */
export async function fees(client: PublicClient, chainId: number): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | Record<string, never>> {
  if (chainId !== arc.id && chainId !== arcTestnet.id) return {};
  const f = await client.estimateFeesPerGas().catch(() => null);
  const max = f?.maxFeePerGas && f.maxFeePerGas > ARC_MIN_FEE ? f.maxFeePerGas : ARC_MIN_FEE * 2n;
  return { maxFeePerGas: max, maxPriorityFeePerGas: f?.maxPriorityFeePerGas ?? 0n };
}

const SUBMIT_ABI = [{ type: "function", name: "submitReport", stateMutability: "nonpayable", inputs: [{ name: "report", type: "bytes" }], outputs: [] }] as const;

/** Send `submitReport(report)` to a receiver as the keeper and wait for the receipt (final in under a second on Arc). */
export async function submitReport(c: Clients, chainId: number, receiver: Address, report: Hex) {
  if (!c.wallet || !c.account) throw new Error("read-only keeper: no POLARIS_KEEPER_PRIVATE_KEY");
  const estimate = await c.public.estimateContractGas({ address: receiver, abi: SUBMIT_ABI, functionName: "submitReport", args: [report], account: c.account });
  const gas = (estimate * (10_000n + HEADROOM_BPS)) / 10_000n;
  const hash = await c.wallet.writeContract({
    address: receiver,
    abi: SUBMIT_ABI,
    functionName: "submitReport",
    args: [report],
    account: c.account,
    chain: c.chain,
    gas,
    ...(await fees(c.public, chainId)),
  });
  const receipt = await c.public.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { hash, receipt, gasLimit: gas };
}
