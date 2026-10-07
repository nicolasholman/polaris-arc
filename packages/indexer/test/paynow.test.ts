/**
 * Pay now: the order, the payment, the merchant's totals, day candle and
 * balance, the webhook row, and the rule that "Paid" only ever comes from an
 * indexed chain event.
 */

import { describe, expect, it } from "vitest";

import { A, account, RELAYER, Sim, USD } from "./sim.js";

const merchant = account(0x111);
const buyer = account(0x222);
const orderKey = `0x${"ab".repeat(32)}`;

function payNow(sim: Sim, key: string, amount: bigint, orderId: string) {
  const fee = (amount * 50n) / 10_000n;
  // Only the merchant's leg is simulated: the buyer's and the treasury's
  // transfers never reach a handler (the source filters them), which the
  // test indexer rejects as a mistake.
  sim
    .tx({ from: RELAYER, to: A.PolarisCheckout })
    .transfer(A.PolarisPayments, merchant, amount - fee)
    .log("PolarisPayments", "PaymentMade", { paymentId: key, payer: buyer, merchant, amount, fee, orderId })
    .log("PolarisCheckout", "CheckoutPaid", { orderKey: key, merchant, buyer, orderId, amount, fee });
  return fee;
}

describe("Pay now", () => {
  it("records the payment, the order and the merchant's money", async () => {
    const sim = new Sim().registerMerchant(merchant);
    sim.tx({ from: merchant, to: A.PolarisPayments }).log("PolarisPayments", "OrderQuoted", { paymentId: orderKey, merchant, amount: USD(25) });
    await sim.run();
    expect((await sim.indexer.Order.getOrThrow(orderKey)).status).toBe("QUOTED");

    const fee = payNow(sim, orderKey, USD(25), "order-1");
    await sim.run();

    const payment = await sim.indexer.Payment.getOrThrow(orderKey);
    expect(payment).toMatchObject({
      mode: "PAY_NOW",
      amount: USD(25),
      fee,
      net: USD(25) - fee,
      orderId: "order-1",
      quotedAmount: USD(25),
      viaCheckout: true,
      relayer: RELAYER,
      merchant_id: merchant,
      buyer_id: buyer,
    });

    const order = await sim.indexer.Order.getOrThrow(orderKey);
    expect(order).toMatchObject({ status: "PAID", kind: "PAY_NOW", amount: USD(25), quoteMatched: true, payment_id: orderKey });

    const m = await sim.indexer.Merchant.getOrThrow(merchant);
    expect(m).toMatchObject({
      paymentCount: 1,
      payNowCount: 1,
      grossVolume: USD(25),
      netVolume: USD(25) - fee,
      customerCount: 1,
      // Only the net reached the merchant's account.
      balance: USD(25) - fee,
      payoutCount: 0,
    });

    const [activity] = await sim.indexer.Activity.getAll();
    expect(activity).toMatchObject({ kind: "payment.succeeded", merchant_id: merchant, orderId: "order-1", amount: USD(25), mode: "PAY_NOW" });

    const p = await sim.indexer.Protocol.getOrThrow("polaris");
    expect(p).toMatchObject({ paymentCount: 1, payNowVolume: USD(25), merchantCount: 1, buyerCount: 1 });
  });

  it("counts a merchant's money from its registration, and every payment in its volume", async () => {
    const sim = new Sim();
    // Paid before registering: the payment counts, but its transfer was never
    // fetched (the account wasn't followed yet), so it isn't simulated here.
    const early = USD(10);
    sim
      .tx({ from: RELAYER, to: A.PolarisCheckout })
      .log("PolarisPayments", "PaymentMade", { paymentId: `0x${"e1".repeat(32)}`, payer: buyer, merchant, amount: early, fee: 0n, orderId: "early" });
    await sim.run();
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({ registered: false, registeredAt: undefined, grossVolume: early, balance: 0n });

    sim.registerMerchant(merchant);
    const fee = payNow(sim, orderKey, USD(25), "order-1");
    await sim.run();
    const m = await sim.indexer.Merchant.getOrThrow(merchant);
    expect(m).toMatchObject({ registered: true, grossVolume: early + USD(25), balance: USD(25) - fee });
    expect(m.registeredAt).toBeTypeOf("number");
  });

  it("follows only accounts that registered as merchants, never one that was merely paid", async () => {
    // Paying an account (an exchange's hot wallet, say) a cent must not make
    // the indexer fetch every transfer it ever makes afterwards.
    const sim = new Sim();
    const stranger = account(0xde);
    sim
      .tx({ from: buyer, to: A.PolarisPayments })
      .log("PolarisPayments", "PaymentMade", { paymentId: `0x${"de".repeat(32)}`, payer: buyer, merchant: stranger, amount: 1n, fee: 0n, orderId: "a-cent" });
    sim.tx({ from: RELAYER, to: A.Stablecoin }).transfer(stranger, account(0x903), USD(1_000));
    await expect(sim.run()).rejects.toThrow(/never reached a handler/);
  });

  it("keeps a day candle of payment sizes and the balance through the day", async () => {
    const sim = new Sim(1_790_031_600).registerMerchant(merchant); // 2026-09-21 23:00 UTC
    payNow(sim, `0x${"01".repeat(32)}`, USD(40), "a");
    payNow(sim, `0x${"02".repeat(32)}`, USD(10), "b");
    payNow(sim, `0x${"03".repeat(32)}`, USD(90), "c");
    payNow(sim, `0x${"04".repeat(32)}`, USD(20), "d");
    sim.wait(3_600); // past midnight
    payNow(sim, `0x${"05".repeat(32)}`, USD(5), "e");
    await sim.run();

    const days = (await sim.indexer.MerchantDay.getAll()).sort((a, b) => a.day - b.day);
    expect(days).toHaveLength(2);
    const [d1, d2] = days;
    expect(d1).toMatchObject({ date: "2026-09-21", paymentCount: 4, grossVolume: USD(160), open: USD(40), high: USD(90), low: USD(10), close: USD(20), newCustomers: 1 });
    expect(d1!.balanceOpen).toBe(0n);
    expect(d1!.balanceClose).toBe(USD(160) - (USD(160) * 50n) / 10_000n);
    expect(d2).toMatchObject({ date: "2026-09-22", paymentCount: 1, open: USD(5), close: USD(5), newCustomers: 0 });
    expect(d2!.balanceOpen).toBe(d1!.balanceClose);
  });

  it("never even fetches stablecoin transfers between accounts that are not merchants", async () => {
    const sim = new Sim();
    sim.tx({ to: A.Stablecoin }).transfer(account(0x901), account(0x902), USD(1_000));
    // The wildcard Transfer's where filter drops it at the source.
    await expect(sim.run()).rejects.toThrow(/never reached a handler/);
  });
});
