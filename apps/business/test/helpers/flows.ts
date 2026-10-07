import { encodePacked, keccak256, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { collectionsReceiverAbi, polarisCheckoutAbi, polarisLoanEngineAbi, polarisPaymentsAbi } from "@polarispay/contracts/abi";
import { POST as createKey } from "@/app/api/keys/route";
import { POST as createWebhook } from "@/app/api/webhooks/route";
import { POST as createSessionRoute } from "@/app/api/v1/checkout/sessions/route";
import { TYPES } from "@/server/relayer/typed-data";

import type { LogSpec, SentTx } from "./fake-chain";
import { ADDR, json, params, request, signIn, type TestEnv } from "./env";

export const stablecoinDomain = { name: "Agora Dollar", version: "1", chainId: 31337, verifyingContract: ADDR.stablecoin } as const;
export const checkoutDomain = { name: "PolarisCheckout", version: "1", chainId: 31337, verifyingContract: ADDR.checkout } as const;

export type Merchant = { account: LocalAccount; userId: string; secret: string; publishableKey: string; webhookSecret: string | null };

/** A merchant signed in with a wallet we hold the key to, an API key, and optionally a webhook endpoint. */
export async function merchantWithKeys(opts: { webhook?: boolean; userId?: string } = {}): Promise<Merchant> {
  const account = privateKeyToAccount(generatePrivateKey());
  const userId = opts.userId ?? `did:privy:${account.address.slice(2, 10)}`;
  signIn({ userId, walletAddress: account.address, walletId: `wal_${account.address.slice(2, 10)}` });
  const key = await json(await createKey(request("POST", "/api/keys", { body: { name: "Server" } }), params({})));
  let webhookSecret: string | null = null;
  if (opts.webhook) {
    const hook = await json(
      await createWebhook(
        request("POST", "/api/webhooks", {
          body: {
            url: "http://127.0.0.1:3531/webhook",
            events: ["payment.succeeded", "plan.opened", "installment.collected", "installment.failed", "plan.completed", "plan.liquidated", "subscription.charged", "subscription.canceled", "payout.paid"],
          },
        }),
        params({}),
      ),
    );
    webhookSecret = hook.body.data.secret;
  }
  return { account, userId, secret: key.body.data.secret, publishableKey: key.body.data.key.publishableKey, webhookSecret };
}

export async function newSession(merchant: Merchant, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await json(
    await createSessionRoute(
      request("POST", "/api/v1/checkout/sessions", {
        headers: { authorization: `Bearer ${merchant.secret}` },
        body: { amount: "200.00", description: "Brand identity package", modes: ["now", "later"], successUrl: "https://studio.example/thanks", orderId: `INV-${Math.random().toString(36).slice(2, 8)}`, ...over },
      }),
      params({}),
    ),
  );
  if (res.status !== 201) throw new Error(`session: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export const orderKey = (merchant: Address, orderId: string) => keccak256(encodePacked(["address", "string"], [merchant, orderId]));

export const inSeconds = (s: number) => String(Math.floor(Date.now() / 1000) + s);

/** The buyer's ERC-3009 authorisation for Pay now on a session. */
export async function signPayNow(buyer: LocalAccount, merchant: Address, orderId: string, amountUnits: bigint, validBefore = inSeconds(900)) {
  const signature = await buyer.signTypedData({
    domain: stablecoinDomain,
    types: TYPES.ReceiveWithAuthorization,
    primaryType: "ReceiveWithAuthorization",
    message: { from: buyer.address, to: ADDR.payments, value: amountUnits, validAfter: 0n, validBefore: BigInt(validBefore), nonce: orderKey(merchant, orderId) },
  });
  return { validAfter: "0", validBefore, signature };
}

/** What the contracts emit, so the fake chain's receipts look like the real ones. */
export function emitLikeTheContracts(env: TestEnv, opts: { loanId?: bigint; subId?: bigint; startedAt?: bigint } = {}) {
  env.chain.onSend = (tx: SentTx, fn): LogSpec[] => {
    if (fn.functionName === "pay" && tx.to.toLowerCase() === ADDR.checkout.toLowerCase()) {
      const [buyer, merchant, amount, orderId] = fn.args as [Address, Address, bigint, string];
      const key = orderKey(merchant, orderId);
      const fee = (amount * 50n) / 10_000n;
      return [
        { address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "PaymentMade", args: { paymentId: key, payer: buyer, merchant, amount, fee, orderId } },
        { address: ADDR.checkout, abi: polarisCheckoutAbi as never, eventName: "CheckoutPaid", args: { orderKey: key, merchant, buyer, orderId, amount, fee } },
      ];
    }
    if (fn.functionName === "payWithAuthorization") {
      const [payer, merchant, amount, orderId] = fn.args as [Address, Address, bigint, string];
      return [{ address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "PaymentMade", args: { paymentId: orderKey(merchant, orderId), payer, merchant, amount, fee: (amount * 50n) / 10_000n, orderId } }];
    }
    if (fn.functionName === "openPlan") {
      const [intent] = fn.args as [{ buyer: Address; merchant: Address; principal: bigint; installments: number; interval: bigint; orderId: string }];
      const loanId = opts.loanId ?? 1n;
      const startedAt = opts.startedAt ?? env.chain.timestamp;
      const interest = (intent.principal * 1000n * BigInt(intent.installments) * intent.interval) / (10_000n * 365n * 86_400n);
      const totalOwed = intent.principal + interest;
      return [
        { address: ADDR.loanEngine, abi: polarisLoanEngineAbi as never, eventName: "LoanCreated", args: { loanId, borrower: intent.buyer, merchant: intent.merchant, principal: intent.principal, totalOwed, installments: intent.installments } },
        {
          address: ADDR.checkout,
          abi: polarisCheckoutAbi as never,
          eventName: "PlanOpened",
          args: { orderKey: orderKey(intent.merchant, intent.orderId), merchant: intent.merchant, buyer: intent.buyer, loanId, orderId: intent.orderId, principal: intent.principal, totalOwed, installments: intent.installments, interval: intent.interval, firstDueAt: startedAt + intent.interval },
        },
      ];
    }
    if (fn.functionName === "subscribe") {
      const [intent] = fn.args as [{ buyer: Address; merchant: Address; planId: bigint; pricePerPeriod: bigint; periodSeconds: bigint; orderId: string }];
      const subId = opts.subId ?? 1n;
      return [
        { address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "Subscribed", args: { subId, planId: intent.planId, subscriber: intent.buyer } },
        { address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "SubscriptionCharged", args: { subId, amount: intent.pricePerPeriod, fee: (intent.pricePerPeriod * 50n) / 10_000n, period: 1 } },
        {
          address: ADDR.checkout,
          abi: polarisCheckoutAbi as never,
          eventName: "SubscriptionStarted",
          args: { orderKey: orderKey(intent.merchant, intent.orderId), merchant: intent.merchant, buyer: intent.buyer, subId, planId: intent.planId, orderId: intent.orderId, pricePerPeriod: intent.pricePerPeriod, periodSeconds: intent.periodSeconds, nextChargeAt: env.chain.timestamp + intent.periodSeconds },
        },
      ];
    }
    if (fn.functionName === "createPlanFor") {
      const [merchant, price, period] = fn.args as [Address, bigint, bigint];
      return [{ address: ADDR.payments, abi: polarisPaymentsAbi as never, eventName: "PlanCreated", args: { planId: 7n, merchant, price, period } }];
    }
    return [];
  };
}

export const collections = { address: ADDR.collections, abi: collectionsReceiverAbi as never };
export type { Hex };
