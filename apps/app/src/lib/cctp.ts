import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  type EIP1193Provider,
  getAddress,
  type Hex,
  numberToHex,
  parseAbi,
} from "viem";
import { api } from "./api";
import { depositForBurnCall } from "./cctp-burn.ts";
import type { Micros } from "./money";
import type { CctpSource } from "./network";

/**
 * Add money from another chain, with Circle's CCTP V2: the buyer's own
 * browser wallet burns USDC on a chain Polaris lists (`/api/public/network`
 * `cctp.sources`), naming their Polaris account on Arc (CCTP domain 26) as
 * the recipient. Circle attests the burn; Polaris for Business's relayer then
 * calls `MessageTransmitterV2.receiveMessage` on Arc and pays that gas in
 * USDC (`POST /api/public/cctp/mint`). The buyer pays only the source chain's
 * gas, in their own wallet.
 *
 * Standard transfers (maxFee 0, minFinalityThreshold 2000) wait for the
 * source chain to finalise: minutes on testnet, so the app says so and keeps
 * the burn on this device to pick the wait back up.
 */

/** The USDC calls on the source chain. */
const usdcAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);


/** What the mint endpoint answers. */
export type MintStatus = {
  status: "pending" | "minted" | "failed";
  amountUnits?: string;
  recipient?: Address;
  mintTxHash?: Hex;
  error?: string;
};

/** A burn this device started, kept so the wait survives closing the sheet. */
export type PendingBurn = {
  sourceDomain: number;
  sourceChainId: number;
  sourceName: string;
  txHash: Hex;
  amount: string;
  recipient: Address;
  explorerUrl: string;
  at: number;
};

export class BridgeError extends Error {
  readonly reason: "no-wallet" | "rejected" | "wrong-chain" | "insufficient-funds" | "no-gas" | "failed";
  constructor(reason: BridgeError["reason"], message: string) {
    super(message);
    this.name = "BridgeError";
    this.reason = reason;
  }
}

/** The browser wallet (`window.ethereum`), or null when there is none. */
export function injectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

function requireProvider(): EIP1193Provider {
  const provider = injectedProvider();
  if (!provider) throw new BridgeError("no-wallet", "No browser wallet found. Open this page in a browser with a wallet extension.");
  return provider;
}

/** The source chain, as viem wants it. */
export function sourceChain(source: CctpSource): Chain {
  return defineChain({
    id: source.chainId,
    name: source.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [source.rpcUrl] } },
    blockExplorers: { default: { name: `${source.name} explorer`, url: source.explorerUrl } },
  });
}

function rejected(error: unknown): boolean {
  const e = error as { code?: number; cause?: { code?: number }; name?: string };
  return e?.code === 4001 || e?.cause?.code === 4001 || e?.name === "UserRejectedRequestError";
}

/** Asks the wallet for an account. */
export async function connectWallet(): Promise<{ address: Address; chainId: number }> {
  const provider = requireProvider();
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const chainId = Number(await provider.request({ method: "eth_chainId" }));
    if (!accounts[0]) throw new BridgeError("no-wallet", "The wallet didn't share an account.");
    return { address: getAddress(accounts[0]), chainId };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (rejected(error)) throw new BridgeError("rejected", "You didn't connect the wallet. Nothing happened.");
    throw new BridgeError("failed", "The wallet didn't answer. Try again.");
  }
}

/** The wallet's current chain. */
export async function walletChainId(): Promise<number> {
  return Number(await requireProvider().request({ method: "eth_chainId" }));
}

/** Switches the wallet to the source chain, adding it first when the wallet doesn't know it. */
export async function switchToSource(source: CctpSource): Promise<void> {
  const provider = requireProvider();
  const chainId = numberToHex(source.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    const code = (error as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code === 4902) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId, chainName: source.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [source.rpcUrl], blockExplorerUrls: [source.explorerUrl] }],
        });
        return;
      } catch (addError) {
        if (rejected(addError)) throw new BridgeError("rejected", `You didn't add ${source.name} to the wallet. Nothing happened.`);
        throw new BridgeError("wrong-chain", `Your wallet couldn't add ${source.name}. Add it in the wallet, then try again.`);
      }
    }
    if (rejected(error)) throw new BridgeError("rejected", `You stayed on another network. Switch to ${source.name} to continue.`);
    throw new BridgeError("wrong-chain", `Your wallet couldn't switch to ${source.name}. Switch in the wallet, then try again.`);
  }
}

/** What the wallet holds on the source chain: its USDC, and whether it has any gas there. */
export async function sourceBalances(source: CctpSource, owner: Address): Promise<{ usdc: Micros; gas: bigint }> {
  const client = createPublicClient({ chain: sourceChain(source), transport: custom(requireProvider()) });
  const [usdc, gas] = await Promise.all([
    client.readContract({ address: source.usdc, abi: usdcAbi, functionName: "balanceOf", args: [owner] }),
    client.getBalance({ address: owner }),
  ]);
  return { usdc, gas };
}

