/**
 * PolarisCheckout.reauthorize: a buyer whose standing allowance to the loan
 * engine was lost signs a fresh ERC-2612 permit, a relayer submits it, and
 * `Reauthorized` tells the collections workflow's EVM log trigger to collect
 * at once. Then `CollectionsReceiver.dueTasksFor(buyer)` is the report the
 * retry writes. Tests are named for what each refuses or guarantees.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");

const { signTyped, signPermit } = require("../helpers/sign");
const { TYPES } = require("../../lib/eip712");
const cre = require("../../lib/cre");

const AUSD = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;

async function deployStack() {
  const [owner, relayer, merchant, treasury, stranger, don] = await ethers.getSigners();
  const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
  const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
  const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, ausd, scores, treasury.address, DAY, 60);
  const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(owner.address, ausd, treasury.address, 60);
  const checkout = await (await ethers.getContractFactory("PolarisCheckout")).deploy(owner.address, engine, payments, scores);
  const forwarder = await (await ethers.getContractFactory("MockKeystoneForwarder")).deploy();
  const collections = await (await ethers.getContractFactory("CollectionsReceiver")).deploy(forwarder, engine, payments, don.address);
  await scores.setWriter(engine, true);
  await engine.setOriginator(checkout, true);
  await payments.setCheckout(checkout);
  await ausd.mint(owner.address, AUSD(100_000));
  await ausd.approve(engine, AUSD(100_000));
  await engine.fund(AUSD(50_000));
  return { ausd, scores, engine, payments, checkout, forwarder, collections, owner, relayer, merchant, stranger, don };
}

describe("PolarisCheckout.reauthorize (the instant collection retry)", () => {
  let s;

  beforeEach(async () => {
    s = await loadFixture(deployStack);
  });

  const now = async () => BigInt(await time.latest());
  const engineAddress = () => s.engine.getAddress();
  const permitArg = (p, value = p.value) => ({ value, deadline: p.deadline, v: p.v, r: p.r, s: p.s });

  /** A gasless buyer with an open plan, whose allowance then vanished. */
  async function buyerWhoLostTheAllowance({ plans = 1 } = {}) {
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    await s.ausd.mint(buyer.address, AUSD(1_000));
    const loans = [];
    for (let i = 0; i < plans; i++) {
      const intent = {
        buyer: buyer.address,
        merchant: s.merchant.address,
        principal: AUSD(60),
        installments: 4,
        interval: BigInt(WEEK),
        orderId: `o-${i}-${Math.random()}`,
        nonce: await s.checkout.nonces(buyer.address),
        deadline: (await now()) + 600n,
      };
      const q = await s.checkout.quotePlan(buyer.address, intent.principal, 4, WEEK);
      const p = await signPermit(s.ausd, buyer, await engineAddress(), q.permitValue);
      const sig = (await signTyped(buyer, s.checkout, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent)).signature;
      await s.checkout.connect(s.relayer).openPlan(intent, sig, permitArg(p));
      loans.push(await s.engine.loanCount());
    }
    // The buyer revokes in another wallet app (here: impersonated; in the app
    // the buyer never holds gas).
    await impersonateAccount(buyer.address);
    await setBalance(buyer.address, ethers.parseEther("1"));
    await s.ausd.connect(await ethers.getSigner(buyer.address)).approve(await engineAddress(), 0);
    await setBalance(buyer.address, 0n);
    return { buyer, loans };
  }

  async function deliverCollections(tasks) {
    const raw = cre.encodeRawReport({
      body: cre.encodeCollectionsReport(tasks),
      workflowName: cre.WORKFLOW_NAMES.COLLECTIONS,
      workflowOwner: s.don.address,
      executionId: ethers.hexlify(ethers.randomBytes(32)),
      timestamp: Number(await now()),
    });
    return (await s.forwarder.connect(s.don).report(await s.collections.getAddress(), raw, "0x", [])).wait();
  }

  const parsed = (receipt, contract, name) =>
    receipt.logs
      .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .filter((e) => e && e.name === name);

  it("a skipped buyer re-signs, Reauthorized fires, and the retry report collects what fell due", async () => {
    const { buyer, loans: [loanId] } = await buyerWhoLostTheAllowance();
    await time.increase(WEEK);
    const skipped = await deliverCollections([{ action: cre.ACTION.COLLECT_INSTALLMENT, id: loanId }]);
    const [skip] = parsed(skipped, s.collections, "TaskSkipped");
    expect(s.engine.interface.parseError(skip.args.reason).name).to.equal("InsufficientAllowance");

    const owed = await s.engine.activeDebtOf(buyer.address);
    const p = await signPermit(s.ausd, buyer, await engineAddress(), owed, (await now()) + 900n);
    const tx = s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(p));
    await expect(tx).to.emit(s.checkout, "Reauthorized").withArgs(buyer.address, owed, p.deadline);
    expect(await s.ausd.allowance(buyer.address, await engineAddress())).to.equal(owed);
    const log = parsed(await (await tx).wait(), s.checkout, "Reauthorized")[0];
    expect(log.topic).to.equal(ethers.id("Reauthorized(address,uint256,uint256)"));

    // What the log trigger's handler reads, then writes.
    const tasks = (await s.collections.dueTasksFor(buyer.address)).map((t) => ({ action: Number(t.action), id: t.id }));
    expect(tasks).to.deep.equal([{ action: cre.ACTION.COLLECT_INSTALLMENT, id: loanId }]);
    const due = await s.engine.installmentAmount(loanId);
    const collected = await deliverCollections(tasks);
    const [executed] = parsed(collected, s.collections, "TaskExecuted");
    expect([executed.args.id, executed.args.amount]).to.deep.equal([loanId, due]);
    expect((await s.engine.getLoan(loanId)).installmentsPaid).to.equal(1);
    expect(await ethers.provider.getTransactionCount(buyer.address)).to.equal(1, "only the impersonated revoke, never a relay");
  });

  it("dueTasksFor lists only the buyer's plans that can be collected now", async () => {
    const { buyer, loans } = await buyerWhoLostTheAllowance({ plans: 2 });
    expect(await s.collections.dueTasksFor(buyer.address)).to.deep.equal([], "nothing due yet");
    expect(await s.collections.dueTasksFor(s.stranger.address)).to.deep.equal([], "no plans at all");
    await time.increase(WEEK);
    const due = (await s.collections.dueTasksFor(buyer.address)).map((t) => t.id);
    expect(due).to.deep.equal(loans);
    expect(await s.engine.loanIdsOf(buyer.address)).to.deep.equal(loans);
  });

  it("refuses an expired permit", async () => {
    const { buyer } = await buyerWhoLostTheAllowance();
    const owed = await s.engine.activeDebtOf(buyer.address);
    const p = await signPermit(s.ausd, buyer, await engineAddress(), owed, (await now()) + 60n);
    await time.increase(120);
    await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(p))).to.be.revertedWithCustomError(s.checkout, "SignatureExpired");
  });

  it("refuses a permit signed by anyone but the buyer, or for another spender or value", async () => {
    const { buyer } = await buyerWhoLostTheAllowance();
    const owed = await s.engine.activeDebtOf(buyer.address);
    const deadline = (await now()) + 600n;
    // Someone else's key signs the buyer's permit.
    const forger = ethers.Wallet.createRandom();
    const forged = await signTyped(forger, s.ausd, { Permit: TYPES.Stablecoin.Permit }, {
      owner: buyer.address, spender: await engineAddress(), value: owed, nonce: await s.ausd.nonces(buyer.address), deadline,
    });
    await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, { value: owed, deadline, v: forged.v, r: forged.r, s: forged.s }))
      .to.be.revertedWithCustomError(s.checkout, "InvalidSignature");
    // The buyer's real permit, but for a different spender: it can't be pointed at the engine.
    const elsewhere = await signPermit(s.ausd, buyer, s.stranger.address, owed, deadline);
    await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(elsewhere))).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");
    // The buyer's permit, relayed with a larger value than signed.
    const real = await signPermit(s.ausd, buyer, await engineAddress(), owed, deadline);
    await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(real, owed * 10n))).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");
    // And a permit for another buyer's account.
    await expect(s.checkout.connect(s.relayer).reauthorize(s.stranger.address, permitArg(real))).to.be.revertedWithCustomError(s.checkout, "NothingOwed");
    expect(await s.ausd.allowance(buyer.address, await engineAddress())).to.equal(0n);
  });

  it("refuses a replay: a permit applies once", async () => {
    const { buyer } = await buyerWhoLostTheAllowance();
    const owed = await s.engine.activeDebtOf(buyer.address);
    const p = await signPermit(s.ausd, buyer, await engineAddress(), owed, (await now()) + 600n);
    await s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(p));
    await expect(s.checkout.connect(s.stranger).reauthorize(buyer.address, permitArg(p))).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");
  });

  // Security review: landing the buyer's permit on the token first made
  // reauthorize revert, so a stranger could cancel the instant retry for free.
  it("a permit a stranger lands on the token first still fires the retry, once: the allowance it set is in force", async () => {
    const { buyer } = await buyerWhoLostTheAllowance();
    const owed = await s.engine.activeDebtOf(buyer.address);
    const p = await signPermit(s.ausd, buyer, await engineAddress(), owed, (await now()) + 600n);
    await s.ausd.connect(s.stranger).permit(buyer.address, await engineAddress(), owed, p.deadline, p.v, p.r, p.s);
    expect(await s.ausd.allowance(buyer.address, await engineAddress())).to.equal(owed);
    const nonce = await s.ausd.nonces(buyer.address);
    await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(p)))
      .to.emit(s.checkout, "Reauthorized")
      .withArgs(buyer.address, owed, p.deadline);
    expect(await s.checkout.reauthorizedThrough(buyer.address)).to.equal(nonce);
    // Announced once: the same permit again is refused.
    await expect(s.checkout.connect(s.stranger).reauthorize(buyer.address, permitArg(p))).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");
  });

  it("an older permit that landed is not the one in force once the allowance moved on", async () => {
    const { buyer } = await buyerWhoLostTheAllowance();
    const owed = await s.engine.activeDebtOf(buyer.address);
    const p = await signPermit(s.ausd, buyer, await engineAddress(), owed + 5n, (await now()) + 600n);
    await s.ausd.connect(s.stranger).permit(buyer.address, await engineAddress(), owed + 5n, p.deadline, p.v, p.r, p.s);
    // The buyer's own wallet approves another amount afterwards (no permit, so the nonce stays).
    await impersonateAccount(buyer.address);
    await setBalance(buyer.address, ethers.parseEther("1"));
    await s.ausd.connect(await ethers.getSigner(buyer.address)).approve(await engineAddress(), owed);
    await setBalance(buyer.address, 0n);
    await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(p))).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");
  });

  // Security review F2: openPlan's permit and reauthorize's have the same
  // spender, so a mempool watcher could submit a buyer's openPlan permit to
  // reauthorize first: a Reauthorized nobody asked for, a log-triggered run,
  // and allowance_lost plans marked re-signed.
  it("refuses a buyer whose allowance still covers what they owe, so openPlan's permit can't fire a retry; openPlan still opens", async () => {
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    await s.ausd.mint(buyer.address, AUSD(1_000));
    const open = async (i) => {
      const intent = {
        buyer: buyer.address,
        merchant: s.merchant.address,
        principal: AUSD(60),
        installments: 4,
        interval: BigInt(WEEK),
        orderId: `copy-${i}`,
        nonce: await s.checkout.nonces(buyer.address),
        deadline: (await now()) + 600n,
      };
      const q = await s.checkout.quotePlan(buyer.address, intent.principal, 4, WEEK);
      const p = await signPermit(s.ausd, buyer, await engineAddress(), q.permitValue);
      const sig = (await signTyped(buyer, s.checkout, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent)).signature;
      return { intent, sig, permit: permitArg(p) };
    };
    const first = await open(1);
    await s.checkout.connect(s.relayer).openPlan(first.intent, first.sig, first.permit);
    const owed = await s.engine.activeDebtOf(buyer.address);
    const allowance = await s.ausd.allowance(buyer.address, await engineAddress());
    expect(allowance >= owed).to.equal(true);

    // The second plan's permit (activeDebt + the new plan), copied from the mempool.
    const second = await open(2);
    await expect(s.checkout.connect(s.stranger).reauthorize(buyer.address, second.permit))
      .to.be.revertedWithCustomError(s.checkout, "AlreadyAuthorized")
      .withArgs(allowance, owed);
    await expect(s.checkout.connect(s.relayer).openPlan(second.intent, second.sig, second.permit)).to.emit(s.checkout, "PlanOpened");
  });

  it("refuses a permit that would not cover everything the buyer owes, and a buyer who owes nothing", async () => {
    const { buyer } = await buyerWhoLostTheAllowance({ plans: 2 });
    const owed = await s.engine.activeDebtOf(buyer.address);
    const short = await signPermit(s.ausd, buyer, await engineAddress(), owed - 1n, (await now()) + 600n);
    await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(short)))
      .to.be.revertedWithCustomError(s.checkout, "PermitBelowDebt")
      .withArgs(owed - 1n, owed);

    const fresh = ethers.Wallet.createRandom();
    const p = await signPermit(s.ausd, fresh, await engineAddress(), AUSD(10), (await now()) + 600n);
    await expect(s.checkout.connect(s.relayer).reauthorize(fresh.address, permitArg(p)))
      .to.be.revertedWithCustomError(s.checkout, "NothingOwed")
      .withArgs(fresh.address);
    await expect(s.checkout.connect(s.relayer).reauthorize(ethers.ZeroAddress, permitArg(p))).to.be.revertedWithCustomError(s.checkout, "ZeroAddress");
  });

  it("works while the checkout is paused: it only lets a buyer pay what they already owe", async () => {
    const { buyer } = await buyerWhoLostTheAllowance();
    await s.checkout.pause();
    const owed = await s.engine.activeDebtOf(buyer.address);
    const p = await signPermit(s.ausd, buyer, await engineAddress(), owed, (await now()) + 600n);
    await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, permitArg(p))).to.emit(s.checkout, "Reauthorized");
  });

  it("is on the published ABI with the event the workflow filters on", async () => {
    const fn = s.checkout.interface.getFunction("reauthorize");
    expect(fn.format()).to.equal("reauthorize(address,(uint256,uint256,uint8,bytes32,bytes32))");
    expect(s.checkout.interface.getEvent("Reauthorized").format()).to.equal("Reauthorized(address,uint256,uint256)");
    expect(await s.checkout.PERMIT_TYPEHASH()).to.equal(ethers.id("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"));
  });
});
