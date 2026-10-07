import { getAddress } from "ethers";

import { assertDeployed, explorerTxUrl, type PolarisChain } from "../chains.js";
import { PolarisError, invalidRequest } from "../errors.js";
import { formatBaseUnits, toBaseUnits, type AmountInput } from "../money.js";
import type { Address, Eip1193Provider, Hex } from "../types.js";
import { CLIENT_HEADER } from "../version.js";
import {
  encodePayWithAuthorization,
  paymentId as derivePaymentId,
  payments as paymentsAbi,
  readDomain,
  signAuthorization,
  token as tokenAbi,
} from "./eip3009.js";
import { buyerMessage, ensureChain, ethCall, requestAccount, waitForReceipt } from "./wallet.js";

/**
 * Direct pay: one signature from the buyer, and PolarisPayments settles the
 * order in AUSD.
 *
 *   1. The wallet signs an ERC-3009 ReceiveWithAuthorization naming
 *      PolarisPayments as the payee and keccak256(merchant, orderId) as the nonce.
 *   2. With a `relayUrl`, the Polaris relayer (a policy-locked Privy server
 *      wallet) submits payWithAuthorization and pays the gas: the buyer needs
 *      AUSD and nothing else. Without one, the wallet sends it and pays the gas.
 *
 * Either way the money can only go to the merchant in the signature: a
 * relayer that changes the merchant or order changes the nonce, and AUSD
 * rejects the signature.
 */

export type PayParams = {
  /** The merchant's payout address: where the money lands. */
  merchant: string;
  /** USD amount: "25.00". */
  amount: AmountInput;
  /**
   * Your order id. An order can be paid once; a retry of a paid order fails
   * with "already paid" instead of charging twice. Make it unguessable
   * (e.g. crypto.randomUUID()): a guessable id can be paid first by someone
   * else, so check `payer` and `amount` before you fulfil.
   */
  orderId: string;
  /** How long the signature stays valid. Default 15 minutes. */
  validForSeconds?: number;
  /** Wait for the transaction to confirm before resolving. Default true. */
  wait?: boolean;
  /** Progress, for UI: connecting the wallet, waiting for the signature, submitting, confirming. */
  onStage?: (stage: PayStage) => void;
};

export type PayStage = "connecting" | "signing" | "submitting" | "confirming";

export type Result = {
  ok: boolean;
  transactionHash?: string;
  explorerUrl?: string;
  /** A sentence for the buyer when `ok` is false. */
  error?: string;
  /** The original error, for your logs. */
  cause?: unknown;
};

export type PayResult = Result & {
  /** PolarisPayments payment id: keccak256(abi.encodePacked(merchant, orderId)). */
  paymentId?: Hex;
  payer?: Address;
  /** "25.00" */
  amount?: string;
  /** True when the Polaris relayer submitted it (gasless for the buyer). */
  relayed?: boolean;
};

export type PayContext = {
  chain: PolarisChain;
  provider: Eip1193Provider;
  relayUrl?: string;
  publishableKey?: string;
  fetch?: typeof fetch;
  /** Relay request timeout. Default 30 s. */
  relayTimeoutMs?: number;
};

const ORDER_ID_MAX = 200;

