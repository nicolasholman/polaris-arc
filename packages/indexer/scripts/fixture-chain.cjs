/**
 * The chain the indexer's replay test is recorded from: the whole Polaris
 * contract layer deployed to a local Hardhat node (packages/contracts
 * lib/deploy.js, the same code as Arc testnet, with MockUSDC and a MockUSDC
 * named EURC), then every flow a handler reads:
 *
 *   1. Underwrite:  a keeper underwriting report opens the buyer's credit line
 *   2. Pay now:     ReceiveWithAuthorization -> PolarisCheckout.pay
 *   3. Pay in 4:    PlanIntent + Permit -> PolarisCheckout.openPlan (merchant paid in full)
 *   4. Collect:     a keeper collections report collects instalment 1 when due
 *   5. Pay early:   RepayIntent -> PolarisLoanEngine.repayWithSig closes the plan
 *   6. Guard:       the owner forces the credit guard to pause Pay in 4 (openPlan refused
 *                   with CreditPausedByGuardian) while Pay now still works, then lets it
 *                   follow the pool again
 *   7. Pay in 4:    a second plan
 *   8. Re-sign:     the allowance is lost, the collection is skipped (InsufficientAllowance),
 *                   the buyer signs a fresh permit (PolarisCheckout.reauthorize), and a
 *                   report built from CollectionsReceiver.dueTasksFor collects at once
 *   9. Subscribe:   SubscribeIntent + Permit -> PolarisCheckout.subscribe
 *  10. Renew:       a keeper collections report charges period 2
 *  11. Send:        a USDC link sent and claimed, and a EURC link (PolarisSendEURC) likewise
 *  12. Default:     a second buyer locks collateral, opens a one-minute plan and cannot
 *                   pay: the collection is skipped (InsufficientBalance) beside a stale
 *                   candidate (a closed loan), then the plan is liquidated past grace
 *  13. Refused:     underwriting the same buyer twice (AlreadyHasRecord)
 *  14. Merchant:    registered by signature, an order quoted then paid at its price, two
 *                   payouts as signed transferWithAuthorization
 *  15. Cancel:      a subscription cancelled by signature; a link cancelled, one refunded
 *  16. Batch:       a batch settlement
 *
 * The keeper is played by the deployment's keeper account, which submits
 * each report itself (`submitReport(bytes)`), as services/keeper does; the
 * reports are built here by hand (no keeper, data provider or indexer runs).
 * Every buyer, sender and recipient is a fresh wallet that only signs; the
 * relayer account submits what they sign.
 *
 * Run by scripts/record-fixture.mjs through `hardhat run --network arcLocal`
 * from packages/contracts (`hre` is the global Hardhat injects). It writes the
 * deployment record to POLARIS_FIXTURE_DEPLOYMENT, never to
 * packages/contracts/deployments. Local only: it time-travels and mints.
 */

"use strict";

const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const CONTRACTS = process.env.POLARIS_CONTRACTS_DIR;
const OUT = process.env.POLARIS_FIXTURE_DEPLOYMENT;
if (!CONTRACTS || !OUT) throw new Error("Run through scripts/record-fixture.mjs (POLARIS_CONTRACTS_DIR, POLARIS_FIXTURE_DEPLOYMENT).");
const { ethers } = hre; // eslint-disable-line no-undef
const { Wallet, Signature, hexlify, randomBytes, keccak256, toUtf8Bytes, solidityPacked } = ethers;
const { deployPolaris } = require(join(CONTRACTS, "lib", "deploy.js"));
const { networkFor } = require(join(CONTRACTS, "lib", "networks.js"));
const { TYPES, readDomain } = require(join(CONTRACTS, "lib", "eip712.js"));
const keeperLib = require(join(CONTRACTS, "lib", "keeper.js"));
const tx = require(join(CONTRACTS, "lib", "tx.js"));

const { ACTION, GUARD_OVERRIDE } = keeperLib;
const USD = (n) => ethers.parseUnits(String(n), 6);
const GRACE_SECONDS = 120;

async function now() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

async function travel(seconds) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

