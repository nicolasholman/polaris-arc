/**
 * The flows the contracts' own end-to-end run (scripts/e2e-monad-local.js)
 * does not cover, so the recorded fixture exercises every handler:
 *
 *   - a second buyer, underwritten, locks collateral, opens a one-minute
 *     plan and cannot pay: CRE skips the collection (InsufficientBalance),
 *     then liquidates past grace and seizes the collateral;
 *   - a stale candidate (a closed loan) in a collections report;
 *   - a second underwriting for the same buyer, refused (AlreadyHasRecord);
 *   - a merchant registered by signature, an order quoted then paid at its
 *     price, and two payouts carried as signed transferWithAuthorization;
 *   - a subscription cancelled by signature;
 *   - a send cancelled by the sender, and one refunded after expiry;
 *   - a batch settlement.
 *
 * Run by scripts/record-fixture.mjs through `hardhat run --network
 * monadLocal` from packages/contracts, after deploy-monad.js and
 * e2e-monad-local.js; `hre` is the global Hardhat injects. Local only: it
 * time-travels and mints.
 */

"use strict";

const { join } = require("node:path");

const CONTRACTS = process.env.POLARIS_CONTRACTS_DIR;
if (!CONTRACTS) throw new Error("POLARIS_CONTRACTS_DIR is not set (run through scripts/record-fixture.mjs)");
const { ethers } = hre; // eslint-disable-line no-undef
const { Wallet, Signature, hexlify, randomBytes, keccak256, toUtf8Bytes, solidityPacked } = ethers;
const d = require(join(CONTRACTS, "deployments", "monad-local.json"));
const { TYPES, readDomain } = require(join(CONTRACTS, "lib", "eip712.js"));
const cre = require(join(CONTRACTS, "lib", "cre.js"));
const tx = require(join(CONTRACTS, "lib", "tx.js"));

const USD = (n) => ethers.parseUnits(String(n), 6);

async function now() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

