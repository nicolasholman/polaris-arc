/**
 * Everything around the money: send-by-link, merchant payouts and balances,
 * batch settlements, the buyer's credit line, the keeper's reports and the
 * credit guard (simulated events), and roles.
 */

import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { A, account, KEEPER, RELAYER, Sim, USD } from "./sim.js";

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
    expect(await sim.indexer.Send.getOrThrow(k1)).toMatchObject({ currency: "USD" });
  });

  it("keeps euro links (PolarisSendEURC) apart from dollar links", async () => {
    const sim = new Sim();
    const [usd, eur] = [account(0xb1), account(0xb2)];
    sim.tx({ from: RELAYER, to: A.PolarisSend }).log("PolarisSend", "Sent", { linkKey: usd, sender: buyer, amount: USD(10), expiresAt: BigInt(sim.time + 86_400) });
    sim
      .tx({ from: RELAYER, to: A.PolarisSendEURC })
      .log("PolarisSendEURC", "Sent", { linkKey: eur, sender: buyer, amount: USD(25), expiresAt: BigInt(sim.time + 86_400) }, A.PolarisSendEURC);
    sim.tx({ from: RELAYER, to: A.PolarisSendEURC }).log("PolarisSendEURC", "Claimed", { linkKey: eur, to: account(0x999), amount: USD(25) }, A.PolarisSendEURC);
    await sim.run();

    expect(await sim.indexer.Send.getOrThrow(eur)).toMatchObject({ currency: "EUR", status: "CLAIMED", amount: USD(25), recipient: account(0x999) });
    expect(await sim.indexer.Send.getOrThrow(usd)).toMatchObject({ currency: "USD", status: "OPEN" });
    expect(await sim.indexer.Buyer.getOrThrow(buyer)).toMatchObject({ sentCount: 1, sentVolume: USD(10), eurcSentCount: 1, eurcSentVolume: USD(25) });
    expect(await sim.indexer.Buyer.getOrThrow(account(0x999))).toMatchObject({ claimedCount: 0, eurcClaimedCount: 1, eurcClaimedVolume: USD(25) });
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({
      sendCount: 1,
      sendVolume: USD(10),
      claimCount: 0,
      eurcSendCount: 1,
      eurcSendVolume: USD(25),
      eurcClaimCount: 1,
      eurcClaimVolume: USD(25),
    });
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

  it("counts a payout only when money leaves through USDC itself", async () => {
    const sim = new Sim();
    register(sim);
    // Paid by a buyer through the checkout.
    sim.tx({ from: RELAYER, to: A.PolarisCheckout }).transfer(A.PolarisPayments, merchant, USD(100));
    // One-tap withdraw: the relayer submits the merchant's transferWithAuthorization.
    sim.tx({ from: RELAYER, to: A.USDC }).transfer(merchant, exchange, USD(30));
    // Automatic payout to the registered payout address.
    sim.tx({ from: RELAYER, to: A.USDC }).transfer(merchant, payoutAddress, USD(20));
    // EURC moving out of the same account is not a USDC payout.
    sim.tx({ from: RELAYER, to: A.EURC }).transfer(merchant, exchange, USD(3), A.EURC);
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
      .tx({ from: KEEPER, to: A.UnderwritingReceiver })
      .log("ScoreManager", "Underwritten", { user: buyer, score: 695n, declined: false, observedAt: BigInt(sim.time - 30) })
      .log("ScoreManager", "ScoreChanged", { user: buyer, oldScore: 600n, newScore: 695n, reason: "underwritten" })
      .log("UnderwritingReceiver", "UnderwritingApplied", { user: buyer, linkedWallet: history, score: 695n }, A.UnderwritingReceiver);
    await sim.run();

    let b = await sim.indexer.Buyer.getOrThrow(buyer);
    expect(b).toMatchObject({ underwritten: true, hasRecord: true, score: 695, baseLimit: USD(1_000), creditLimit: USD(1_000), available: USD(1_000), linkedWallet: history });
    expect(await sim.indexer.LinkedWallet.getOrThrow(history)).toMatchObject({ buyer_id: buyer });
    const [uw] = await sim.indexer.Underwriting.getAll();
    expect(uw).toMatchObject({ applied: true, score: 695, declined: false, linkedWallet: history, observedAt: sim.time - 30 });
    const [report] = await sim.indexer.KeeperReport.getAll();
    expect(report).toMatchObject({ kind: "underwriting", receiver: A.UnderwritingReceiver, keeper: KEEPER, items: 1 });

    // $100 of collateral adds $150.
    sim.tx({ from: RELAYER, to: A.CollateralVault }).log("CollateralVault", "CollateralLocked", { user: buyer, amount: USD(100), newTotal: USD(100) });
    // An on-time instalment moves the score; the day's candle follows it.
    sim.tx({ from: KEEPER }).log("ScoreManager", "ScoreChanged", { user: buyer, oldScore: 695n, newScore: 707n, reason: "on-time payment" });
    await sim.run();
    b = await sim.indexer.Buyer.getOrThrow(buyer);
    expect(b).toMatchObject({ collateral: USD(100), creditLimit: USD(1_150), score: 707 });
    const [day] = await sim.indexer.BuyerDay.getAll();
    expect(day).toMatchObject({ scoreOpen: 600, scoreHigh: 707, scoreLow: 600, scoreClose: 707 });
    const reasons = (await sim.indexer.ScoreEvent.getAll()).map((e) => e.reason).sort();
    expect(reasons).toEqual(["on-time payment", "underwritten"]);

    // A stale report is refused, and the app can say why.
    sim
      .tx({ from: KEEPER, to: A.UnderwritingReceiver })
      .log("UnderwritingReceiver", "UnderwritingRefused", { user: buyer, linkedWallet: history, reason: encodeErrorResult({ abi: errors, errorName: "StaleEvidence" }) }, A.UnderwritingReceiver);
    await sim.run();
    expect((await sim.indexer.Buyer.getOrThrow(buyer)).lastUnderwritingRefusal).toBe("StaleEvidence");
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ keeperReports: 2, underwritings: 1 });
  });
});

