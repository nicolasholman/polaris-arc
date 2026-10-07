import { type Address, createPublicClient, createWalletClient, custom, type Hex, isHex, parseEventLogs, zeroAddress } from "viem";
import { api } from "./api";
import { BridgeError, injectedProvider, sourceBalances, sourceChain } from "./cctp";
import { type CcipSource, ccipSenderAbi, payOnArcCall } from "./cross-chain.ts";
import { type BurnIntentTypedData, type DepositChain, erc20Abi, gatewayDepositCalls, signTypedDataV4Params } from "./gateway.ts";
import type { Micros } from "./money";
import type { CctpSource } from "./network";

/**
 * Pay from any chain, the wallet half: the buyer's browser wallet (MetaMask
 * or any injected one) on the chain their dollars are on, and Polaris for
 * Business's Gateway endpoints. Nothing here moves money without the wallet
 * asking the buyer first.
 */

function rejected(error: unknown): boolean {
  const e = error as { code?: number; cause?: { code?: number }; name?: string };
  return e?.code === 4001 || e?.cause?.code === 4001 || e?.name === "UserRejectedRequestError";
}

function requireProvider() {
  const provider = injectedProvider();
  if (!provider) throw new BridgeError("no-wallet", "No browser wallet found. Open this page in a browser with a wallet extension.");
  return provider;
}

/** A source chain in the shape cctp.ts's wallet helpers take (switch, balances). */
export function asSource(chain: { chainId: number; name: string; domain: number; usdc: Address; rpcUrl: string; explorerUrl: string; tokenMessengerV2?: Address }): CctpSource {
  return { chainId: chain.chainId, name: chain.name, domain: chain.domain, usdc: chain.usdc, rpcUrl: chain.rpcUrl, explorerUrl: chain.explorerUrl, tokenMessengerV2: chain.tokenMessengerV2 ?? zeroAddress };
}

/* ── Circle Gateway ────────────────────────────────────────────────────── */

export type GatewayBalance = { domain: number; name: string; balanceUnits: bigint };
export type GatewayBalances = { available: boolean; total: bigint; balances: GatewayBalance[] };

/** The wallet's unified balance, per chain (`GET /api/public/gateway?depositor=`). */
export async function gatewayBalances(path: string, depositor: Address): Promise<GatewayBalances> {
  const raw = await api<{ available?: boolean; totalUnits?: string; balances?: { domain: number; name: string; balanceUnits: string }[] }>(
    `${path}?depositor=${encodeURIComponent(depositor)}`,
  );
  const balances = (raw.balances ?? []).map((b) => ({ domain: Number(b.domain), name: String(b.name), balanceUnits: BigInt(b.balanceUnits || "0") }));
  return { available: raw.available !== false, total: BigInt(raw.totalUnits || "0"), balances };
}

/** The burn intent to sign (`POST /api/public/gateway/intent`). */
export function gatewayIntent(path: string, body: { depositor: Address; sourceDomain: number; recipient: Address; amount: Micros }): Promise<{ typedData: BurnIntentTypedData; maxFeeUnits: string }> {
  return api(path, { method: "POST", body: { depositor: body.depositor, sourceDomain: body.sourceDomain, recipient: body.recipient, amountUnits: body.amount.toString() } });
}

/** Asks the wallet to sign the burn intent. No gas, any network: Gateway's domain has no chainId. */
export async function signBurnIntent(signer: Address, typedData: BurnIntentTypedData): Promise<Hex> {
  const provider = requireProvider();
  try {
    const signature = (await provider.request({ method: "eth_signTypedData_v4", params: signTypedDataV4Params(signer, typedData) } as never)) as unknown;
    if (typeof signature !== "string" || !isHex(signature)) throw new BridgeError("failed", "The wallet didn't return a signature. Nothing was moved.");
    return signature;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (rejected(error)) throw new BridgeError("rejected", "You declined in the wallet. Nothing was moved.");
    throw new BridgeError("failed", "The wallet couldn't sign that. Nothing was moved; try again.");
  }
}

export type GatewayMintResult = {
  status: "minted" | "submitted";
  recipient: Address;
  amountUnits: string;
  feeUnits: string | null;
  transferId: string | null;
  mintTxHash: Hex;
  explorerUrl: string | null;
};

/** Spends the signed intent: Circle attests it and Polaris mints the USDC on Arc (`POST /api/public/gateway/mint`). */
export function gatewayMint(path: string, burnIntent: BurnIntentTypedData["message"], signature: Hex): Promise<GatewayMintResult> {
  return api(path, { method: "POST", body: { burnIntent, signature } });
}

/**
 * Deposits `amount` USDC into Circle's GatewayWallet on a source chain:
 * approve (only when the allowance is short), then deposit. Returns the
 * deposit's hash once it is mined; it is spendable once that chain is final.
 */