export async function payWithAuthorization(ctx: PayContext, params: PayParams): Promise<PayResult> {
  const { chain, provider } = ctx;
  // Configuration mistakes throw; everything the buyer can cause comes back as a Result.
  assertDeployed(chain, ["payments", "stablecoin"]);
  if (!chain.features.payWithAuthorization) {
    throw new PolarisError(`${chain.name}'s PolarisPayments has no payWithAuthorization.`, { type: "configuration_error", code: "unsupported_chain" });
  }
  let merchant: Address;
  try {
    merchant = getAddress(params.merchant) as Address;
  } catch {
    throw invalidRequest("invalid_merchant", `merchant must be an address, got ${JSON.stringify(params.merchant)}.`, "merchant");
  }
  if (typeof params.orderId !== "string" || params.orderId.length === 0 || params.orderId.length > ORDER_ID_MAX) {
    throw invalidRequest("invalid_order_id", `orderId must be a non-empty string of at most ${ORDER_ID_MAX} characters.`, "orderId");
  }
  const validFor = params.validForSeconds ?? 15 * 60;
  if (!Number.isInteger(validFor) || validFor < 60 || validFor > 24 * 3600) {
    throw invalidRequest("invalid_validity", "validForSeconds must be between 60 and 86400.", "validForSeconds");
  }

  const stage = (s: PayStage) => {
    try {
      params.onStage?.(s);
    } catch {
      /* a UI callback must not break a payment */
    }
  };

  try {
    stage("connecting");
    const payer = getAddress(await requestAccount(provider)) as Address;
    await ensureChain(provider, chain);

    const read = async (to: string, fn: string, args: unknown[], iface: typeof tokenAbi) =>
      iface.decodeFunctionResult(fn, await ethCall(provider, to, iface.encodeFunctionData(fn, args)));

    // Decimals from the token, never assumed.
    const [decimals] = await read(chain.stablecoin, "decimals", [], tokenAbi);
    const amount = toBaseUnits(params.amount, Number(decimals));
    const id = derivePaymentId(merchant, params.orderId);

    const [[balance], [existing], [quoted], domain] = await Promise.all([
      read(chain.stablecoin, "balanceOf", [payer], tokenAbi),
      read(chain.payments, "paymentFor", [merchant, params.orderId], paymentsAbi),
      read(chain.payments, "quotedAmount", [merchant, id], paymentsAbi),
      readDomain(provider, chain.stablecoin, chain.chainId),
    ]);
    if ((existing as { paidAt: bigint }).paidAt !== 0n) {
      return { ok: false, error: "This order has already been paid.", paymentId: id, payer };
    }
    if ((quoted as bigint) !== 0n && (quoted as bigint) !== amount) {
      return {
        ok: false,
        error: `This order is priced at ${formatBaseUnits(quoted as bigint, Number(decimals))}, not ${formatBaseUnits(amount, Number(decimals))}.`,
        paymentId: id,
        payer,
      };
    }
    if ((balance as bigint) < amount) {
      return {
        ok: false,
        error: `Not enough ${chain.stablecoinSymbol}: this costs ${formatBaseUnits(amount, Number(decimals))} and you have ${formatBaseUnits(balance as bigint, Number(decimals))}.`,
        payer,
      };
    }

    stage("signing");
    const validAfter = 0n;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + validFor);
    const signature = await signAuthorization(provider, domain, {
      from: payer,
      to: getAddress(chain.payments) as Address,
      value: amount,
      validAfter,
      validBefore,
      nonce: id,
    });

    stage("submitting");
    const display = formatBaseUnits(amount, Number(decimals));
    let txHash: Hex;
    let relayed = false;
    let confirmed = false;

    if (ctx.relayUrl) {
      const relay = await postRelay(ctx, {
        type: "payWithAuthorization",
        chainId: chain.chainId,
        contract: getAddress(chain.payments) as Address,
        payer,
        merchant,
        amount: amount.toString(),
        orderId: params.orderId,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce: id,
        signature,
      });
      txHash = relay.txHash;
      relayed = true;
      confirmed = relay.status === "confirmed";
    } else {
      const data = encodePayWithAuthorization({ payer, merchant, amount, orderId: params.orderId, validAfter, validBefore, signature });
      const tx = { from: payer, to: chain.payments, data, value: "0x0" };
      // Monad charges gas on the limit, not on use: estimate and add 15%, never a blanket limit.
      const estimate = BigInt((await provider.request({ method: "eth_estimateGas", params: [tx] })) as string);
      const gas = `0x${((estimate * 115n) / 100n).toString(16)}`;
      txHash = (await provider.request({ method: "eth_sendTransaction", params: [{ ...tx, gas }] })) as Hex;
    }

    if (params.wait !== false && !confirmed) {
      stage("confirming");
      const receipt = await waitForReceipt(provider, txHash);
      if (receipt.status !== "success") {
        return {
          ok: false,
          error: "The payment didn't go through. Nothing was charged.",
          transactionHash: txHash,
          explorerUrl: explorerTxUrl(chain, txHash),
          paymentId: id,
          payer,
          relayed,
        };
      }
    }

    return { ok: true, transactionHash: txHash, explorerUrl: explorerTxUrl(chain, txHash), paymentId: id, payer, amount: display, relayed };
  } catch (err) {
    return { ok: false, error: buyerMessage(err, chain), cause: err };
  }
}