describe("the keeper's reports, the credit guard and roles", () => {
  it("counts one report per keeper transaction, with every item in it", async () => {
    const sim = new Sim();
    const [u1, u2] = [account(0x301), account(0x302)];
    const errors = parseAbi(["error AlreadyHasRecord()"]);
    sim
      .tx({ from: KEEPER, to: A.UnderwritingReceiver })
      .log("UnderwritingReceiver", "UnderwritingApplied", { user: u1, linkedWallet: account(0), score: 640n }, A.UnderwritingReceiver)
      .log("UnderwritingReceiver", "UnderwritingRefused", { user: u2, linkedWallet: account(0), reason: encodeErrorResult({ abi: errors, errorName: "AlreadyHasRecord" }) }, A.UnderwritingReceiver);
    sim.tx({ from: KEEPER, to: A.CollectionsReceiver }).log("CollectionsReceiver", "CollectionsRun", { tasks: 0n, executed: 0n, skipped: 0n }, A.CollectionsReceiver);
    await sim.run();
    const reports = (await sim.indexer.KeeperReport.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    expect(reports.map((r) => [r.kind, r.items, r.keeper, r.receiver])).toEqual([
      ["underwriting", 2, KEEPER, A.UnderwritingReceiver],
      ["collections", 0, KEEPER, A.CollectionsReceiver],
    ]);
    expect(await sim.indexer.Protocol.getOrThrow("polaris")).toMatchObject({ keeperReports: 2, underwritings: 1, collectionsRuns: 1 });
    expect((await sim.indexer.ProtocolDay.getAll())[0]).toMatchObject({ keeperReports: 2 });
  });

  it("records a new keeper key on either receiver", async () => {
    const sim = new Sim();
    const next = account(0xc2f);
    sim
      .tx({ from: account(0xde) })
      .log("CollectionsReceiver", "KeeperSet", { previousKeeper: KEEPER, keeper: next }, A.CollectionsReceiver)
      .log("UnderwritingReceiver", "KeeperSet", { previousKeeper: KEEPER, keeper: next }, A.UnderwritingReceiver);
    await sim.run();
    const changes = (await sim.indexer.ConfigChange.getAll()).filter((c) => c.event === "KeeperSet");
    expect(changes.map((c) => [c.contract, c.subject, c.value]).sort()).toEqual([
      ["CollectionsReceiver", next, KEEPER],
      ["UnderwritingReceiver", next, KEEPER],
    ]);
  });

  it("mirrors the credit guard's thresholds, override and acknowledged bad debt", async () => {
    const sim = new Sim();
    sim
      .tx({ from: account(0xde), to: A.CreditGuard })
      .log("CreditGuard", "ThresholdsSet", { thresholds: [USD(1_000), 500n, USD(10_000)] }, A.CreditGuard);
    await sim.run();
    expect(await sim.indexer.CreditGuard.getOrThrow("credit-guard")).toMatchObject({
      address: A.CreditGuard,
      minFreeCash: USD(1_000),
      maxBadDebtBps: 500,
      minOriginated: USD(10_000),
      overrideMode: "NONE",
      badDebtAcknowledged: 0n,
    });

    const until = sim.time + 3_600;
    sim.tx({ from: account(0xde), to: A.CreditGuard }).log("CreditGuard", "CreditGuardOverridden", { mode: 1n, until: BigInt(until) }, A.CreditGuard);
    sim.tx({ from: account(0xde), to: A.CreditGuard }).log("CreditGuard", "BadDebtAcknowledged", { badDebt: USD(42) }, A.CreditGuard);
    await sim.run();
    expect(await sim.indexer.CreditGuard.getOrThrow("credit-guard")).toMatchObject({ overrideMode: "FORCE_RESUME", overrideUntil: until, badDebtAcknowledged: USD(42) });

    sim.tx({ from: account(0xde), to: A.CreditGuard }).log("CreditGuard", "CreditGuardOverridden", { mode: 0n, until: 0n }, A.CreditGuard);
    await sim.run();
    const guard = await sim.indexer.CreditGuard.getOrThrow("credit-guard");
    expect(guard.overrideMode).toBe("NONE");
    expect(guard.overrideUntil).toBeUndefined();
    const events = (await sim.indexer.ConfigChange.getAll()).filter((c) => c.contract === "CreditGuard").map((c) => c.event);
    expect(events.sort()).toEqual(["BadDebtAcknowledged", "CreditGuardOverridden", "CreditGuardOverridden", "ThresholdsSet"]);
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
