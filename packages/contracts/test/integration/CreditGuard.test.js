/**
 * The credit guard: CreditGuard and the check PolarisCheckout.openPlan makes
 * against it. The guard reads the pool live (USDC is Arc's unit of account,
 * so there is no peg to attest), so these tests drive the pool itself, or a
 * PoolDouble where a test needs figures no loan book here would reach.
 * Tests are named for what each refuses or guarantees.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { signTyped, signPermit, signReceive } = require("../helpers/sign");
const { TYPES } = require("../../lib/eip712");
const keeperLib = require("../../lib/keeper");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

const { LOW_CASH, BAD_DEBT, OWNER_PAUSE } = keeperLib.GUARD_REASON;
const OVERRIDE = keeperLib.GUARD_OVERRIDE;
const DEFAULTS = keeperLib.guardThresholds();
const tuple = (t) => [BigInt(t.minFreeCash), BigInt(t.maxBadDebtBps), BigInt(t.minOriginated)];

async function deployStack() {
  const [owner, relayer, merchant, treasury, stranger, keeper] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy("USDC");
  const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
  const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, usdc, scores, treasury.address, DAY, 60);
  const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(owner.address, usdc, treasury.address, 60);
  const send = await (await ethers.getContractFactory("PolarisSend")).deploy(usdc);
  const checkout = await (await ethers.getContractFactory("PolarisCheckout")).deploy(owner.address, engine, payments, scores);
  const guard = await (await ethers.getContractFactory("CreditGuard")).deploy(owner.address, engine, DEFAULTS);
  const collections = await (await ethers.getContractFactory("CollectionsReceiver")).deploy(keeper.address, engine, payments);

  await scores.setWriter(engine, true);
  await engine.setOriginator(checkout, true);
  await payments.setCheckout(checkout);
  await checkout.setCreditGuardian(guard);
  await usdc.mint(owner.address, USDC(100_000));
  await usdc.approve(engine, USDC(100_000));
  await engine.fund(USDC(50_000));

  return { usdc, scores, engine, payments, send, checkout, guard, collections, owner, relayer, merchant, treasury, stranger, keeper };
}

describe("The credit guard (CreditGuard)", () => {
  let s;

  beforeEach(async () => {
    s = await loadFixture(deployStack);
  });

  const now = async () => BigInt(await time.latest());

  /** A CreditGuard over a PoolDouble whose figures the test sets. */
  async function guardOverDouble(thresholds = DEFAULTS) {
    const pool = await (await ethers.getContractFactory("PoolDouble")).deploy(await s.usdc.getAddress());
    const guard = await (await ethers.getContractFactory("CreditGuard")).deploy(s.owner.address, pool, thresholds);
    return { pool, guard };
  }

  const resumeFor = async (guard, seconds = 3_600) => guard.setOverride(OVERRIDE.FORCE_RESUME, (await now()) + BigInt(seconds) + 1n);

  async function planArgs(buyer, principal = USDC(100)) {
    const intent = {
      buyer: buyer.address,
      merchant: s.merchant.address,
      principal,
      installments: 4,
      interval: BigInt(WEEK),
      orderId: `o-${Math.random()}`,
      nonce: await s.checkout.nonces(buyer.address),
      deadline: (await now()) + 600n,
    };
    const q = await s.checkout.quotePlan(buyer.address, principal, 4, WEEK);
    const p = await signPermit(s.usdc, buyer, await s.engine.getAddress(), q.permitValue);
    const sig = (await signTyped(buyer, s.checkout, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent)).signature;
    return [intent, sig, { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s }];
  }

  async function newBuyer() {
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    await s.usdc.mint(buyer.address, USDC(1_000));
    return buyer;
  }

  /** Drain the pool below the guard's minimum free cash. */
  async function drainPool(leave = USDC(500)) {
    const free = (await s.engine.poolState()).freeCash;
    await s.engine.withdrawLiquidity(free - leave, s.owner.address);
  }

  // ---------------------------------------------------------------------
  describe("the pool, read live", () => {
    it("a funded, healthy pool leaves Pay in 4 open", async () => {
      expect(await s.guard.isCreditPaused()).to.deep.equal([false, 0n]);
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
      const buyer = await newBuyer();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.emit(s.checkout, "PlanOpened");
    });

    it("low free cash pauses new plans at once, and refilling the pool resumes them, with no report in between", async () => {
      await drainPool();
      expect(await s.checkout.creditPaused()).to.deep.equal([true, BigInt(LOW_CASH)]);
      const buyer = await newBuyer();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer))))
        .to.be.revertedWithCustomError(s.checkout, "CreditPausedByGuardian")
        .withArgs(LOW_CASH);
      await s.engine.fund(USDC(5_000));
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.emit(s.checkout, "PlanOpened");
    });

    it("bad debt above 5% of lifetime originations pauses, once enough has been lent, with every reason at once", async () => {
      const { pool, guard } = await guardOverDouble();
      await pool.setState(USDC(500), 0, USDC(600), USDC(10_000));
      expect(await guard.isCreditPaused()).to.deep.equal([true, BigInt(LOW_CASH | BAD_DEBT)]);
      await pool.setState(USDC(5_000), 0, USDC(500), USDC(10_000)); // exactly 5%: not above
      expect(await guard.isCreditPaused()).to.deep.equal([false, 0n]);
      await pool.setState(USDC(5_000), 0, USDC(500) + 1n, USDC(10_000));
      expect(await guard.isCreditPaused()).to.deep.equal([true, BigInt(BAD_DEBT)]);
    });

    it("one default on a young pool does not pause everyone; acknowledged bad debt lifts a bad-debt pause", async () => {
      const { pool, guard } = await guardOverDouble();
      await pool.setState(USDC(5_000), 0, USDC(200), USDC(1_000)); // 20%, but under $10,000 lent
      expect(await guard.isCreditPaused()).to.deep.equal([false, 0n]);
      await pool.setState(USDC(5_000), 0, USDC(2_000), USDC(20_000));
      expect((await guard.isCreditPaused())[1]).to.equal(BigInt(BAD_DEBT));
      await expect(guard.connect(s.stranger).acknowledgeBadDebt()).to.be.revertedWithCustomError(guard, "OwnableUnauthorizedAccount");
      await expect(guard.acknowledgeBadDebt()).to.emit(guard, "BadDebtAcknowledged").withArgs(USDC(2_000));
      expect(await guard.isCreditPaused()).to.deep.equal([false, 0n]);
      await pool.setState(USDC(5_000), 0, USDC(3_001), USDC(20_000)); // $1,001 new > 5% of $20,000
      expect((await guard.isCreditPaused())[1]).to.equal(BigInt(BAD_DEBT));
    });

    it("poolReasons() on chain and guardPoolReasons() in lib/keeper.js agree, on edges and on random pools", async () => {
      const { guard } = await guardOverDouble();
      const cases = [
        { freeCash: 0n, totalOwed: 0n, badDebt: 0n, totalOriginated: 0n },
        { freeCash: DEFAULTS.minFreeCash, totalOwed: 0n, badDebt: 0n, totalOriginated: DEFAULTS.minOriginated },
        { freeCash: DEFAULTS.minFreeCash - 1n, totalOwed: 0n, badDebt: 1n, totalOriginated: DEFAULTS.minOriginated - 1n },
      ];
      for (let i = 0; i < 40; i++) {
        const r = () => BigInt(Math.floor(Math.random() * 30_000)) * 1_000_000n;
        cases.push({ freeCash: r(), totalOwed: r(), badDebt: r() / 10n, totalOriginated: r() });
      }
      for (const c of cases) {
        expect(Number(await guard.poolReasons(c))).to.equal(keeperLib.guardPoolReasons(c, DEFAULTS));
      }
    });

    it("creditStatus() shows the pool, the thresholds and the verdict in one read", async () => {
      await drainPool();
      const st = await s.guard.creditStatus();
      expect(st.paused).to.equal(true);
      expect(st.reasons).to.equal(LOW_CASH);
      expect(st.poolReasons).to.equal(LOW_CASH);
      expect(st.pool.freeCash).to.equal(USDC(500));
      expect([st.thresholds.minFreeCash, st.thresholds.maxBadDebtBps, st.thresholds.minOriginated]).to.deep.equal(tuple(DEFAULTS));
    });
  });

  // ---------------------------------------------------------------------
  describe("the owner's controls", () => {
    it("forces a pause over a healthy pool, forces a resume over a drained one, and hands back to the pool", async () => {
      await expect(s.guard.setOverride(OVERRIDE.FORCE_PAUSE, 0)).to.emit(s.guard, "CreditGuardOverridden").withArgs(OVERRIDE.FORCE_PAUSE, 0);
      expect(await s.checkout.creditPaused()).to.deep.equal([true, BigInt(OWNER_PAUSE)]);
      await drainPool();
      await resumeFor(s.guard);
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
      await s.guard.setOverride(OVERRIDE.NONE, 0);
      expect(await s.checkout.creditPaused()).to.deep.equal([true, BigInt(LOW_CASH)]);
    });

    it("a forced resume ends by itself, at most a day ahead; a pause and None take no end", async () => {
      await drainPool();
      await expect(s.guard.setOverride(OVERRIDE.FORCE_RESUME, (await now()) + BigInt(DAY) + 10n)).to.be.revertedWithCustomError(s.guard, "InvalidOverride");
      await expect(s.guard.setOverride(OVERRIDE.FORCE_RESUME, await now())).to.be.revertedWithCustomError(s.guard, "InvalidOverride");
      await expect(s.guard.setOverride(OVERRIDE.FORCE_PAUSE, 1)).to.be.revertedWithCustomError(s.guard, "InvalidOverride");
      await expect(s.guard.setOverride(OVERRIDE.NONE, 1)).to.be.revertedWithCustomError(s.guard, "InvalidOverride");
      await resumeFor(s.guard, 600);
      expect(await s.guard.activeOverride()).to.equal(OVERRIDE.FORCE_RESUME);
      await time.increase(700);
      expect(await s.guard.activeOverride()).to.equal(OVERRIDE.NONE);
      expect(await s.checkout.creditPaused()).to.deep.equal([true, BigInt(LOW_CASH)]);
    });

    it("sets the thresholds with an event, within sane bounds, and only the owner can", async () => {
      const t = { minFreeCash: USDC(10), maxBadDebtBps: 1_000, minOriginated: USDC(1) };
      await expect(s.guard.connect(s.stranger).setThresholds(t)).to.be.revertedWithCustomError(s.guard, "OwnableUnauthorizedAccount");
      await expect(s.guard.setThresholds({ ...t, maxBadDebtBps: 10_001 })).to.be.revertedWithCustomError(s.guard, "InvalidThresholds");
      await expect(s.guard.setThresholds(t)).to.emit(s.guard, "ThresholdsSet");
      expect(await s.guard.thresholds()).to.deep.equal(tuple(t));
      await drainPool(USDC(20));
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
    });

    it("the checkout's guardian is the owner's to set, must be a contract, and can be removed", async () => {
      await expect(s.checkout.setCreditGuardian(s.stranger.address)).to.be.revertedWithCustomError(s.checkout, "GuardianNotAContract");
      await drainPool();
      await expect(s.checkout.setCreditGuardian(ethers.ZeroAddress)).to.emit(s.checkout, "CreditGuardianSet").withArgs(ethers.ZeroAddress);
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
    });

    it("a guardian that reverts or answers nonsense fails open rather than blocking Pay in 4", async () => {
      await s.checkout.setCreditGuardian(s.usdc); // a contract with no isCreditPaused
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
      const buyer = await newBuyer();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.emit(s.checkout, "PlanOpened");
    });

    it("refuses construction without a pool, or with bad thresholds", async () => {
      const F = await ethers.getContractFactory("CreditGuard");
      await expect(F.deploy(s.owner.address, ethers.ZeroAddress, DEFAULTS)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(s.owner.address, s.engine, { ...DEFAULTS, maxBadDebtBps: 20_000 })).to.be.revertedWithCustomError(F, "InvalidThresholds");
    });
  });

  // ---------------------------------------------------------------------
  describe("the USDC peg, on a Chainlink USDC / USD feed", () => {
    const PRICE = (n) => ethers.parseUnits(String(n), 8);
    const { DEPEG, STALE_PRICE } = keeperLib.GUARD_REASON;
    let feed;

    beforeEach(async () => {
      feed = await (await ethers.getContractFactory("MockPriceFeed")).deploy();
      await feed.set(PRICE("0.9998"), await now());
      await s.guard.setPriceCheck(feed, PRICE("0.98"), 26 * 3600);
    });

    it("leaves credit open on a healthy peg, and says so in creditStatus", async () => {
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
      const st = await s.guard.creditStatus();
      expect(st.priceReasons).to.equal(0);
      expect(st.price).to.equal(PRICE("0.9998"));
      expect(st.priceFeed).to.equal(await feed.getAddress());
      expect(st.minPrice).to.equal(PRICE("0.98"));
    });

    it("pauses new plans on a depeg, read live, and resumes when the peg holds again", async () => {
      await feed.set(PRICE("0.97"), await now());
      expect(await s.checkout.creditPaused()).to.deep.equal([true, BigInt(DEPEG)]);
      const buyer = await newBuyer();
      await expect(s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)))).to.be.revertedWithCustomError(s.checkout, "CreditPausedByGuardian").withArgs(DEPEG);
      await feed.set(PRICE("0.99"), await now());
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
    });

    it("pauses on a stale, non-positive or unreadable price, and on every reason at once", async () => {
      await time.increase(27 * 3600);
      expect((await s.checkout.creditPaused())[1]).to.equal(BigInt(STALE_PRICE));
      await feed.set(0, await now());
      expect((await s.checkout.creditPaused())[1]).to.equal(BigInt(STALE_PRICE));
      await feed.set(PRICE("1"), await now());
      await feed.setBroken(true);
      expect((await s.checkout.creditPaused())[1]).to.equal(BigInt(STALE_PRICE));
      await feed.setBroken(false);
      await feed.set(PRICE("0.5"), await now());
      await drainPool();
      expect(await s.checkout.creditPaused()).to.deep.equal([true, BigInt(DEPEG | LOW_CASH)]);
    });

    it("only the owner sets the check, within bounds; zero turns it off", async () => {
      await expect(s.guard.connect(s.stranger).setPriceCheck(feed, 1, 60)).to.be.revertedWithCustomError(s.guard, "OwnableUnauthorizedAccount");
      await expect(s.guard.setPriceCheck(feed, 0, 60)).to.be.revertedWithCustomError(s.guard, "InvalidPriceCheck");
      await expect(s.guard.setPriceCheck(feed, 1, 8 * 24 * 3600)).to.be.revertedWithCustomError(s.guard, "InvalidPriceCheck");
      await feed.set(PRICE("0.5"), await now());
      await expect(s.guard.setPriceCheck(ethers.ZeroAddress, 0, 0)).to.emit(s.guard, "PriceCheckSet");
      expect(await s.checkout.creditPaused()).to.deep.equal([false, 0n]);
    });
  });

  // ---------------------------------------------------------------------
  describe("while credit is paused, everything else keeps working", () => {
    beforeEach(async () => {
      await s.guard.setOverride(OVERRIDE.FORCE_PAUSE, 0);
      expect((await s.checkout.creditPaused())[0]).to.equal(true);
    });

    it("Pay now", async () => {
      const buyer = await newBuyer();
      const orderId = "now-1";
      const pid = ethers.solidityPackedKeccak256(["address", "string"], [s.merchant.address, orderId]);
      const auth = await signReceive(s.usdc, buyer, await s.payments.getAddress(), USDC(25), pid);
      await expect(
        s.checkout.connect(s.relayer).pay(buyer.address, s.merchant.address, USDC(25), orderId, auth.validAfter, auth.validBefore, auth.v, auth.r, auth.s)
      ).to.emit(s.checkout, "CheckoutPaid");
    });

    it("Subscribe", async () => {
      const buyer = await newBuyer();
      await s.payments.connect(s.merchant).createPlan(USDC(10), MONTH, "Pro");
      const intent = {
        buyer: buyer.address, merchant: s.merchant.address, planId: 1n, pricePerPeriod: USDC(10),
        periodSeconds: BigInt(MONTH), orderId: "sub-1", nonce: 0n, deadline: (await now()) + 600n,
      };
      const p = await signPermit(s.usdc, buyer, await s.payments.getAddress(), USDC(120));
      const sig = (await signTyped(buyer, s.checkout, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent)).signature;
      await expect(s.checkout.connect(s.relayer).subscribe(intent, sig, { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s }))
        .to.emit(s.checkout, "SubscriptionStarted");
    });

    it("Send by link", async () => {
      const sender = await newBuyer();
      const linkKey = ethers.Wallet.createRandom();
      const amount = USDC(50);
      const expiresAt = (await now()) + BigInt(WEEK);
      const auth = await signReceive(s.usdc, sender, await s.send.getAddress(), amount, await s.send.sendNonce(linkKey.address, expiresAt), {
        validBefore: (await now()) + 1_800n,
      });
      const open = ethers.Signature.from(
        await linkKey.signTypedData(
          { name: "PolarisSend", version: "1", chainId: 31337, verifyingContract: await s.send.getAddress() },
          { Open: TYPES.PolarisSend.Open },
          { sender: sender.address, amount, expiresAt }
        )
      );
      await expect(
        s.send.connect(s.relayer).send(sender.address, linkKey.address, amount, expiresAt, auth.validAfter, auth.validBefore, auth.v, auth.r, auth.s, open.v, open.r, open.s)
      ).to.not.be.reverted;
      expect(await s.usdc.balanceOf(await s.send.getAddress())).to.equal(amount);
    });

    it("plans already open are still collected, repaid and re-signed", async () => {
      await s.guard.setOverride(OVERRIDE.NONE, 0);
      const buyer = await newBuyer();
      await s.checkout.connect(s.relayer).openPlan(...(await planArgs(buyer)));
      const loanId = await s.engine.loanCount();
      await s.guard.setOverride(OVERRIDE.FORCE_PAUSE, 0);
      await time.increase(WEEK);
      const tx = await s.collections.connect(s.keeper).submitReport(keeperLib.encodeCollectionsReport([{ action: keeperLib.ACTION.COLLECT_INSTALLMENT, id: loanId }]));
      await expect(tx).to.emit(s.collections, "TaskExecuted");
      await s.owner.sendTransaction({ to: buyer.address, value: ethers.parseEther("1") });
      await s.usdc.connect(buyer).approve(s.engine, 0);
      const owed = await s.engine.activeDebtOf(buyer.address);
      const p = await signPermit(s.usdc, buyer, await s.engine.getAddress(), owed, (await now()) + 600n);
      await expect(s.checkout.connect(s.relayer).reauthorize(buyer.address, { value: owed, deadline: p.deadline, v: p.v, r: p.r, s: p.s }))
        .to.emit(s.checkout, "Reauthorized");
    });
  });
});