/* ── The relay HTTP contract ──────────────────────────────────────────────
 *
 * POST {relayUrl}
 *   Authorization: Bearer pk_test_…   (the merchant's publishable key, when set)
 *   Content-Type: application/json
 *   Polaris-Client: polarispay-sdk/0.3.0
 *
 *   RelayPayRequest  →  200/201 { "data": RelayPayResponse }
 *                    →  4xx/5xx { "error": { "code": "…", "message": "…" } }
 */

export type RelayPayRequest = {
  type: "payWithAuthorization";
  chainId: number;
  /** PolarisPayments. The relayer must refuse any other contract. */
  contract: Address;
  payer: Address;
  merchant: Address;
  /** AUSD base units (6 decimals), decimal string: "25000000" is $25. */
  amount: string;
  orderId: string;
  validAfter: string;
  validBefore: string;
  /** keccak256(abi.encodePacked(merchant, orderId)); the relayer recomputes it, this is for logs. */
  nonce: Hex;
  /** 65-byte r ‖ s ‖ v over ReceiveWithAuthorization, already checked to recover to `payer`. */
  signature: Hex;
};

export type RelayPayResponse = {
  txHash: Hex;
  /** "submitted": in the mempool; "confirmed": in a finalised block. */
  status: "submitted" | "confirmed";
  paymentId?: Hex;
};

async function postRelay(ctx: PayContext, body: RelayPayRequest): Promise<RelayPayResponse> {
  const doFetch = ctx.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new PolarisError("fetch is not available; pass `fetch` to createPolaris.", { type: "configuration_error", code: "no_fetch" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.relayTimeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await doFetch(ctx.relayUrl as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Polaris-Client": CLIENT_HEADER,
        ...(ctx.publishableKey ? { Authorization: `Bearer ${ctx.publishableKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new PolarisError("Couldn't reach the Polaris relayer. Nothing was charged; try again.", {
      type: "connection_error",
      code: "relay_unreachable",
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  const json = (await res.json().catch(() => null)) as { data?: RelayPayResponse; error?: { code?: string; message?: string } } | null;
  if (!res.ok || !json?.data?.txHash) {
    const message = json?.error?.message ?? `The relayer answered ${res.status}.`;
    throw new PolarisError(message, {
      type: res.status >= 500 ? "api_error" : "invalid_request_error",
      code: json?.error?.code ?? `relay_http_${res.status}`,
      status: res.status,
      requestId: res.headers.get("polaris-request-id") ?? undefined,
    });
  }
  return { status: json.data.status === "confirmed" ? "confirmed" : "submitted", txHash: json.data.txHash, paymentId: json.data.paymentId };
}

/** Read the payment recorded for an order, or null. Use it to check `payer` and `amount` before fulfilling a direct payment. */
export async function readPayment(
  provider: Eip1193Provider,
  chain: PolarisChain,
  merchant: string,
  orderId: string,
): Promise<{ paymentId: Hex; payer: Address; merchant: Address; amount: string; paidAt: Date } | null> {
  assertDeployed(chain, ["payments"]);
  const out = await ethCall(provider, chain.payments, paymentsAbi.encodeFunctionData("paymentFor", [getAddress(merchant), orderId]));
  const [record] = paymentsAbi.decodeFunctionResult("paymentFor", out);
  const r = record as { payer: string; merchant: string; amount: bigint; paidAt: bigint };
  if (r.paidAt === 0n) return null;
  return {
    paymentId: derivePaymentId(merchant, orderId),
    payer: getAddress(r.payer) as Address,
    merchant: getAddress(r.merchant) as Address,
    amount: formatBaseUnits(r.amount, chain.stablecoinDecimals),
    paidAt: new Date(Number(r.paidAt) * 1000),
  };
}