/** The custom error a call reverted with (ethers' decoding, or Hardhat's message). */
function revertName(contract, e) {
  if (e.revert?.name) return e.revert.name;
  for (const data of [e.data, e.info?.error?.data, e.error?.data]) {
    if (typeof data !== "string" || data.length < 10) continue;
    try {
      const parsed = contract.interface.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      // not one of this contract's errors
    }
  }
  const named = /custom error '(\w+)\(/.exec(e.message ?? "");
  return named ? named[1] : e.shortMessage ?? String(e);
}

function events(receipt, contract, name) {
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === contract.target.toLowerCase())
    .map((l) => {
      try {
        return contract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.name === name);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const signers = await ethers.getSigners();
  const relayerSigner = signers[1];
  const keeperSigner = signers[2];

  const record = await deployPolaris(
    hre,
    {
      network: networkFor("local"),
      tokenMode: "mock",
      treasury: deployer.address,
      keeper: keeperSigner.address,
      relayer: relayerSigner.address,
      graceSeconds: GRACE_SECONDS,
      minInterval: 60,
      minPeriod: 60,
      demoMerchant: Wallet.createRandom(),
      poolSeed: USD(50_000),
    },
    () => {},
  );
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  const d = record;
  console.log(`  deployed (chain ${d.chainId}); record at ${OUT}`);

  const at = (name, artifact = name) => ethers.getContractAt(artifact, d.contracts[name].address);
  const token = await at("USDC", "MockUSDC");
  const eurc = await at("EURC", "MockUSDC");
  const checkout = (await at("PolarisCheckout")).connect(relayerSigner);
  const engine = (await at("PolarisLoanEngine")).connect(relayerSigner);
  const payments = await at("PolarisPayments");
  const send = (await at("PolarisSend")).connect(relayerSigner);
  const sendEurc = (await at("PolarisSendEURC", "PolarisSend")).connect(relayerSigner);
  const scores = await at("ScoreManager");
  const registry = await at("MerchantRegistry");
  const vault = await at("CollateralVault");
  const batch = await at("BatchSettlement");
  const guard = (await at("CreditGuard")).connect(deployer);
  const collections = (await at("CollectionsReceiver")).connect(keeperSigner);
  const underwriting = (await at("UnderwritingReceiver")).connect(keeperSigner);
  const merchant = d.demo.merchant;
  const tokenDomain = await readDomain(token);
  const eurcDomain = await readDomain(eurc);
  const checkoutDomain = await readDomain(checkout);

  const collect = (tasks) => tx.send(collections, "submitReport", [keeperLib.encodeCollectionsReport(tasks)]);
  const underwrite = (items) => tx.send(underwriting, "submitReport", [keeperLib.encodeUnderwritingReport(items)]);
  const facts = async (over = {}) => ({
    walletAgeDays: 730,
    txCount: 1_200,
    stableBalance: USD(2_500),
    defiTenureDays: 400,
    priorLiquidations: 0,
    relatedWallets: 1,
    exchangeFunded: true,
    observedAt: await now(),
    ...over,
  });
  const signPermit = async (signer, spender, value, deadline, domain = tokenDomain, t = token) =>
    Signature.from(
      await signer.signTypedData(domain, { Permit: TYPES.Stablecoin.Permit }, {
        owner: signer.address,
        spender,
        value,
        nonce: await t.nonces(signer.address),
        deadline,
      }),
    );
  const planIntent = async (buyer, principal, interval, orderId) => {
    const t = await now();
    return {
      buyer: buyer.address,
      merchant,
      principal,
      installments: 4,
      interval,
      orderId,
      nonce: await checkout.nonces(buyer.address),
      deadline: t + 600n,
    };
  };
  const openPlan = async (buyer, principal, interval, orderId) => {
    const quote = await checkout.quotePlan(buyer.address, principal, 4, interval);
    const t = await now();
    const permit = await signPermit(buyer, engine.target, quote.permitValue, t + 1800n);
    const intent = await planIntent(buyer, principal, interval, orderId);
    const sig = await buyer.signTypedData(checkoutDomain, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent);
    const receipt = await tx.send(checkout, "openPlan", [intent, sig, { value: quote.permitValue, deadline: t + 1800n, v: permit.v, r: permit.r, s: permit.s }]);
    return events(receipt, checkout, "PlanOpened")[0].args.loanId;
  };
  const payNow = async (buyer, payee, amount, orderId) => {
    const t = await now();
    const auth = Signature.from(
      await buyer.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
        from: buyer.address,
        to: payments.target,
        value: amount,
        validAfter: 0,
        validBefore: t + 1800n,
        nonce: await checkout.orderKeyOf(payee, orderId),
      }),
    );
    return tx.send(checkout, "pay", [buyer.address, payee, amount, orderId, 0, t + 1800n, auth.v, auth.r, auth.s]);
  };

  // Fresh, gasless people.
  const buyer = Wallet.createRandom().connect(ethers.provider);
  const history = Wallet.createRandom();
  const studio = Wallet.createRandom().connect(ethers.provider);
  const freelancer = Wallet.createRandom().connect(ethers.provider);
  await tx.send(token.connect(deployer), "mint", [buyer.address, USD(1_000)]);
  await tx.send(token.connect(deployer), "mint", [studio.address, USD(500)]);
  await tx.send(eurc.connect(deployer), "mint", [studio.address, USD(200)]);

  // 1. Underwrite
  const uw = await underwrite([{ user: buyer.address, linkedWallet: history.address, facts: await facts() }]);
  if (events(uw, underwriting, "UnderwritingApplied").length !== 1) throw new Error("underwriting was refused");
  console.log(`  1. buyer underwritten, credit line ${await scores.creditLimitOf(buyer.address)}`);

  // 2. Pay now
  await payNow(buyer, merchant, USD(25), `order-now-${hexlify(randomBytes(6))}`);
  console.log("  2. paid now");

  // 3. Pay in 4, weekly
  const WEEK = 7n * 24n * 3600n;
  const loan1 = await openPlan(buyer, USD(200), WEEK, `order-plan-${hexlify(randomBytes(6))}`);
  console.log(`  3. loan #${loan1} opened`);

  // 4. The keeper collects instalment 1 when due
  await travel(WEEK + 1n);
  const due = [{ action: ACTION.COLLECT_INSTALLMENT, id: loan1 }];
  if (!(await collections.checkTasks(due))[0]) throw new Error("instalment not due");
  const col = await collect(due);
  if (events(col, collections, "TaskExecuted").length !== 1) throw new Error("the collection did not execute");
  console.log("  4. instalment 1 collected");

  // 5. Pay the rest early
  const loan = await engine.getLoan(loan1);
  const outstanding = await engine.outstandingOf(loan1);
  let t = await now();
  const repay = { loanId: loan1, amount: outstanding, expectedRepaid: loan.totalRepaid, nonce: await engine.nonces(buyer.address), deadline: t + 600n };
  const repaySig = await buyer.signTypedData(await readDomain(engine), { RepayIntent: TYPES.PolarisLoanEngine.RepayIntent }, repay);
  const repaid = await tx.send(engine, "repayWithSig", [loan1, outstanding, loan.totalRepaid, repay.deadline, repaySig]);
  if (events(repaid, engine, "LoanFullyRepaid").length !== 1) throw new Error("the plan did not close");
  console.log("  5. plan paid off early");

  // 6. The credit guard: forced pause, then back to the pool's own verdict
  await tx.send(guard, "setOverride", [GUARD_OVERRIDE.FORCE_PAUSE, 0]);
  {
    const quote = await checkout.quotePlan(buyer.address, USD(100), 4, WEEK);
    t = await now();
    const permit = await signPermit(buyer, engine.target, quote.permitValue, t + 1800n);
    const intent = await planIntent(buyer, USD(100), WEEK, `order-paused-${hexlify(randomBytes(6))}`);
    const sig = await buyer.signTypedData(checkoutDomain, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent);
    const refused = await checkout.openPlan
      .staticCall(intent, sig, { value: quote.permitValue, deadline: t + 1800n, v: permit.v, r: permit.r, s: permit.s })
      .then(() => "accepted", (e) => revertName(checkout, e));
    if (refused !== "CreditPausedByGuardian") throw new Error(`Pay in 4 was not paused: ${refused}`);
  }
  await payNow(buyer, merchant, USD(5), `order-now-paused-${hexlify(randomBytes(6))}`);
  await tx.send(guard, "setOverride", [GUARD_OVERRIDE.NONE, 0]);
  if ((await checkout.creditPaused())[0]) throw new Error("credit did not resume");
  console.log("  6. credit guard forced a pause (Pay now still worked), then resumed");

  // 7. A second plan
  const loan2 = await openPlan(buyer, USD(100), WEEK, `order-plan2-${hexlify(randomBytes(6))}`);
  console.log(`  7. loan #${loan2} opened`);

  // 8. Lost allowance, re-signed, collected at once
  t = await now();
  const revoke = await signPermit(buyer, engine.target, 0n, t + 600n);
  await tx.send(token.connect(relayerSigner), "permit", [buyer.address, engine.target, 0n, t + 600n, revoke.v, revoke.r, revoke.s]);
  await travel(WEEK + 1n);
  const skipped = await collect([{ action: ACTION.COLLECT_INSTALLMENT, id: loan2 }]);
  const [skip] = events(skipped, collections, "TaskSkipped");
  const skipReason = skip ? engine.interface.parseError(skip.args.reason)?.name : "none";
  if (skipReason !== "InsufficientAllowance") throw new Error(`expected InsufficientAllowance, got ${skipReason}`);
  const owed = await engine.activeDebtOf(buyer.address);
  t = await now();
  const fresh = await signPermit(buyer, engine.target, owed, t + 1800n);
  const reauth = await tx.send(checkout, "reauthorize", [buyer.address, { value: owed, deadline: t + 1800n, v: fresh.v, r: fresh.r, s: fresh.s }]);
  const [reauthorized] = events(reauth, checkout, "Reauthorized");
  const dueNow = (await collections.dueTasksFor(reauthorized.args.buyer)).map((task) => ({ action: Number(task.action), id: task.id }));
  if (dueNow.length !== 1 || dueNow[0].id !== loan2) throw new Error("dueTasksFor did not return the plan");
  if (events(await collect(dueNow), collections, "TaskExecuted").length !== 1) throw new Error("the retry did not collect");
  console.log(`  8. loan #${loan2}: skipped for the allowance, re-signed, collected`);

  // 9. Subscribe (the one-minute plan)
  const fastPlan = d.demo.subscriptionPlans[1];
  const price = BigInt(fastPlan.pricePerPeriod);
  const subscribe = async (subscriber, planInfo, orderId) => {
    const p = BigInt(planInfo.pricePerPeriod);
    const s = await now();
    const permit = await signPermit(subscriber, payments.target, p * 12n, s + 1800n);
    const intent = {
      buyer: subscriber.address,
      merchant,
      planId: BigInt(planInfo.planId),
      pricePerPeriod: p,
      periodSeconds: BigInt(planInfo.periodSeconds),
      orderId,
      nonce: await checkout.nonces(subscriber.address),
      deadline: s + 600n,
    };
    const sig = await subscriber.signTypedData(checkoutDomain, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent);
    const receipt = await tx.send(checkout, "subscribe", [intent, sig, { value: p * 12n, deadline: s + 1800n, v: permit.v, r: permit.r, s: permit.s }]);
    return events(receipt, checkout, "SubscriptionStarted")[0].args.subId;
  };
  const subId = await subscribe(buyer, fastPlan, `order-sub-${hexlify(randomBytes(6))}`);
  console.log(`  9. subscription #${subId} started`);

  // 10. The keeper charges period 2
  await travel(BigInt(fastPlan.periodSeconds) + 1n);
  const renewal = [{ action: ACTION.CHARGE_SUBSCRIPTION, id: subId }];
  if (!(await collections.checkTasks(renewal))[0]) throw new Error("subscription not due");
  await collect(renewal);
  console.log(`  10. period 2 charged (${price} base units)`);

  // 11. Send by link: USDC, and EURC
  const sendLink = async (contract, domain, from, amount, lifetime) => {
    const key = Wallet.createRandom();
    const s = await now();
    const expiresAt = s + lifetime;
    const auth = Signature.from(
      await from.signTypedData(domain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
        from: from.address,
        to: contract.target,
        value: amount,
        validAfter: 0,
        validBefore: s + 1800n,
        nonce: await contract.sendNonce(key.address, expiresAt),
      }),
    );
    const linkDomain = await readDomain(contract);
    const open = Signature.from(await key.signTypedData(linkDomain, { Open: TYPES.PolarisSend.Open }, { sender: from.address, amount, expiresAt }));
    await tx.send(contract, "send", [from.address, key.address, amount, expiresAt, 0, s + 1800n, auth.v, auth.r, auth.s, open.v, open.r, open.s]);
    return { key, linkDomain };
  };
  const claimLink = async (contract, link, to) => {
    const s = await now();
    const c = Signature.from(await link.key.signTypedData(link.linkDomain, { Claim: TYPES.PolarisSend.Claim }, { to, deadline: s + 600n }));
    await tx.send(contract, "claim", [link.key.address, to, s + 600n, c.v, c.r, c.s]);
  };
  const usdLink = await sendLink(send, tokenDomain, studio, USD(50), 7n * 24n * 3600n);
  await claimLink(send, usdLink, freelancer.address);
  const eurLink = await sendLink(sendEurc, eurcDomain, studio, USD(40), 7n * 24n * 3600n);
  await claimLink(sendEurc, eurLink, freelancer.address);
  console.log("  11. a USDC link and a EURC link sent and claimed");

  // 12. A buyer who cannot pay
  const buyer2 = Wallet.createRandom().connect(ethers.provider);
  await underwrite([{ user: buyer2.address, linkedWallet: ethers.ZeroAddress, facts: await facts({ walletAgeDays: 400, txCount: 300, stableBalance: USD(800), defiTenureDays: 120, relatedWallets: 0, exchangeFunded: false }) }]);
  // Collateral: the only transactions a user sends here, and only locally.
  await deployer.sendTransaction({ to: buyer2.address, value: ethers.parseEther("1") });
  await tx.send(token.connect(deployer), "mint", [buyer2.address, USD(20)]);
  await tx.send(token.connect(buyer2), "approve", [vault.target, USD(20)]);
  await tx.send(vault.connect(buyer2), "lock", [USD(20)]);
  const loan3 = await openPlan(buyer2, USD(100), 60n, `order-plan3-${hexlify(randomBytes(4))}`);
  await travel(61n);
  // The candidate list proposes loan #1 too (closed above): stale.
  await collect([
    { action: ACTION.COLLECT_INSTALLMENT, id: loan3 },
    { action: ACTION.COLLECT_INSTALLMENT, id: loan1 },
  ]);
  await travel(BigInt(GRACE_SECONDS) + 1n);
  if (!(await collections.checkTasks([{ action: ACTION.LIQUIDATE, id: loan3 }]))[0]) throw new Error("not liquidatable");
  await collect([{ action: ACTION.LIQUIDATE, id: loan3 }]);
  console.log(`  12. loan #${loan3}: collection skipped (short), loan #${loan1} stale, then liquidated`);

  // 13. Underwriting the same buyer twice is refused
  const again = await underwrite([{ user: buyer2.address, linkedWallet: ethers.ZeroAddress, facts: await facts() }]);
  if (events(again, underwriting, "UnderwritingRefused").length !== 1) throw new Error("the second underwriting was not refused");
  console.log("  13. a second underwriting refused");

  // 14. A merchant who takes payments and withdraws
  const kiosk = Wallet.createRandom();
  const kioskPayout = Wallet.createRandom().address;
  const exchange = Wallet.createRandom().address;
  t = await now();
  const reg = { merchant: kiosk.address, name: "Kiosk Norte", payoutAddress: kioskPayout, metadataURI: "", nonce: await registry.nonces(kiosk.address), deadline: t + 600n };
  const regSig = await kiosk.signTypedData(await readDomain(registry), { Registration: TYPES.MerchantRegistry.Registration }, reg);
  await tx.send(registry.connect(deployer), "registerFor", [kiosk.address, reg.name, reg.payoutAddress, reg.metadataURI, reg.deadline, regSig]);
  const buyer3 = Wallet.createRandom().connect(ethers.provider);
  await tx.send(token.connect(deployer), "mint", [buyer3.address, USD(100)]);
  const orderId = `order-quoted-${hexlify(randomBytes(4))}`;
  const orderKey = keccak256(solidityPacked(["address", "string"], [kiosk.address, orderId]));
  await tx.send(payments.connect(deployer), "quoteOrder", [kiosk.address, orderKey, USD(30)]);
  await payNow(buyer3, kiosk.address, USD(30), orderId);
  const withdraw = async (to, value) => {
    const s = await now();
    const nonce = hexlify(randomBytes(32));
    const sig = Signature.from(
      await kiosk.signTypedData(tokenDomain, { TransferWithAuthorization: TYPES.Stablecoin.TransferWithAuthorization }, {
        from: kiosk.address,
        to,
        value,
        validAfter: 0,
        validBefore: s + 1800n,
        nonce,
      }),
    );
    await tx.send(token.connect(relayerSigner), "transferWithAuthorization", [kiosk.address, to, value, 0, s + 1800n, nonce, sig.v, sig.r, sig.s]);
  };
  await withdraw(exchange, USD(10));
  await withdraw(kioskPayout, USD(5));
  console.log("  14. a merchant registered by signature, a quoted order paid, two gasless payouts");

  // 15. A subscription cancelled by signature; a link cancelled, one refunded
  const sub3 = await subscribe(buyer3, d.demo.subscriptionPlans[0], `order-sub3-${hexlify(randomBytes(4))}`);
  t = await now();
  const cancel = Signature.from(
    await buyer3.signTypedData(await readDomain(payments), { CancelSubscription: TYPES.PolarisPayments.CancelSubscription }, { subId: sub3, deadline: t + 600n }),
  );
  await tx.send(payments.connect(relayerSigner), "cancelWithSignature", [sub3, t + 600n, cancel.v, cancel.r, cancel.s]);
  const sender = Wallet.createRandom();
  await tx.send(token.connect(deployer), "mint", [sender.address, USD(20)]);
  const cancelled = await sendLink(send, tokenDomain, sender, USD(5), 3600n);
  t = await now();
  const c = Signature.from(await sender.signTypedData(cancelled.linkDomain, { Cancel: TYPES.PolarisSend.Cancel }, { linkKey: cancelled.key.address, deadline: t + 600n }));
  await tx.send(send, "cancel", [cancelled.key.address, t + 600n, c.v, c.r, c.s]);
  const expiring = await sendLink(send, tokenDomain, sender, USD(6), 301n);
  await travel(302n);
  await tx.send(send, "refund", [expiring.key.address]);
  console.log(`  15. subscription #${sub3} cancelled by signature; a link cancelled, one refunded`);

  // 16. A batch settlement
  await tx.send(batch.connect(deployer), "setSettler", [deployer.address, true]);
  await tx.send(token.connect(deployer), "approve", [batch.target, USD(50)]);
  await tx.send(batch.connect(deployer), "fund", [USD(50)]);
  await tx.send(batch.connect(deployer), "settleBatch", [
    hexlify(randomBytes(32)),
    [kiosk.address, exchange],
    [USD(20), USD(30)],
    [keccak256(toUtf8Bytes("invoice-1")), keccak256(toUtf8Bytes("invoice-2"))],
  ]);
  console.log("  16. batch of two settled");

  // Every user only signed.
  for (const w of [buyer, studio, freelancer, buyer3]) {
    if ((await ethers.provider.getTransactionCount(w.address)) !== 0) throw new Error(`${w.address} sent a transaction`);
  }
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