/**
 * Burns `amount` USDC on the source chain for `recipient` on Arc: approve
 * TokenMessengerV2 (only when the allowance is short), then depositForBurn
 * to domain 26 with the recipient as bytes32, no destination caller, as a
 * standard transfer. Returns the burn's transaction hash once it is mined.
 */
export async function burnForArc(input: {
  source: CctpSource;
  arcDomain: number;
  from: Address;
  recipient: Address;
  amount: Micros;
  onStep?: (step: "approve" | "approving" | "burn" | "burning") => void;
}): Promise<Hex> {
  const { source, from, recipient, amount, arcDomain, onStep } = input;
  const provider = requireProvider();
  if ((await walletChainId()) !== source.chainId) throw new BridgeError("wrong-chain", `Switch your wallet to ${source.name} first.`);
  const chain = sourceChain(source);
  const wallet = createWalletClient({ account: from, chain, transport: custom(provider) });
  const client = createPublicClient({ chain, transport: custom(provider) });

  const { usdc, gas } = await sourceBalances(source, from);
  if (usdc < amount) throw new BridgeError("insufficient-funds", `This wallet holds less USDC than that on ${source.name}.`);
  if (gas === 0n) throw new BridgeError("no-gas", `This wallet has no gas on ${source.name}. Get some from a faucet, then try again.`);

  try {
    const allowance = await client.readContract({ address: source.usdc, abi: usdcAbi, functionName: "allowance", args: [from, source.tokenMessengerV2] });
    if (allowance < amount) {
      onStep?.("approve");
      const approval = await wallet.writeContract({ address: source.usdc, abi: usdcAbi, functionName: "approve", args: [source.tokenMessengerV2, amount] });
      onStep?.("approving");
      const receipt = await client.waitForTransactionReceipt({ hash: approval });
      if (receipt.status !== "success") throw new BridgeError("failed", "The approval failed on the source chain. Nothing was moved.");
    }
    onStep?.("burn");
    const burn = await wallet.writeContract(depositForBurnCall({ tokenMessengerV2: source.tokenMessengerV2, usdc: source.usdc, arcDomain, recipient, amount }));
    onStep?.("burning");
    const receipt = await client.waitForTransactionReceipt({ hash: burn });
    if (receipt.status !== "success") throw new BridgeError("failed", "The transfer failed on the source chain. Your USDC didn't move.");
    return burn;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (rejected(error)) throw new BridgeError("rejected", "You declined in the wallet. Nothing was moved.");
    throw new BridgeError("failed", "The wallet couldn't send that. Nothing was moved; try again.");
  }
}

/** Asks Polaris where a burn is: waiting for Circle's attestation, minted on Arc, or failed. Idempotent. */
export function mintStatus(sourceDomain: number, txHash: Hex): Promise<MintStatus> {
  return api<MintStatus>("/api/public/cctp/mint", { method: "POST", body: { sourceDomain, txHash } });
}

/** The record of a burn that just landed on the source chain. */
export function pendingBurn(source: CctpSource, txHash: Hex, amount: Micros, recipient: Address): PendingBurn {
  return {
    sourceDomain: source.domain,
    sourceChainId: source.chainId,
    sourceName: source.name,
    txHash,
    amount: amount.toString(),
    recipient,
    explorerUrl: source.explorerUrl,
    at: Date.now(),
  };
}

/* ── Burns waiting on this device ──────────────────────────────────────── */

const STORE = "polaris.cctp.pending";
const listeners = new Set<() => void>();
const NONE: PendingBurn[] = [];
let cache: { raw: string | null; burns: PendingBurn[] } | null = null;

function read(): string | null {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

/** The burns waiting on this device, newest first (the same array until they change). */
export function pendingBurns(): PendingBurn[] {
  if (typeof window === "undefined") return NONE;
  const raw = read();
  if (cache && cache.raw === raw) return cache.burns;
  let burns: PendingBurn[] = [];
  try {
    const parsed = JSON.parse(raw ?? "[]") as PendingBurn[];
    burns = Array.isArray(parsed) ? parsed.filter((b) => typeof b?.txHash === "string" && typeof b.sourceDomain === "number") : [];
  } catch {
    burns = [];
  }
  cache = { raw, burns };
  return burns;
}

/** For useSyncExternalStore: every change to the list on this device. */
export function subscribeBurns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For useSyncExternalStore's server render: nothing kept. */
export function noBurns(): PendingBurn[] {
  return NONE;
}

function write(burns: PendingBurn[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(burns.slice(0, 10)));
  } catch {
    // private mode: the wait just doesn't survive a reload
  }
  for (const l of listeners) l();
}

export function rememberBurn(burn: PendingBurn): void {
  write([burn, ...pendingBurns().filter((b) => b.txHash !== burn.txHash)]);
}

export function forgetBurn(txHash: Hex): void {
  write(pendingBurns().filter((b) => b.txHash !== txHash));
}
