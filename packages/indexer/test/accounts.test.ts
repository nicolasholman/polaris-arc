/**
 * Everything around the money: send-by-link, merchant payouts and balances,
 * batch settlements, the buyer's credit line, forwarder reports (simulated events) and roles.
 */

import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { A, account, RELAYER, SETTINGS, Sim, TRANSMITTER, USD } from "./sim.js";

const merchant = account(0x111);
const buyer = account(0x222);
const payoutAddress = account(0x444);
const exchange = account(0x555);

describe("Send by link", () => {
  it("follows each link to claimed, cancelled or refunded", async () => {
    const sim = new Sim();
    const [k1, k2, k3] = [account(0xa1), account(0xa2), account(0xa3)];
    sim.tx({ from: RELAYER, to: A.PolarisSend }).log("PolarisSend", "Sent", { linkKey: k1, sender: buyer, amount: USD(50), expiresAt: BigInt(sim.time + 86_400) });
    sim.tx({ from: RELAYER, to: A.PolarisSend }).log("PolarisSend", "Sent", { linkKey: k2, sender: buyer, amount: USD(5), expiresAt: BigInt(sim.time + 86_400) });
    sim.tx({ from: RELAYER, to: A.PolarisSend }).log("PolarisSend", "Sent", { linkKey: k3, sender: buyer, amount: USD(7), expiresAt: BigInt(sim.time + 600) });
    sim.tx({ from: RELAYER, to: A.PolarisSend }).log("PolarisSend", "Claimed", { linkKey: k1, to: account(0x999), amount: USD(50) });
    sim.tx({ from: RELAYER, to: A.PolarisSend }).log("PolarisSend", "Cancelled", { linkKey: k2, sender: buyer, amount: USD(5) });
    sim.wait(700).tx({ from: account(0x1234), to: A.PolarisSend }).log("PolarisSend", "Refunded", { linkKey: k3, sender: buyer, amount: USD(7) });
    await sim.run();

    expect(await sim.indexer.Send.getOrThrow(k1)).toMatchObject({ status: "CLAIMED", recipient: account(0x999), relayer: RELAYER });
    expect(await sim.indexer.Send.getOrThrow(k2)).toMatchObject({ status: "CANCELLED" });
    expect(await sim.indexer.Send.getOrThrow(k3)).toMatchObject({ status: "REFUNDED" });
    expect(await sim.indexer.Buyer.getOrThrow(buyer)).toMatchObject({ sentCount: 3, sentVolume: USD(62) });
    expect(await sim.indexer.Buyer.getOrThrow(account(0x999))).toMatchObject({ claimedCount: 1, claimedVolume: USD(50) });
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ sendCount: 3, claimCount: 1, claimVolume: USD(50) });
  });
});

