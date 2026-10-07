import type { PolarisChain } from "../chains.js";
import { PolarisError } from "../errors.js";
import type { Eip1193Provider, Hex } from "../types.js";

/**
 * The few EIP-1193 calls a payment needs, written against the bare
 * `request` interface so any provider works: an injected wallet, Privy,
 * WalletConnect, a viem-wrapped Mera account, or Hardhat's provider.
 */

export function findProvider(explicit?: unknown): Eip1193Provider {
  const candidate = explicit ?? (globalThis as { ethereum?: unknown }).ethereum;
  if (!candidate || typeof (candidate as Eip1193Provider).request !== "function") {
    throw new PolarisError("No wallet found. Pass an EIP-1193 provider as `provider`, or install a browser wallet.", {
      type: "wallet_error",
      code: "no_wallet",
    });
  }
  return candidate as Eip1193Provider;
}

function errorCode(err: unknown): number | undefined {
  const e = err as { code?: unknown; data?: { originalError?: { code?: unknown } } };
  if (typeof e?.code === "number") return e.code;
  if (typeof e?.data?.originalError?.code === "number") return e.data.originalError.code;
  return undefined;
}

export async function requestAccount(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as unknown;
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== "string") {
    throw new PolarisError("The wallet returned no account.", { type: "wallet_error", code: "no_account" });
  }
  return first;
}

export async function chainIdOf(provider: Eip1193Provider): Promise<number> {
  const raw = await provider.request({ method: "eth_chainId" });
  return typeof raw === "string" ? Number.parseInt(raw, 16) : Number(raw);
}

function wrongChain(chain: PolarisChain, cause?: unknown): PolarisError {
  return new PolarisError(`Switch your wallet to ${chain.name} to pay.`, { type: "wallet_error", code: "wrong_chain", cause });
}

/**
 * Switch the wallet to `chain`, adding it first if the wallet has never seen
 * it (error 4902). When the buyer declines the switch or the add, or the
 * wallet can't switch on its own, this throws `wrong_chain` ("Switch your
 * wallet to Monad Testnet to pay."), never "You cancelled the request.": the
 * buyer didn't cancel the payment, and the next step is to change network.
 * The wallet's own error is kept as `cause`.
 */
export async function ensureChain(provider: Eip1193Provider, chain: PolarisChain): Promise<void> {
  if ((await chainIdOf(provider)) === chain.chainId) return;
  const chainId = `0x${chain.chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err) {
    if (errorCode(err) !== 4902) throw wrongChain(chain, err);
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: chain.name,
            rpcUrls: [chain.rpcUrl],
            blockExplorerUrls: [chain.explorer],
            nativeCurrency: chain.nativeCurrency,
          },
        ],
      });
    } catch (addErr) {
      throw wrongChain(chain, addErr);
    }
  }
  if ((await chainIdOf(provider)) !== chain.chainId) throw wrongChain(chain);
}

export async function ethCall(provider: Eip1193Provider, to: string, data: string): Promise<Hex> {
  const out = await provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
  if (typeof out !== "string") throw new PolarisError("The wallet returned no data for a read.", { type: "wallet_error", code: "bad_call" });
  return out as Hex;
}

export type Receipt = { status: "success" | "reverted"; transactionHash: Hex; blockNumber: number };

/** Poll for a receipt. Monad finalises in under a second, so this is short in practice. */
export async function waitForReceipt(provider: Eip1193Provider, txHash: string, timeoutMs = 60_000): Promise<Receipt> {
  const started = Date.now();
  let delay = 250;
  for (;;) {
    const receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] })) as
      | { status?: string; transactionHash?: string; blockNumber?: string }
      | null;
    if (receipt && receipt.status !== undefined) {
      return {
        status: receipt.status === "0x1" || receipt.status === "1" ? "success" : "reverted",
        transactionHash: (receipt.transactionHash ?? txHash) as Hex,
        blockNumber: receipt.blockNumber ? Number.parseInt(receipt.blockNumber, 16) : 0,
      };
    }
    if (Date.now() - started > timeoutMs) {
      throw new PolarisError("The payment was sent but hasn't confirmed yet. Check the transaction before retrying.", {
        type: "wallet_error",
        code: "receipt_timeout",
      });
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2_000);
  }
}

/**
 * Turn wallet, RPC and contract noise into a sentence a buyer can act on.
 * The raw error is kept on the result for your logs.
 */
export function buyerMessage(err: unknown, chain?: PolarisChain): string {
  if (err instanceof PolarisError && err.type !== "api_error" && err.type !== "connection_error") return err.message;
  const code = errorCode(err);
  const raw =
    (err as { shortMessage?: string })?.shortMessage ??
    (err as { data?: { message?: string } })?.data?.message ??
    (err as Error)?.message ??
    String(err);

  if (code === 4001 || /user rejected|user denied|rejected the request|cancell?ed by user/i.test(raw)) return "You cancelled the request.";
  if (/DuplicatePayment/i.test(raw)) return "This order has already been paid.";
  if (/WrongAmount/i.test(raw)) return "The price of this order changed. Refresh and try again.";
  if (/AuthorizationExpired|SignatureExpired/i.test(raw)) return "The confirmation expired. Try again.";
  if (/AuthorizationAlreadyUsed/i.test(raw)) return "This confirmation was already used. Try again.";
  if (/ExceedsCreditLimit/i.test(raw)) return "This order is above your credit limit.";
  if (/MerchantNotEligible|InvalidMerchant/i.test(raw)) return "This merchant can't accept the order right now.";
  if (/transfer amount exceeds balance|InsufficientBalance|ERC20InsufficientBalance/i.test(raw)) return "Not enough dollars in your account for this.";
  if (/insufficient funds/i.test(raw)) {
    return `Not enough ${chain?.nativeCurrency.symbol ?? "gas"} for the network fee.`;
  }
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}