async function travel(seconds) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function main() {
  if (d.chainId === 10143) throw new Error("Local only.");
  const [deployer, relayer] = await ethers.getSigners();
  const at = (name) => ethers.getContractAt(name, d.contracts[name].address);
  const token = await ethers.getContractAt("MockAUSD", d.contracts.Stablecoin.address);
  const checkout = (await at("PolarisCheckout")).connect(relayer);
  const engine = await at("PolarisLoanEngine");
  const payments = await at("PolarisPayments");
  const send = (await at("PolarisSend")).connect(relayer);
  const registry = await at("MerchantRegistry");
  const vault = await at("CollateralVault");
  const batch = await at("BatchSettlement");
  const collections = await at("CollectionsReceiver");
  const underwriting = await at("UnderwritingReceiver");
  const forwarder = (await at("MockKeystoneForwarder")).connect(deployer);
  const tokenDomain = await readDomain(token);
  const checkoutDomain = await readDomain(checkout);
  const merchant = d.demo.merchant;

  const checkoutEvent = (receipt, name) =>
    receipt.logs
      .filter((l) => l.address.toLowerCase() === checkout.target.toLowerCase())
      .map((l) => checkout.interface.parseLog(l))
      .find((e) => e?.name === name);

  const report = async (receiver, body, workflowName) => {
    const raw = cre.encodeRawReport({
      body,
      workflowName,
      workflowOwner: deployer.address,
      executionId: hexlify(randomBytes(32)),
      timestamp: Number(await now()),
    });
    return tx.send(forwarder, "report", [receiver, raw, "0x", []]);
  };
  const facts = async (over = {}) => ({
    walletAgeDays: 400,
    txCount: 300,
    stableBalance: USD(800),
    defiTenureDays: 120,
    priorLiquidations: 0,
    relatedWallets: 0,
    exchangeFunded: false,
    observedAt: await now(),
    ...over,
  });

  // ── A buyer who cannot pay ──────────────────────────────────────────────
  const buyer2 = Wallet.createRandom().connect(ethers.provider);
  await report(underwriting.target, cre.encodeUnderwritingReport([{ user: buyer2.address, linkedWallet: ethers.ZeroAddress, facts: await facts() }]), cre.WORKFLOW_NAMES.UNDERWRITING);
  console.log(`  buyer2 ${buyer2.address} underwritten`);

  // Collateral: the only transactions any user sends, and only here, locally.
  await deployer.sendTransaction({ to: buyer2.address, value: ethers.parseEther("1") });
  await tx.send(token.connect(deployer), "mint", [buyer2.address, USD(20)]);
  await tx.send(token.connect(buyer2), "approve", [vault.target, USD(20)]);
  await tx.send(vault.connect(buyer2), "lock", [USD(20)]);
  console.log("  buyer2 locked $20 of collateral");

  const principal = USD(100);
  const interval = 60n;
  const quote = await checkout.quotePlan(buyer2.address, principal, 4, interval);
  let t = await now();
  const permit = Signature.from(
    await buyer2.signTypedData(tokenDomain, { Permit: TYPES.Stablecoin.Permit }, {
      owner: buyer2.address,
      spender: engine.target,
      value: quote.permitValue,
      nonce: await token.nonces(buyer2.address),
      deadline: t + 1800n,
    }),
  );
  const intent = {
    buyer: buyer2.address,
    merchant,
    principal,
    installments: 4,
    interval,
    orderId: `order-plan2-${hexlify(randomBytes(4))}`,
    nonce: await checkout.nonces(buyer2.address),
    deadline: t + 600n,
  };
  const intentSig = await buyer2.signTypedData(checkoutDomain, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent);
  const opened = await tx.send(checkout, "openPlan", [intent, intentSig, { value: quote.permitValue, deadline: t + 1800n, v: permit.v, r: permit.r, s: permit.s }]);
  const loanId = checkoutEvent(opened, "PlanOpened").args.loanId;
  console.log(`  loan #${loanId} opened on one-minute instalments`);

  await travel(interval + 1n);
  // The candidate list proposes loan #1 too (closed by the e2e run): stale.
  await report(
    collections.target,
    cre.encodeCollectionsReport([
      { action: cre.ACTION.COLLECT_INSTALLMENT, id: loanId },
      { action: cre.ACTION.COLLECT_INSTALLMENT, id: 1n },
    ]),
    cre.WORKFLOW_NAMES.COLLECTIONS,
  );
  console.log("  CRE collection skipped: buyer2 short, loan #1 stale");

  const grace = BigInt(d.config.graceSeconds);
  await travel(grace + 1n);
  if (!(await collections.checkTasks([{ action: cre.ACTION.LIQUIDATE, id: loanId }]))[0]) throw new Error("not liquidatable");
  await report(collections.target, cre.encodeCollectionsReport([{ action: cre.ACTION.LIQUIDATE, id: loanId }]), cre.WORKFLOW_NAMES.COLLECTIONS);
  console.log(`  loan #${loanId} liquidated; collateral seized`);

  // Underwriting the same buyer twice is refused.
  await report(underwriting.target, cre.encodeUnderwritingReport([{ user: buyer2.address, linkedWallet: ethers.ZeroAddress, facts: await facts() }]), cre.WORKFLOW_NAMES.UNDERWRITING);
  console.log("  a second underwriting for buyer2 refused");

  // ── A merchant who takes payments and withdraws ─────────────────────────
  const kiosk = Wallet.createRandom();
  const kioskPayout = Wallet.createRandom().address;
  const exchange = Wallet.createRandom().address;
  t = await now();
  const regDomain = await readDomain(registry);
  const reg = { merchant: kiosk.address, name: "Kiosk Norte", payoutAddress: kioskPayout, metadataURI: "", nonce: await registry.nonces(kiosk.address), deadline: t + 600n };
  const regSig = await kiosk.signTypedData(regDomain, { Registration: TYPES.MerchantRegistry.Registration }, reg);
  await tx.send(registry.connect(deployer), "registerFor", [kiosk.address, reg.name, reg.payoutAddress, reg.metadataURI, reg.deadline, regSig]);
  console.log(`  merchant ${kiosk.address} registered by signature`);

  const buyer3 = Wallet.createRandom().connect(ethers.provider);
  await tx.send(token.connect(deployer), "mint", [buyer3.address, USD(100)]);
  const orderId = `order-quoted-${hexlify(randomBytes(4))}`;
  const orderKey = keccak256(solidityPacked(["address", "string"], [kiosk.address, orderId]));
  await tx.send(payments.connect(deployer), "quoteOrder", [kiosk.address, orderKey, USD(30)]);
  t = await now();
  const auth = Signature.from(
    await buyer3.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
      from: buyer3.address,
      to: payments.target,
      value: USD(30),
      validAfter: 0,
      validBefore: t + 1800n,
      nonce: orderKey,
    }),
  );
  await tx.send(checkout, "pay", [buyer3.address, kiosk.address, USD(30), orderId, 0, t + 1800n, auth.v, auth.r, auth.s]);
  console.log("  quoted order paid at its price");

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
    await tx.send(token.connect(relayer), "transferWithAuthorization", [kiosk.address, to, value, 0, s + 1800n, nonce, sig.v, sig.r, sig.s]);
  };
  await withdraw(exchange, USD(10));
  await withdraw(kioskPayout, USD(5));
  console.log("  two gasless payouts");

  // ── A subscription cancelled by signature ───────────────────────────────
  const plan = d.demo.subscriptionPlans[0];
  const price = BigInt(plan.pricePerPeriod);
  t = await now();
  const subPermit = Signature.from(
    await buyer3.signTypedData(tokenDomain, { Permit: TYPES.Stablecoin.Permit }, {
      owner: buyer3.address,
      spender: payments.target,
      value: price * 12n,
      nonce: await token.nonces(buyer3.address),
      deadline: t + 1800n,
    }),
  );
  const subIntent = {
    buyer: buyer3.address,
    merchant,
    planId: BigInt(plan.planId),
    pricePerPeriod: price,
    periodSeconds: BigInt(plan.periodSeconds),
    orderId: `order-sub3-${hexlify(randomBytes(4))}`,
    nonce: await checkout.nonces(buyer3.address),
    deadline: t + 600n,
  };
  const subSig = await buyer3.signTypedData(checkoutDomain, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, subIntent);
  const subReceipt = await tx.send(checkout, "subscribe", [subIntent, subSig, { value: price * 12n, deadline: t + 1800n, v: subPermit.v, r: subPermit.r, s: subPermit.s }]);
  const subId = checkoutEvent(subReceipt, "SubscriptionStarted").args.subId;
  t = await now();
  const cancel = Signature.from(
    await buyer3.signTypedData(await readDomain(payments), { CancelSubscription: TYPES.PolarisPayments.CancelSubscription }, { subId, deadline: t + 600n }),
  );
  await tx.send(payments.connect(relayer), "cancelWithSignature", [subId, t + 600n, cancel.v, cancel.r, cancel.s]);
  console.log(`  subscription #${subId} cancelled by signature`);

  // ── Sends: one cancelled, one refunded ──────────────────────────────────
  const sender = Wallet.createRandom();
  await tx.send(token.connect(deployer), "mint", [sender.address, USD(20)]);
  const sendDomain = await readDomain(send);
  const sendLink = async (amount, lifetime) => {
    const key = Wallet.createRandom();
    const s = await now();
    const expiresAt = s + lifetime;
    const a = Signature.from(
      await sender.signTypedData(tokenDomain, { ReceiveWithAuthorization: TYPES.Stablecoin.ReceiveWithAuthorization }, {
        from: sender.address,
        to: send.target,
        value: amount,
        validAfter: 0,
        validBefore: s + 1800n,
        nonce: await send.sendNonce(key.address, expiresAt),
      }),
    );
    const open = Signature.from(await key.signTypedData(sendDomain, { Open: TYPES.PolarisSend.Open }, { sender: sender.address, amount, expiresAt }));
    await tx.send(send, "send", [sender.address, key.address, amount, expiresAt, 0, s + 1800n, a.v, a.r, a.s, open.v, open.r, open.s]);
    return key;
  };
  const cancelled = await sendLink(USD(5), 3600n);
  t = await now();
  const c = Signature.from(await sender.signTypedData(sendDomain, { Cancel: TYPES.PolarisSend.Cancel }, { linkKey: cancelled.address, deadline: t + 600n }));
  await tx.send(send, "cancel", [cancelled.address, t + 600n, c.v, c.r, c.s]);
  const expiring = await sendLink(USD(6), 301n);
  await travel(302n);
  await tx.send(send, "refund", [expiring.address]);
  console.log("  one link cancelled, one refunded after expiry");

  // ── A batch settlement ─────────────────────────────────────────────────
  await tx.send(batch.connect(deployer), "setSettler", [deployer.address, true]);
  await tx.send(token.connect(deployer), "mint", [deployer.address, USD(50)]);
  await tx.send(token.connect(deployer), "approve", [batch.target, USD(50)]);
  await tx.send(batch.connect(deployer), "fund", [USD(50)]);
  await tx.send(batch.connect(deployer), "settleBatch", [
    hexlify(randomBytes(32)),
    [kiosk.address, exchange],
    [USD(20), USD(30)],
    [keccak256(toUtf8Bytes("invoice-1")), keccak256(toUtf8Bytes("invoice-2"))],
  ]);
  console.log("  batch of two settled");
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