export async function depositToGateway(input: {
  chain: DepositChain;
  gatewayWallet: Address;
  from: Address;
  amount: Micros;
  onStep?: (step: "approve" | "approving" | "deposit" | "depositing") => void;
}): Promise<Hex> {
  const { chain, gatewayWallet, from, amount, onStep } = input;
  const provider = requireProvider();
  const source = asSource(chain);
  if (Number(await provider.request({ method: "eth_chainId" })) !== chain.chainId) throw new BridgeError("wrong-chain", `Switch your wallet to ${chain.name} first.`);
  const { usdc, gas } = await sourceBalances(source, from);
  if (usdc < amount) throw new BridgeError("insufficient-funds", `This wallet holds less USDC than that on ${chain.name}.`);
  if (gas === 0n) throw new BridgeError("no-gas", `This wallet has no ${chain.nativeSymbol} for gas on ${chain.name}. Get some from a faucet, then try again.`);
  const viemChain = sourceChain(source);
  const wallet = createWalletClient({ account: from, chain: viemChain, transport: custom(provider) });
  const client = createPublicClient({ chain: viemChain, transport: custom(provider) });
  const calls = gatewayDepositCalls({ usdc: chain.usdc, wallet: gatewayWallet, amount });
  try {
    const allowance = await client.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "allowance", args: [from, gatewayWallet] });
    if (allowance < amount) {
      onStep?.("approve");
      const approval = await wallet.writeContract(calls.approve);
      onStep?.("approving");
      const receipt = await client.waitForTransactionReceipt({ hash: approval });
      if (receipt.status !== "success") throw new BridgeError("failed", "The approval failed. Nothing was deposited.");
    }
    onStep?.("deposit");
    const hash = await wallet.writeContract(calls.deposit);
    onStep?.("depositing");
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new BridgeError("failed", "The deposit failed. Your USDC didn't move.");
    return hash;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (rejected(error)) throw new BridgeError("rejected", "You declined in the wallet. Nothing was deposited.");
    throw new BridgeError("failed", "The wallet couldn't send that. Nothing was deposited; try again.");
  }
}

/* ── Chainlink CCIP ────────────────────────────────────────────────────── */

export type CcipPayment = { txHash: Hex; messageId: Hex | null; fee: bigint };

/**
 * Pays an order on Arc from a source chain in one transaction:
 * PolarisCCIPSender takes the USDC, burns it to Arc with CCTP and sends the
 * order with CCIP (the fee in the chain's native coin, quoted first, sent
 * with a tenth of margin and the rest refunded).
 */
export async function payOrderOverCcip(input: {
  source: CcipSource;
  explorerUrl: string;
  from: Address;
  merchant: Address;
  amount: Micros;
  orderId: string;
  arcRefundTo: Address;
  onStep?: (step: "quote" | "approve" | "approving" | "pay" | "paying") => void;
}): Promise<CcipPayment> {
  const { source, from, amount, onStep } = input;
  const provider = requireProvider();
  const asCctp = asSource({ ...source, domain: source.cctpDomain, explorerUrl: input.explorerUrl });
  if (Number(await provider.request({ method: "eth_chainId" })) !== source.chainId) throw new BridgeError("wrong-chain", `Switch your wallet to ${source.name} first.`);
  const { usdc, gas } = await sourceBalances(asCctp, from);
  if (usdc < amount) throw new BridgeError("insufficient-funds", `This wallet holds less USDC than that on ${source.name}.`);
  if (gas === 0n) throw new BridgeError("no-gas", `This wallet has no gas on ${source.name}. The CCIP fee is paid in it.`);
  const chain = sourceChain(asCctp);
  const wallet = createWalletClient({ account: from, chain, transport: custom(provider) });
  const client = createPublicClient({ chain, transport: custom(provider) });
  try {
    onStep?.("quote");
    // quotePay reads msg.sender into the message, so it is asked as the payer.
    const fee = await client.readContract({
      address: source.sender,
      abi: ccipSenderAbi,
      functionName: "quotePay",
      args: [input.merchant, amount, input.orderId, input.arcRefundTo],
      account: from,
    });
    const call = payOnArcCall({ sender: source.sender, merchant: input.merchant, amount, orderId: input.orderId, arcRefundTo: input.arcRefundTo, fee });
    if (gas < call.value) throw new BridgeError("no-gas", `This wallet needs a little more gas on ${source.name} for the CCIP fee.`);
    const allowance = await client.readContract({ address: source.usdc, abi: erc20Abi, functionName: "allowance", args: [from, source.sender] });
    if (allowance < amount) {
      onStep?.("approve");
      const approval = await wallet.writeContract({ address: source.usdc, abi: erc20Abi, functionName: "approve", args: [source.sender, amount] });
      onStep?.("approving");
      const receipt = await client.waitForTransactionReceipt({ hash: approval });
      if (receipt.status !== "success") throw new BridgeError("failed", "The approval failed. Nothing was paid.");
    }
    onStep?.("pay");
    const txHash = await wallet.writeContract(call);
    onStep?.("paying");
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new BridgeError("failed", "The payment failed on the source chain. Your USDC didn't move.");
    const [sent] = parseEventLogs({ abi: ccipSenderAbi, logs: receipt.logs, eventName: "PaySent" });
    return { txHash, messageId: sent?.args.messageId ?? null, fee };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (rejected(error)) throw new BridgeError("rejected", "You declined in the wallet. Nothing was paid.");
    throw new BridgeError("failed", "The wallet couldn't send that. Nothing was paid; try again.");
  }
}