describe("Merchant accounts", () => {
  function register(sim: Sim) {
    sim
      .tx({ from: RELAYER, to: A.MerchantRegistry })
      .log("MerchantRegistry", "MerchantRegistered", { merchant, name: "Studio Sur", payoutAddress })
      .log("MerchantRegistry", "MerchantRegisteredBy", { merchant, operator: RELAYER });
    sim.tx({ from: account(0x0), to: A.MerchantRegistry }).log("MerchantRegistry", "MerchantActivated", { merchant, active: true });
  }

  it("registers a merchant by its own signature, relayed", async () => {
    const sim = new Sim();
    register(sim);
    await sim.run();
    expect(await sim.indexer.Merchant.getOrThrow(merchant)).toMatchObject({
      registered: true,
      name: "Studio Sur",
      payoutAddress,
      registeredBy: RELAYER,
      active: true,
      maxOrderValue: USD(500),
    });
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ merchantCount: 1, registeredMerchantCount: 1 });
  });

  it("counts a payout only when money leaves through the stablecoin itself", async () => {
    const sim = new Sim();
    register(sim);
    // Paid by a buyer through the checkout.
    sim.tx({ from: RELAYER, to: A.PolarisCheckout }).transfer(A.PolarisPayments, merchant, USD(100));
    // One-tap withdraw: the relayer submits the merchant's transferWithAuthorization.
    sim.tx({ from: RELAYER, to: A.Stablecoin }).transfer(merchant, exchange, USD(30));
    // Automatic payout to the registered payout address.
    sim.tx({ from: RELAYER, to: A.Stablecoin }).transfer(merchant, payoutAddress, USD(20));
    // The merchant sends money as a link: it leaves through PolarisSend, not a payout.
    sim.tx({ from: RELAYER, to: A.PolarisSend }).transfer(merchant, A.PolarisSend, USD(10));
    // Another token between the same accounts is fetched (wildcard) but ignored.
    sim.tx({ from: merchant, to: account(0x7777) }).transfer(merchant, exchange, USD(1), account(0x7777));
    await sim.run();

    const m = await sim.indexer.Merchant.getOrThrow(merchant);
    expect(m).toMatchObject({ balance: USD(40), payoutCount: 2, payoutVolume: USD(50) });
    const payouts = (await sim.indexer.Payout.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    expect(payouts.map((p) => [p.destination, p.amount, p.toPayoutAddress, p.relayer])).toEqual([
      [exchange, USD(30), false, RELAYER],
      [payoutAddress, USD(20), true, RELAYER],
    ]);
    const activity = (await sim.indexer.Activity.getAll()).filter((a) => a.kind === "payout.paid");
    expect(activity.map((a) => a.destination).sort()).toEqual([exchange, payoutAddress].sort());
    const [day] = await sim.indexer.MerchantDay.getAll();
    expect(day).toMatchObject({ balanceOpen: 0n, balanceHigh: USD(100), balanceLow: 0n, balanceClose: USD(40), payoutCount: 2 });
  });

  it("records batch settlements leg by leg", async () => {
    const sim = new Sim();
    const batchId = `0x${"0b".repeat(32)}`;
    sim.tx({ from: merchant, to: A.BatchSettlement }).log("BatchSettlement", "Funded", { from: merchant, amount: USD(300) });
    sim
      .tx({ from: RELAYER, to: A.BatchSettlement })
      .log("BatchSettlement", "MerchantPaid", { batchId, merchant: account(0xb1), amount: USD(100), memo: `0x${"01".repeat(32)}` })
      .log("BatchSettlement", "MerchantPaid", { batchId, merchant: account(0xb2), amount: USD(200), memo: `0x${"02".repeat(32)}` })
      .log("BatchSettlement", "BatchSettled", { batchId, recipients: 2n, totalAmount: USD(300), settler: RELAYER });
    await sim.run();
    expect(await sim.indexer.Batch.getOrThrow(batchId)).toMatchObject({ recipients: 2, totalAmount: USD(300), settler: RELAYER });
    const legs = await sim.indexer.BatchLeg.getAll();
    expect(legs.filter((l) => l.kind === "PAID").map((l) => l.amount).sort()).toEqual([USD(100), USD(200)]);
    expect(legs.filter((l) => l.kind === "FUNDED")).toHaveLength(1);
  });
});

