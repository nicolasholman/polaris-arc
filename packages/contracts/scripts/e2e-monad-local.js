/**
 * End to end on a local node, against deployments/monad-local.json:
 *
 *   pnpm --filter @polarispay/contracts e2e:local     # starts a node on :8600, deploys, runs this
 *
 * Every buyer, sender and recipient here is a fresh wallet that never holds
 * MON. Everything they do is a signature; a relayer account submits it, as the
 * Privy server wallet does on testnet. The Chainlink DON is played by a
 * signer that delivers reports through the MockKeystoneForwarder, as
 * `cre workflow simulate --broadcast` does through Chainlink's.
 *
 * No CRE workflow, DON or data provider (Nansen included) runs here. The
 * reports are built by this script: the underwriting facts are literals, the
 * collection actions are chosen by hand, and the guardian's price comes from a
 * local stand-in feed (MockPriceFeed), not Chainlink's AUSD/USD, so what this
 * proves is the receivers and contracts, not the workflows. For the workflows, cite
 * workflows' own e2e:local (the real handlers against this same stack) or
 * `cre workflow simulate` output.
 *
 *   1. Underwrite: a hand-built underwriting report (mock forwarder) opens the buyer's credit line
 *   2. Pay now:    ReceiveWithAuthorization -> PolarisCheckout.pay
 *   3. Pay in 4:   PlanIntent + Permit -> PolarisCheckout.openPlan (merchant paid in full)
 *   4. Collect:    a hand-built collections report (mock forwarder) collects instalment 1 when due
 *   5. Pay early:  RepayIntent -> PolarisLoanEngine.repayWithSig closes the plan
 *   6. Guard:      hand-built guardian attestations (mock forwarder) from the local stand-in
 *                  AUSD/USD feed and the pool: healthy, then a depeg pauses Pay in 4
 *                  (openPlan refused with CreditPausedByGuardian(1)) while Pay now still
 *                  works, then a healthy one resumes it
 *   7. Pay in 4:   a second plan opens once credit resumed
 *   8. Re-sign:    the buyer's allowance is lost, collection is skipped (InsufficientAllowance),
 *                  the buyer signs a fresh permit -> PolarisCheckout.reauthorize emits
 *                  Reauthorized, and a report built from CollectionsReceiver.dueTasksFor(buyer)
 *                  collects the instalment (what the collections workflow's log trigger does)
 *   9. Subscribe:  SubscribeIntent + Permit -> PolarisCheckout.subscribe
 *  10. Renew:      a hand-built collections report (mock forwarder) charges period 2
 *  11. Send:       ReceiveWithAuthorization + link-key Open -> PolarisSend.send
 *  12. Claim:      link-key Claim -> PolarisSend.claim to a fresh wallet
 *
 * It prints each transaction's gas used against the estimated limit it was
 * sent with, the balances that moved, and checks that no user spent any MON.
 *
 * The plan runs on weekly instalments by default, the terms the pitch quotes
 * ($200 as 4 x $50.38, $1.53 interest), with the clock moved forward a week;
 * E2E_INTERVAL_SECONDS=60 runs it on the demo deployment's one-minute
 * schedule instead.
 */

"use strict";

const hre = require("hardhat");
const { ethers } = hre;
const { Wallet, Signature, hexlify, randomBytes, formatUnits } = require("ethers");

const d = require("../deployments/monad-local.json");
const { TYPES, readDomain } = require("../lib/eip712");
const cre = require("../lib/cre");
const tx = require("../lib/tx");

const USD = (n) => ethers.parseUnits(String(n), 6);
const $ = (v) => `$${Number(formatUnits(v, 6)).toFixed(2)}`;

const rows = [];

async function now() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

async function travel(seconds) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

/**
 * The custom error a call reverted with. ethers decodes it when the node
 * returns the revert data; a Hardhat node over JSON-RPC instead names the error
 * in its message, so both are read.
 */
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
    .map((l) => contract.interface.parseLog(l))
    .filter((e) => e && e.name === name);
}

async function record(step, what, receipt) {
  const sent = await ethers.provider.getTransaction(receipt.hash);
  rows.push({ step, what, gasUsed: receipt.gasUsed, gasLimit: sent.gasLimit, tx: receipt.hash });
  console.log(`  ${step}. ${what}  (gas ${receipt.gasUsed} of ${sent.gasLimit})`);
}

/** Sign an AUSD permit to `spender`, as the buyer's app does. */
async function signPermit(token, owner, spender, value, deadline) {
  return Signature.from(
    await owner.signTypedData(await readDomain(token), { Permit: TYPES.Stablecoin.Permit }, {
      owner: owner.address,
      spender,
      value,
      nonce: await token.nonces(owner.address),
      deadline,
    })
  );
}

async function main() {
  if (d.chainId === 10143) throw new Error("This run time-travels; it is for a local node only.");
  const [cre_don, relayer] = await ethers.getSigners(); // account 0 deployed and is the simulation transmitter
  const at = (name) => ethers.getContractAt(name, d.contracts[name].address);

  const token = await ethers.getContractAt("MockAUSD", d.contracts.Stablecoin.address);
  const checkout = (await at("PolarisCheckout")).connect(relayer);
  const engine = (await at("PolarisLoanEngine")).connect(relayer);
  const payments = await at("PolarisPayments");
  const send = (await at("PolarisSend")).connect(relayer);
  const scores = await at("ScoreManager");
  const collections = await at("CollectionsReceiver");
  const underwriting = await at("UnderwritingReceiver");
  const guardian = await at("GuardianReceiver");
  const feed = (await ethers.getContractAt("MockPriceFeed", d.contracts.MockAusdUsdFeed.address)).connect(cre_don);
  const forwarder = (await at("MockKeystoneForwarder")).connect(cre_don);
  const merchant = d.demo.merchant;

  const tokenDomain = await readDomain(token);
  const checkoutDomain = await readDomain(checkout);

  // Fresh, gasless people.
  const buyer = Wallet.createRandom().connect(ethers.provider);
  const history = Wallet.createRandom(); // the wallet the buyer "brings" for their history
  const studio = Wallet.createRandom().connect(ethers.provider);
  const freelancer = Wallet.createRandom().connect(ethers.provider);
  await tx.send(token.connect(cre_don), "mint", [buyer.address, USD(1_000)]);
  await tx.send(token.connect(cre_don), "mint", [studio.address, USD(500)]);

  console.log(`Polaris end to end on chain ${d.chainId}`);
  console.log(`  buyer      ${buyer.address}`);
  console.log(`  merchant   ${merchant} (${d.demo.merchantName})`);
  console.log(`  relayer    ${relayer.address}`);
  console.log(`  CRE (sim)  ${cre_don.address} via MockKeystoneForwarder ${forwarder.target}\n`);

  const report = async (receiver, body, workflowName) => {
    const raw = cre.encodeRawReport({
      body,
      workflowName,
      workflowOwner: cre_don.address,
      executionId: hexlify(randomBytes(32)),
      timestamp: Number(await now()),
    });
    const receipt = await tx.send(forwarder, "report", [receiver, raw, "0x", []]);
    const [processed] = events(receipt, forwarder, "ReportProcessed");
    if (!processed.args.result) throw new Error(`receiver refused the report: ${await forwarder.lastRevertData()}`);
    return receipt;
  };

  // 1. Underwrite ------------------------------------------------------
  console.log("Credit line (mock forwarder report, hand-built facts; no CRE workflow or Nansen)");
  const facts = {
    walletAgeDays: 730,
    txCount: 1_200,
    stableBalance: USD(2_500),
    defiTenureDays: 400,
    priorLiquidations: 0,
    relatedWallets: 1,
    exchangeFunded: true,
    observedAt: await now(),
  };
  const uwReceipt = await report(
    underwriting.target,
    cre.encodeUnderwritingReport([{ user: buyer.address, linkedWallet: history.address, facts }]),
    cre.WORKFLOW_NAMES.UNDERWRITING
  );
  await record(1, "mock forwarder report (hand-built facts) -> ScoreManager.underwrite", uwReceipt);
  const [applied] = events(uwReceipt, underwriting, "UnderwritingApplied");
  if (!applied) throw new Error("underwriting was refused");
  const limit = await scores.creditLimitOf(buyer.address);
  console.log(`     score ${applied.args.score}, credit line ${$(limit)}\n`);

  // 2. Pay now ---------------------------------------------------------
  console.log("Pay now");
  const payOrder = `order-now-${hexlify(randomBytes(6))}`;
  const payAmount = USD(25);
  let t = await now();
  const payAuth = Signature.from(
    await buyer.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
      from: buyer.address,
      to: payments.target,
      value: payAmount,
      validAfter: 0,
      validBefore: t + 1800n,
      nonce: await checkout.orderKeyOf(merchant, payOrder),
    })
  );
  const merchantBefore = await token.balanceOf(merchant);
  const payReceipt = await tx.send(checkout, "pay", [
    buyer.address, merchant, payAmount, payOrder, 0, t + 1800n, payAuth.v, payAuth.r, payAuth.s,
  ]);
  await record(2, `PolarisCheckout.pay ${$(payAmount)}`, payReceipt);
  console.log(`     merchant +${$((await token.balanceOf(merchant)) - merchantBefore)} (0.5% fee to treasury)\n`);

  // 3. Pay in 4 --------------------------------------------------------
  console.log("Pay in 4");
  const principal = USD(200);
  const interval = BigInt(process.env.E2E_INTERVAL_SECONDS || 7 * 24 * 3600);
  const quote = await checkout.quotePlan(buyer.address, principal, 4, interval);
  t = await now();
  const permit = Signature.from(
    await buyer.signTypedData(tokenDomain, { Permit: TYPES.Stablecoin.Permit }, {
      owner: buyer.address,
      spender: engine.target,
      value: quote.permitValue,
      nonce: await token.nonces(buyer.address),
      deadline: t + 1800n,
    })
  );
  const planOrder = `order-plan-${hexlify(randomBytes(6))}`;
  const intent = {
    buyer: buyer.address,
    merchant,
    principal,
    installments: 4,
    interval,
    orderId: planOrder,
    nonce: await checkout.nonces(buyer.address),
    deadline: t + 600n,
  };
  const intentSig = await buyer.signTypedData(checkoutDomain, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent);
  // The buyer first signed Pay now for this same order (a relay that timed
  // out, say) and then chose Pay in 4. That authorization stays signed.
  const leftover = Signature.from(
    await buyer.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
      from: buyer.address,
      to: payments.target,
      value: principal,
      validAfter: 0,
      validBefore: t + 1800n,
      nonce: await checkout.orderKeyOf(merchant, planOrder),
    })
  );
  const beforePlan = await token.balanceOf(merchant);
  const planReceipt = await tx.send(checkout, "openPlan", [
    intent,
    intentSig,
    { value: quote.permitValue, deadline: t + 1800n, v: permit.v, r: permit.r, s: permit.s },
  ]);
  await record(3, `PolarisCheckout.openPlan ${$(principal)} in 4`, planReceipt);
  const [opened] = events(planReceipt, checkout, "PlanOpened");
  const loanId = opened.args.loanId;
  const refused = await payments
    .connect(relayer)
    .payWithAuthorization.staticCall(buyer.address, merchant, principal, planOrder, 0, t + 1800n, leftover.v, leftover.r, leftover.s)
    .then(() => "accepted", (e) => revertName(payments, e));
  if (refused !== "OrderAlreadySettled") {
    throw new Error(`a Pay now authorization for the plan's order could still charge the buyer: ${refused}`);
  }
  console.log("     the Pay now authorization signed for the same order is refused: OrderAlreadySettled");
  console.log(
    `     loan #${loanId}: merchant +${$((await token.balanceOf(merchant)) - beforePlan)} now, ` +
      `buyer owes 4 x ${$(quote.installmentAmount)} (${$(quote.interest)} interest), first due in ${interval}s\n`
  );

  // 4. A collections report collects instalment 1 ----------------------
  console.log("Collections (mock forwarder report, hand-built)");
  await travel(interval + 1n);
  const candidates = [{ action: cre.ACTION.COLLECT_INSTALLMENT, id: loanId }];
  const ready = await collections.checkTasks(candidates);
  const due = candidates.filter((_, i) => ready[i]);
  const colReceipt = await report(collections.target, cre.encodeCollectionsReport(due), cre.WORKFLOW_NAMES.COLLECTIONS);
  await record(4, "mock forwarder report (hand-built) -> collectInstallment", colReceipt);
  const [collected] = events(colReceipt, collections, "TaskExecuted");
  console.log(`     instalment 1 collected: ${$(collected.args.amount)}, ${(await engine.getLoan(loanId)).installmentsPaid}/4 paid`);
  console.log(`     on time: score ${await scores.scoreOf(buyer.address)}, credit line ${$(await scores.creditLimitOf(buyer.address))}\n`);

  // 5. Pay the rest early ----------------------------------------------
  console.log("Pay early");
  const loan = await engine.getLoan(loanId);
  const outstanding = await engine.outstandingOf(loanId);
  t = await now();
  const repay = {
    loanId,
    amount: outstanding,
    expectedRepaid: loan.totalRepaid,
    nonce: await engine.nonces(buyer.address),
    deadline: t + 600n,
  };
  const repaySig = await buyer.signTypedData(await readDomain(engine), { RepayIntent: TYPES.PolarisLoanEngine.RepayIntent }, repay);
  const repayReceipt = await tx.send(engine, "repayWithSig", [loanId, outstanding, loan.totalRepaid, repay.deadline, repaySig]);
  await record(5, `PolarisLoanEngine.repayWithSig ${$(outstanding)}`, repayReceipt);
  const closed = events(repayReceipt, engine, "LoanFullyRepaid").length === 1;
  console.log(`     plan ${closed ? "paid off" : "STILL OPEN"}; score now ${await scores.scoreOf(buyer.address)}\n`);
  if (!closed) throw new Error("the plan did not close");

  // 6. The credit guard ------------------------------------------------
  console.log("Credit guard (mock forwarder attestations, hand-built from a local stand-in AUSD/USD feed; no CRE workflow)");
  const attest = async (price) => {
    await tx.send(feed, "setAnswer", [price]);
    const [roundId, answer, , updatedAt] = await feed.latestRoundData();
    // The workflow's own read: the pool, the thresholds, the bad debt acknowledged.
    const [pool, thresholds, acknowledged] = await guardian.currentInputs();
    const a = cre.buildAttestation(
      { price: answer, priceRoundId: roundId, priceUpdatedAt: updatedAt, pool, observedAt: await now() },
      thresholds,
      acknowledged
    );
    const receipt = await report(guardian.target, cre.encodeGuardianReport(a), cre.WORKFLOW_NAMES.GUARDIAN);
    const [updated] = events(receipt, guardian, "CreditGuardUpdated");
    if (!updated) throw new Error(`the guardian refused the attestation: ${JSON.stringify(events(receipt, guardian, "AttestationRefused").map((e) => e.args.reason))}`);
    return { a, receipt };
  };
  const healthy = await attest(99_980_000n);
  await record(6, "mock forwarder attestation (AUSD $0.9998, pool healthy) -> GuardianReceiver", healthy.receipt);
  if ((await checkout.creditPaused())[0]) throw new Error("credit paused on a healthy attestation");
  const [, feedAnswer] = await guardian.latestRoundData();
  console.log(`     pool health feed: ${await guardian.description()}, $${(Number(feedAnswer) / 1e8).toFixed(2)} lendable`);

  const depeg = await attest(99_000_000n);
  await record(6, "mock forwarder attestation (AUSD $0.9900: depeg) -> credit paused", depeg.receipt);
  const [paused, reasons] = await checkout.creditPaused();
  if (!paused || Number(reasons) !== cre.GUARDIAN_REASON.DEPEG) throw new Error(`expected a depeg pause, got ${paused} ${reasons}`);
  t = await now();
  const pausedValue = (await checkout.quotePlan(buyer.address, USD(100), 4, interval)).permitValue;
  const pausedPermit = await signPermit(token, buyer, engine.target, pausedValue, t + 1800n);
  const pausedIntent = {
    buyer: buyer.address,
    merchant,
    principal: USD(100),
    installments: 4,
    interval,
    orderId: `order-paused-${hexlify(randomBytes(6))}`,
    nonce: await checkout.nonces(buyer.address),
    deadline: t + 600n,
  };
  const pausedSig = await buyer.signTypedData(checkoutDomain, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, pausedIntent);
  const refusedPlan = await checkout.openPlan
    .staticCall(pausedIntent, pausedSig, { value: pausedValue, deadline: t + 1800n, v: pausedPermit.v, r: pausedPermit.r, s: pausedPermit.s })
    .then(() => "accepted", (e) => revertName(checkout, e));
  if (refusedPlan !== "CreditPausedByGuardian") throw new Error(`Pay in 4 was not paused: ${refusedPlan}`);
  console.log("     Pay in 4 refused: CreditPausedByGuardian(1 = depeg)");
  const pausedOrder = `order-now-paused-${hexlify(randomBytes(6))}`;
  const pausedAuth = Signature.from(
    await buyer.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
      from: buyer.address,
      to: payments.target,
      value: USD(5),
      validAfter: 0,
      validBefore: t + 1800n,
      nonce: await checkout.orderKeyOf(merchant, pausedOrder),
    })
  );
  const pausedPay = await tx.send(checkout, "pay", [buyer.address, merchant, USD(5), pausedOrder, 0, t + 1800n, pausedAuth.v, pausedAuth.r, pausedAuth.s]);
  await record(6, "PolarisCheckout.pay $5.00 while credit is paused (never blocked)", pausedPay);

  const resumed = await attest(99_980_000n);
  await record(6, "mock forwarder attestation (AUSD $0.9998 again) -> credit resumed", resumed.receipt);
  if ((await checkout.creditPaused())[0]) throw new Error("credit did not resume");
  console.log("     Pay in 4 open again\n");

  // 7. A second plan, once credit resumed -------------------------------
  console.log("Pay in 4 again");
  t = await now();
  const quote2 = await checkout.quotePlan(buyer.address, USD(100), 4, interval);
  const permit2 = await signPermit(token, buyer, engine.target, quote2.permitValue, t + 1800n);
  const intent2 = { ...pausedIntent, orderId: `order-plan2-${hexlify(randomBytes(6))}`, nonce: await checkout.nonces(buyer.address), deadline: t + 600n };
  const intent2Sig = await buyer.signTypedData(checkoutDomain, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent2);
  const plan2Receipt = await tx.send(checkout, "openPlan", [
    intent2,
    intent2Sig,
    { value: quote2.permitValue, deadline: t + 1800n, v: permit2.v, r: permit2.r, s: permit2.s },
  ]);
  await record(7, `PolarisCheckout.openPlan ${$(USD(100))} in 4 (credit resumed)`, plan2Receipt);
  const loan2 = events(plan2Receipt, checkout, "PlanOpened")[0].args.loanId;
  console.log(`     loan #${loan2}\n`);

  // 8. Lost allowance, re-signed, collected at once ---------------------
  console.log("Re-sign and collect (what the collections workflow's log trigger does; the report is hand-built)");
  // The buyer's allowance is lost: here the buyer's own signed permit for 0,
  // relayed to the token (in the wild: a revoke in another wallet app).
  t = await now();
  const revoke = await signPermit(token, buyer, engine.target, 0n, t + 600n);
  await tx.send(token.connect(relayer), "permit", [buyer.address, engine.target, 0n, t + 600n, revoke.v, revoke.r, revoke.s]);
  await travel(interval + 1n);
  const skippedReceipt = await report(collections.target, cre.encodeCollectionsReport([{ action: cre.ACTION.COLLECT_INSTALLMENT, id: loan2 }]), cre.WORKFLOW_NAMES.COLLECTIONS);
  const [skipped] = events(skippedReceipt, collections, "TaskSkipped");
  const skipReason = skipped ? engine.interface.parseError(skipped.args.reason)?.name : "none";
  if (skipReason !== "InsufficientAllowance") throw new Error(`expected the collection to be skipped for the allowance, got ${skipReason}`);
  await record(8, "mock forwarder report -> collectInstallment skipped: InsufficientAllowance (dunned: sign again)", skippedReceipt);
  const owed = await engine.activeDebtOf(buyer.address);
  t = await now();
  const fresh = await signPermit(token, buyer, engine.target, owed, t + 1800n);
  const reauthReceipt = await tx.send(checkout, "reauthorize", [buyer.address, { value: owed, deadline: t + 1800n, v: fresh.v, r: fresh.r, s: fresh.s }]);
  await record(8, `PolarisCheckout.reauthorize (buyer's permit for ${$(owed)}) -> Reauthorized`, reauthReceipt);
  const [reauth] = events(reauthReceipt, checkout, "Reauthorized");
  const dueNow = (await collections.dueTasksFor(reauth.args.buyer)).map((task) => ({ action: Number(task.action), id: task.id }));
  if (dueNow.length !== 1 || dueNow[0].id !== loan2) throw new Error(`dueTasksFor returned ${JSON.stringify(dueNow, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  const retryReceipt = await report(collections.target, cre.encodeCollectionsReport(dueNow), cre.WORKFLOW_NAMES.COLLECTIONS);
  const [retried] = events(retryReceipt, collections, "TaskExecuted");
  if (!retried) throw new Error("the retry did not collect");
  await record(8, "mock forwarder report (dueTasksFor(buyer)) -> collectInstallment", retryReceipt);
  console.log(`     instalment 1 of loan #${loan2} collected after re-signing: ${$(retried.args.amount)}\n`);

  // 9. Subscribe -------------------------------------------------------
  console.log("Subscribe");
  const plan = d.demo.subscriptionPlans[1];
  const price = BigInt(plan.pricePerPeriod);
  t = await now();
  const subPermit = Signature.from(
    await buyer.signTypedData(tokenDomain, { Permit: TYPES.Stablecoin.Permit }, {
      owner: buyer.address,
      spender: payments.target,
      value: price * 12n,
      nonce: await token.nonces(buyer.address),
      deadline: t + 1800n,
    })
  );
  const subIntent = {
    buyer: buyer.address,
    merchant,
    planId: BigInt(plan.planId),
    pricePerPeriod: price,
    periodSeconds: BigInt(plan.periodSeconds),
    orderId: `order-sub-${hexlify(randomBytes(6))}`,
    nonce: await checkout.nonces(buyer.address),
    deadline: t + 600n,
  };
  const subSig = await buyer.signTypedData(checkoutDomain, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, subIntent);
  const subReceipt = await tx.send(checkout, "subscribe", [
    subIntent,
    subSig,
    { value: price * 12n, deadline: t + 1800n, v: subPermit.v, r: subPermit.r, s: subPermit.s },
  ]);
  await record(9, `PolarisCheckout.subscribe "${plan.name}" ${$(price)}`, subReceipt);
  const [started] = events(subReceipt, checkout, "SubscriptionStarted");
  const subId = started.args.subId;
  console.log(`     subscription #${subId}, period 1 charged, renews every ${plan.periodSeconds}s\n`);

  // 10. A collections report charges period 2 --------------------------
  console.log("Renewal (mock forwarder report, hand-built)");
  await travel(BigInt(plan.periodSeconds) + 1n);
  const renewal = [{ action: cre.ACTION.CHARGE_SUBSCRIPTION, id: subId }];
  if (!(await collections.checkTasks(renewal))[0]) throw new Error("subscription not due");
  const renewReceipt = await report(collections.target, cre.encodeCollectionsReport(renewal), cre.WORKFLOW_NAMES.COLLECTIONS);
  await record(10, "mock forwarder report (hand-built) -> chargeDue", renewReceipt);
  console.log(`     periods charged: ${(await payments.getSubscription(subId)).periodsCharged}\n`);

  // 11. Send by link ---------------------------------------------------
  console.log("Send by link");
  const linkKey = Wallet.createRandom();
  const sendAmount = USD(50);
  const sendDomain = await readDomain(send);
  t = await now();
  const expiresAt = t + 7n * 24n * 3600n;
  const sendAuth = Signature.from(
    await studio.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
      from: studio.address,
      to: send.target,
      value: sendAmount,
      validAfter: 0,
      validBefore: t + 1800n,
      nonce: await send.sendNonce(linkKey.address, expiresAt),
    })
  );
  const open = Signature.from(
    await linkKey.signTypedData(sendDomain, { Open: TYPES.PolarisSend.Open }, { sender: studio.address, amount: sendAmount, expiresAt })
  );
  const sendReceipt = await tx.send(send, "send", [
    studio.address, linkKey.address, sendAmount, expiresAt, 0, t + 1800n,
    sendAuth.v, sendAuth.r, sendAuth.s, open.v, open.r, open.s,
  ]);
  await record(11, `PolarisSend.send ${$(sendAmount)} as a link`, sendReceipt);
  console.log(`     link https://pay.polarispay.app/claim#k=<throwaway key> (key address ${linkKey.address})\n`);

  // 12. Claim ----------------------------------------------------------
  console.log("Claim");
  t = await now();
  const claim = Signature.from(
    await linkKey.signTypedData(sendDomain, { Claim: TYPES.PolarisSend.Claim }, { to: freelancer.address, deadline: t + 600n })
  );
  const claimReceipt = await tx.send(send, "claim", [linkKey.address, freelancer.address, t + 600n, claim.v, claim.r, claim.s]);
  await record(12, "PolarisSend.claim to a fresh account", claimReceipt);
  console.log(`     freelancer holds ${$(await token.balanceOf(freelancer.address))}\n`);

  // Summary ------------------------------------------------------------
  const gasless = [buyer, studio, freelancer];
  const spent = await Promise.all(gasless.map((w) => ethers.provider.getBalance(w.address)));
  const nonces = await Promise.all(gasless.map((w) => ethers.provider.getTransactionCount(w.address)));
  if (spent.some((b) => b !== 0n) || nonces.some((n) => n !== 0)) {
    throw new Error("a user sent a transaction or held MON");
  }

  console.log("Summary");
  console.log("  step  gas used   gas limit  (estimate + 15%)  what");
  for (const r of rows) {
    console.log(`  ${String(r.step).padEnd(4)}  ${String(r.gasUsed).padStart(9)}  ${String(r.gasLimit).padStart(9)}  ${r.what}`);
  }
  console.log(`\n  buyer      ${$(await token.balanceOf(buyer.address))} AUSD, 0 MON, 0 transactions sent`);
  console.log(`  studio     ${$(await token.balanceOf(studio.address))} AUSD, 0 MON, 0 transactions sent`);
  console.log(`  freelancer ${$(await token.balanceOf(freelancer.address))} AUSD, 0 MON, 0 transactions sent`);
  console.log(`  merchant   ${$(await token.balanceOf(merchant))} AUSD`);
  console.log(`  pool       ${$(await token.balanceOf(engine.target))} AUSD in PolarisLoanEngine`);
  console.log("\nAll twelve flows passed. Every user action was a signature; the relayer and the DON paid all gas.");
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