describe("Credit line", () => {
  const history = account(0x4157);
  const errors = parseAbi(["error StaleEvidence()"]);

  it("opens a line from an underwriting report's events (simulated) and explains every move", async () => {
    const sim = new Sim();
    // At deploy: underwriting required, collateral counts.
    sim
      .tx({ from: account(0xde), to: A.ScoreManager })
      .log("ScoreManager", "RequireUnderwritingSet", { required: true })
      .log("ScoreManager", "CollateralVaultSet", { vault: A.CollateralVault });
    await sim.run();
    sim.tx({ from: RELAYER, to: A.PolarisSend }).log("PolarisSend", "Sent", { linkKey: account(0xa1), sender: buyer, amount: 1n, expiresAt: 1n });
    await sim.run();
    expect(await sim.indexer.Buyer.getOrThrow(buyer)).toMatchObject({ creditLimit: 0n, underwritten: false });

    sim
      .tx({ from: TRANSMITTER, to: SETTINGS.creForwarders[0] })
      .log("ScoreManager", "Underwritten", { user: buyer, score: 695n, declined: false, observedAt: BigInt(sim.time - 30) })
      .log("ScoreManager", "ScoreChanged", { user: buyer, oldScore: 600n, newScore: 695n, reason: "underwritten" })
      .log("UnderwritingReceiver", "UnderwritingApplied", { user: buyer, linkedWallet: history, score: 695n })
      .log("CreForwarder", "ReportProcessed", { receiver: A.UnderwritingReceiver, workflowExecutionId: `0x${"11".repeat(32)}`, reportId: "0x0002", result: true });
    await sim.run();

    let b = await sim.indexer.Buyer.getOrThrow(buyer);
    expect(b).toMatchObject({ underwritten: true, hasRecord: true, score: 695, baseLimit: USD(1_000), creditLimit: USD(1_000), available: USD(1_000), linkedWallet: history });
    expect(await sim.indexer.LinkedWallet.getOrThrow(history)).toMatchObject({ buyer_id: buyer });
    const [uw] = await sim.indexer.Underwriting.getAll();
    expect(uw).toMatchObject({ applied: true, score: 695, declined: false, linkedWallet: history, observedAt: sim.time - 30 });
    const [report] = await sim.indexer.CreReport.getAll();
    expect(report).toMatchObject({ workflow: "underwrite", result: true, transmitter: TRANSMITTER });

    // $100 of collateral adds $150.
    sim.tx({ from: RELAYER, to: A.CollateralVault }).log("CollateralVault", "CollateralLocked", { user: buyer, amount: USD(100), newTotal: USD(100) });
    // An on-time instalment moves the score; the day's candle follows it.
    sim.tx({ from: TRANSMITTER }).log("ScoreManager", "ScoreChanged", { user: buyer, oldScore: 695n, newScore: 707n, reason: "on-time payment" });
    await sim.run();
    b = await sim.indexer.Buyer.getOrThrow(buyer);
    expect(b).toMatchObject({ collateral: USD(100), creditLimit: USD(1_150), score: 707 });
    const [day] = await sim.indexer.BuyerDay.getAll();
    expect(day).toMatchObject({ scoreOpen: 600, scoreHigh: 707, scoreLow: 600, scoreClose: 707 });
    const reasons = (await sim.indexer.ScoreEvent.getAll()).map((e) => e.reason).sort();
    expect(reasons).toEqual(["on-time payment", "underwritten"]);

    // A stale report is refused, and the app can say why.
    sim
      .tx({ from: TRANSMITTER, to: SETTINGS.creForwarders[0] })
      .log("UnderwritingReceiver", "UnderwritingRefused", { user: buyer, linkedWallet: history, reason: encodeErrorResult({ abi: errors, errorName: "StaleEvidence" }) });
    await sim.run();
    expect((await sim.indexer.Buyer.getOrThrow(buyer)).lastUnderwritingRefusal).toBe("StaleEvidence");
  });
});

describe("forwarder reports (simulated) and roles", () => {
  it("records a report the receiver reverted, and only our receivers' reports", async () => {
    const sim = new Sim();
    sim
      .tx({ from: TRANSMITTER, to: SETTINGS.creForwarders[0] })
      .log("CreForwarder", "ReportProcessed", { receiver: A.CollectionsReceiver, workflowExecutionId: `0x${"22".repeat(32)}`, reportId: "0x0001", result: false });
    await sim.run();
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ creReports: 1, creReportsFailed: 1 });
    const [r] = await sim.indexer.CreReport.getAll();
    expect(r).toMatchObject({ workflow: "collections", result: false, forwarder: SETTINGS.creForwarders[0] });

    // Somebody else's consumer on the shared forwarder: HyperSync filters it
    // by the receiver topic (the simulated source does not apply static topic
    // filters), and the handler ignores it too.
    sim
      .tx({ from: TRANSMITTER, to: SETTINGS.creForwarders[0] })
      .log("CreForwarder", "ReportProcessed", { receiver: account(0xfeed), workflowExecutionId: `0x${"33".repeat(32)}`, reportId: "0x0001", result: true });
    await sim.run();
    expect(await sim.indexer.CreReport.getAll()).toHaveLength(1);
    expect((await sim.indexer.Protocol.getOrThrow("polaris")).creReports).toBe(1);
  });

  it("keeps the relayer's roles and the protocol's settings", async () => {
    const sim = new Sim();
    sim
      .tx({ from: account(0xde) })
      .log("PolarisPayments", "OperatorSet", { operator: RELAYER, allowed: true })
      .log("MerchantRegistry", "OperatorSet", { operator: RELAYER, allowed: true })
      .log("BatchSettlement", "SettlerSet", { settler: RELAYER, allowed: true })
      .log("PolarisPayments", "FeeChanged", { bps: 40n })
      .log("CollateralVault", "MultiplierChanged", { bps: 20_000n })
      .log("PolarisCheckout", "Paused", { account: account(0xde) });
    await sim.run();
    const grants = (await sim.indexer.ConfigChange.getAll()).filter((c) => c.subject === RELAYER && c.granted);
    expect(grants.map((c) => `${c.contract}.${c.event}`).sort()).toEqual(["BatchSettlement.SettlerSet", "MerchantRegistry.OperatorSet", "PolarisPayments.OperatorSet"]);
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ feeBps: 40, collateralMultiplierBps: 20_000, checkoutPaused: true });
  });
});
