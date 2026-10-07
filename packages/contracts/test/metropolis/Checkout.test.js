/**
 * PolarisCheckout: Pay now, Pay in 4 and Subscribe, each from the buyer's
 * signatures alone. Every buyer here is a fresh wallet that never holds MON,
 * and every transaction is sent by a relayer, so a passing test proves the
 * flow needs nothing from the buyer but a signature. Tests are named for the
 * attack they refuse.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { MAX_UINT, signTyped, signPermit, signReceive, paymentId } = require("../helpers/sign");
const { TYPES } = require("../../lib/eip712");

const AUSD = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const ZERO_PERMIT = { value: 0n, deadline: 0n, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash };

async function deployStack(tokenName = "MockAUSD") {
  const [owner, relayer, merchant, rival, treasury, stranger] = await ethers.getSigners();
  const ausd = await (await ethers.getContractFactory(tokenName)).deploy();
  const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
  const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(
    owner.address, ausd, scores, treasury.address, 0, 60
  );
  const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(
    owner.address, ausd, treasury.address, 60
  );
  const registry = await (await ethers.getContractFactory("MerchantRegistry")).deploy(owner.address);
  const checkout = await (await ethers.getContractFactory("PolarisCheckout")).deploy(
    owner.address, engine, payments, scores
  );

  await scores.setWriter(engine, true);
  await engine.setOriginator(checkout, true);
  await engine.setMerchantRegistry(registry);
  await payments.setCheckout(checkout);

  await registry.connect(merchant).register("Studio", merchant.address, "");
  await registry.setActive(merchant.address, true);
  await registry.setMaxOrderValue(merchant.address, AUSD(5_000));

  await ausd.mint(owner.address, AUSD(100_000));
  await ausd.approve(engine, AUSD(100_000));
  await engine.fund(AUSD(50_000));

  const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
  await ausd.mint(buyer.address, AUSD(2_000));

  return { ausd, scores, engine, payments, registry, checkout, owner, relayer, merchant, rival, treasury, stranger, buyer };
}

describe("PolarisCheckout", () => {
  let s; // the deployed stack

  beforeEach(async () => {
    s = await loadFixture(deployStack);
  });

  const now = async () => BigInt(await time.latest());

  async function planIntent(overrides = {}) {
    const buyer = overrides.buyer ?? s.buyer.address;
    return {
      buyer,
      merchant: s.merchant.address,
      principal: AUSD(200),
      installments: 4,
      interval: BigInt(WEEK),
      orderId: `order-${Math.random().toString(36).slice(2)}`,
      nonce: await s.checkout.nonces(buyer),
      deadline: (await now()) + 600n,
      ...overrides,
    };
  }

  async function signPlan(signer, intent) {
    return (await signTyped(signer, s.checkout, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, intent)).signature;
  }

  /** The buyer's permit to `spender`, shaped as openPlan/subscribe take it. */
  async function permitTo(signer, spender, value) {
    const p = await signPermit(s.ausd, signer, typeof spender === "string" ? spender : await spender.getAddress(), value);
    return { value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s };
  }

  /** Sign everything for one plan (intent + permit sized by quotePlan) and relay it. */
  async function openPlan(signer = s.buyer, overrides = {}) {
    const intent = await planIntent({ buyer: signer.address, ...overrides });
    const q = await s.checkout.quotePlan(signer.address, intent.principal, intent.installments, intent.interval);
    const sig = await signPlan(signer, intent);
    const permit = await permitTo(signer, s.engine, q.permitValue);
    const tx = s.checkout.connect(s.relayer).openPlan(intent, sig, permit);
    return { intent, sig, permit, quote: q, tx };
  }

  // ---------------------------------------------------------------------
  describe("construction", () => {
    it("refuses a payments contract on another token, a mismatched ScoreManager, or a missing part", async () => {
      const F = await ethers.getContractFactory("PolarisCheckout");
      const other = await (await ethers.getContractFactory("MockAUSD")).deploy();
      const otherPayments = await (await ethers.getContractFactory("PolarisPayments")).deploy(
        s.owner.address, other, s.treasury.address, 60
      );
      const otherScores = await (await ethers.getContractFactory("ScoreManager")).deploy(s.owner.address);
      await expect(F.deploy(s.owner.address, s.engine, otherPayments, s.scores)).to.be.revertedWithCustomError(F, "WrongStablecoin");
      await expect(F.deploy(s.owner.address, s.engine, s.payments, otherScores)).to.be.revertedWithCustomError(F, "WrongScoreManager");
      await expect(F.deploy(s.owner.address, s.engine, s.payments, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });

    it("exposes its wiring and the EIP-712 domain clients sign under", async () => {
      expect(await s.checkout.stablecoin()).to.equal(await s.ausd.getAddress());
      expect(await s.checkout.loanEngine()).to.equal(await s.engine.getAddress());
      expect(await s.checkout.payments()).to.equal(await s.payments.getAddress());
      expect(await s.checkout.scoreManager()).to.equal(await s.scores.getAddress());
      const d = await s.checkout.eip712Domain();
      expect(d.name).to.equal("PolarisCheckout");
      expect(d.version).to.equal("1");
      expect(d.chainId).to.equal(31337n);
      expect(d.verifyingContract).to.equal(await s.checkout.getAddress());
    });
  });

  // ---------------------------------------------------------------------
  describe("Pay in 4", () => {
    it("a buyer opens a plan with two signatures and nothing else, and the merchant is paid the whole principal at once", async () => {
      const merchantBefore = await s.ausd.balanceOf(s.merchant.address);
      const poolBefore = await s.ausd.balanceOf(s.engine);
      const { intent, quote, tx } = await openPlan();
      const key = paymentId(s.merchant.address, intent.orderId);
      const opened = await (await tx).wait();
      const startedAt = BigInt((await ethers.provider.getBlock(opened.blockNumber)).timestamp);

      await expect(tx)
        .to.emit(s.checkout, "PlanOpened")
        .withArgs(key, s.merchant.address, s.buyer.address, 1n, intent.orderId, AUSD(200), quote.totalOwed, 4, WEEK, startedAt + BigInt(WEEK))
        .and.to.emit(s.engine, "LoanCreated")
        .withArgs(1n, s.buyer.address, s.merchant.address, AUSD(200), quote.totalOwed, 4);

      expect(await s.ausd.balanceOf(s.merchant.address)).to.equal(merchantBefore + AUSD(200), "paid in full, now");
      expect(await s.ausd.balanceOf(s.engine)).to.equal(poolBefore - AUSD(200), "from the credit pool");
      expect(await s.ausd.balanceOf(s.buyer.address)).to.equal(AUSD(2_000), "the buyer pays nothing at checkout");
      expect(await s.ausd.allowance(s.buyer.address, s.engine)).to.equal(quote.permitValue);
      expect(await ethers.provider.getBalance(s.buyer.address)).to.equal(0n, "the buyer never held gas");

      const loan = await s.engine.getLoan(1);
      expect(loan.borrower).to.equal(s.buyer.address);
      expect(loan.merchant).to.equal(s.merchant.address);
      const order = await s.checkout.orderOf(s.merchant.address, intent.orderId);
      expect(order.kind).to.equal(2n); // PayIn4
      expect(order.buyer).to.equal(s.buyer.address);
      expect(order.amount).to.equal(AUSD(200));
      expect(order.ref).to.equal(1n);
      expect(order.settledAt).to.equal(startedAt);
      expect(await s.checkout.nonces(s.buyer.address)).to.equal(1n);
    });

    it("prices a plan exactly as the engine does: $200 in 4 weekly is 4 x $50.38, $1.53 interest", async () => {
      const q = await s.checkout.quotePlan(s.buyer.address, AUSD(200), 4, WEEK);
      expect(q.interest).to.equal(1_534_246n);
      expect(q.totalOwed).to.equal(AUSD(200) + 1_534_246n);
      expect(q.installmentAmount).to.equal(50_383_562n); // $50.38
      expect(q.creditLimit).to.equal(AUSD(500)); // STARTING_SCORE tier
      expect(q.activeDebt).to.equal(0n);
      expect(q.available).to.equal(AUSD(500));
      expect(q.withinLimit).to.equal(true);
      expect(q.permitValue).to.equal(q.totalOwed);

      await (await openPlan()).tx;
      const loan = await s.engine.getLoan(1);
      expect(loan.totalOwed).to.equal(q.totalOwed);
      expect(await s.engine.installmentAmount(1)).to.equal(q.installmentAmount);

      // A second plan's permit must cover the first as well: permits replace allowances.
      const q2 = await s.checkout.quotePlan(s.buyer.address, AUSD(100), 4, WEEK);
      expect(q2.activeDebt).to.equal(q.totalOwed);
      expect(q2.permitValue).to.equal(q.totalOwed + q2.totalOwed);
      expect(q2.available).to.equal(AUSD(500) - q.totalOwed);
      const q3 = await s.checkout.quotePlan(s.buyer.address, AUSD(400), 4, WEEK);
      expect(q3.withinLimit).to.equal(false);
    });

    it("takes nothing from the buyer at checkout: the first of four instalments falls due one interval later", async () => {
      // What the app and the SDK must disclose. There is no down payment, so
      // no "paid today" row: instalment i falls due at start + (i + 1) * interval,
      // and the amounts follow the engine's ceiling ladder, not floor plus a
      // remainder on the last.
      const before = await s.ausd.balanceOf(s.buyer.address);
      const { tx } = await openPlan();
      const receipt = await (await tx).wait();
      const startedAt = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
      expect(await s.ausd.balanceOf(s.buyer.address)).to.equal(before, "nothing collected at checkout");

      const opened = receipt.logs.map((l) => { try { return s.checkout.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "PlanOpened");
      expect(opened.args.firstDueAt).to.equal(startedAt + BigInt(WEEK));
      for (let i = 0; i < 4; i++) {
        expect(await s.engine.installmentDueAt(1, i)).to.equal(startedAt + BigInt((i + 1) * WEEK));
      }
      const steps = [];
      for (let k = 1; k <= 4; k++) steps.push((await s.engine.thresholdFor(1, k)) - (await s.engine.thresholdFor(1, k - 1)));
      expect(steps).to.deep.equal([50_383_562n, 50_383_561n, 50_383_562n, 50_383_561n]);
      expect(await s.engine.isInstallmentDue(1)).to.equal(false);
    });

    it("a second plan opens with a permit sized for both, and the first keeps its allowance", async () => {
      const first = await openPlan();
      await first.tx;
      const second = await openPlan(s.buyer, { principal: AUSD(100) });
      await expect(second.tx).to.emit(s.checkout, "PlanOpened");
      expect(await s.ausd.allowance(s.buyer.address, s.engine)).to.equal(first.quote.totalOwed + second.quote.totalOwed);
      expect(await s.engine.activeDebtOf(s.buyer.address)).to.equal(first.quote.totalOwed + second.quote.totalOwed);
    });

    it("a relayer cannot open a plan the buyer did not sign", async () => {
      const intent = await planIntent();
      const q = await s.checkout.quotePlan(s.buyer.address, intent.principal, 4, WEEK);
      const permit = await permitTo(s.buyer, s.engine, q.permitValue);
      const forger = ethers.Wallet.createRandom();

      // Signed by someone else entirely.
      await expect(
        s.checkout.connect(s.relayer).openPlan(intent, await signPlan(forger, intent), permit)
      ).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");

      // The buyer's signature, with any one term changed by the relayer.
      const sig = await signPlan(s.buyer, intent);
      for (const change of [
        { merchant: s.rival.address },
        { principal: AUSD(300) },
        { installments: 2 },
        { interval: BigInt(DAY) },
        { orderId: "someone-elses-order" },
        { deadline: intent.deadline - 1n },
        { buyer: s.stranger.address },
      ]) {
        await expect(
          s.checkout.connect(s.relayer).openPlan({ ...intent, ...change }, sig, permit)
        ).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");
      }
      // Garbage is refused the same way, not with a library error.
      await expect(
        s.checkout.connect(s.relayer).openPlan(intent, "0x1234", permit)
      ).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");

      expect(await s.engine.loanCount()).to.equal(0n);
      await expect(s.checkout.connect(s.relayer).openPlan(intent, sig, permit)).to.emit(s.checkout, "PlanOpened");
    });

    it("a replayed intent cannot open a second plan, and a settled order cannot be opened again", async () => {
      const { intent, sig, permit, tx } = await openPlan();
      await tx;
      await expect(s.checkout.connect(s.relayer).openPlan(intent, sig, permit))
        .to.be.revertedWithCustomError(s.checkout, "InvalidAccountNonce")
        .withArgs(s.buyer.address, 1n);

      // Freshly signed, but for the same order.
      const again = await planIntent({ orderId: intent.orderId });
      await expect(
        s.checkout.connect(s.relayer).openPlan(again, await signPlan(s.buyer, again), ZERO_PERMIT)
      )
        .to.be.revertedWithCustomError(s.checkout, "OrderAlreadySettled")
        .withArgs(paymentId(s.merchant.address, intent.orderId));
      expect(await s.engine.loanCount()).to.equal(1n);
    });

    it("a replayed permit cannot open a second plan: the allowance it set backs the first plan only", async () => {
      const first = await openPlan();
      await first.tx;
      const intent = await planIntent({ principal: AUSD(100) });
      await expect(
        s.checkout.connect(s.relayer).openPlan(intent, await signPlan(s.buyer, intent), first.permit)
      ).to.be.revertedWithCustomError(s.engine, "InsufficientAllowance");
      expect(await s.engine.loanCount()).to.equal(1n);
    });

    it("a permit someone else submitted first does not block the plan", async () => {
      const intent = await planIntent();
      const q = await s.checkout.quotePlan(s.buyer.address, intent.principal, 4, WEEK);
      const permit = await permitTo(s.buyer, s.engine, q.permitValue);
      await s.ausd
        .connect(s.stranger)
        .permit(s.buyer.address, s.engine, permit.value, permit.deadline, permit.v, permit.r, permit.s);

      await expect(
        s.checkout.connect(s.relayer).openPlan(intent, await signPlan(s.buyer, intent), permit)
      ).to.emit(s.checkout, "PlanOpened");
    });

    it("an intent past its deadline, or signed to outlive the one-hour window, is refused", async () => {
      const t = await now();
      const late = await planIntent({ deadline: t });
      await time.increase(5);
      await expect(
        s.checkout.connect(s.relayer).openPlan(late, await signPlan(s.buyer, late), ZERO_PERMIT)
      ).to.be.revertedWithCustomError(s.checkout, "SignatureExpired");

      const tooLong = await planIntent({ deadline: (await now()) + 3600n + 60n });
      await expect(
        s.checkout.connect(s.relayer).openPlan(tooLong, await signPlan(s.buyer, tooLong), ZERO_PERMIT)
      ).to.be.revertedWithCustomError(s.checkout, "SignatureWindowTooLong");
    });

    it("a buyer who changes their mind retires a signed intent with invalidateNonce", async () => {
      // A buyer who happens to hold gas.
      const buyer = s.stranger;
      await s.ausd.mint(buyer.address, AUSD(1_000));
      const intent = await planIntent({ buyer: buyer.address });
      const sig = await signPlan(buyer, intent);
      const q = await s.checkout.quotePlan(buyer.address, intent.principal, 4, WEEK);
      const permit = await permitTo(buyer, s.engine, q.permitValue);

      await expect(s.checkout.connect(buyer).invalidateNonce())
        .to.emit(s.checkout, "NonceInvalidated")
        .withArgs(buyer.address, 0n);
      await expect(s.checkout.connect(s.relayer).openPlan(intent, sig, permit))
        .to.be.revertedWithCustomError(s.checkout, "InvalidAccountNonce")
        .withArgs(buyer.address, 1n);
    });

    it("the credit line decides: a plan beyond what the buyer may draw is refused", async () => {
      const { tx } = await openPlan(s.buyer, { principal: AUSD(499) }); // + $3.83 interest > $500
      await expect(tx).to.be.revertedWithCustomError(s.engine, "ExceedsCreditLimit");
      // Once underwriting is required, a buyer with no DON report gets nothing unsecured.
      await s.scores.setRequireUnderwriting(true);
      const { tx: tx2 } = await openPlan(s.buyer, { principal: AUSD(20) });
      await expect(tx2).to.be.revertedWithCustomError(s.engine, "ExceedsCreditLimit");
    });

    it("pays in 4 only merchants the registry has activated, up to their cap", async () => {
      const { tx } = await openPlan(s.buyer, { merchant: s.rival.address });
      await expect(tx).to.be.revertedWithCustomError(s.engine, "MerchantNotEligible");
      await s.registry.setMaxOrderValue(s.merchant.address, AUSD(100));
      const { tx: tx2 } = await openPlan(s.buyer, { principal: AUSD(150) });
      await expect(tx2).to.be.revertedWithCustomError(s.engine, "MerchantNotEligible");
    });

    it("refuses an interval under the deployment's minimum, and a schedule the engine cannot run", async () => {
      await expect((await openPlan(s.buyer, { interval: 59n })).tx).to.be.revertedWithCustomError(s.engine, "InvalidInterval");
      await expect((await openPlan(s.buyer, { installments: 0 })).tx).to.be.revertedWithCustomError(s.engine, "InvalidInstallments");
      await expect((await openPlan(s.buyer, { principal: 0n })).tx).to.be.revertedWithCustomError(s.engine, "ZeroAmount");
    });

    it("refuses an empty order id and a zero buyer or merchant", async () => {
      await expect((await openPlan(s.buyer, { orderId: "" })).tx).to.be.revertedWithCustomError(s.checkout, "EmptyOrderId");
      const intent = await planIntent({ merchant: ethers.ZeroAddress });
      await expect(
        s.checkout.connect(s.relayer).openPlan(intent, await signPlan(s.buyer, intent), ZERO_PERMIT)
      ).to.be.revertedWithCustomError(s.checkout, "ZeroAddress");
    });

    it("a quoted order can only be paid in 4 at its quoted price", async () => {
      const intent = await planIntent({ principal: AUSD(150) });
      const key = paymentId(s.merchant.address, intent.orderId);
      await s.payments.connect(s.merchant).quoteOrder(s.merchant.address, key, AUSD(200));
      await expect(
        s.checkout.connect(s.relayer).openPlan(intent, await signPlan(s.buyer, intent), ZERO_PERMIT)
      )
        .to.be.revertedWithCustomError(s.checkout, "WrongAmount")
        .withArgs(AUSD(200), AUSD(150));
      await expect((await openPlan(s.buyer, { orderId: intent.orderId, principal: AUSD(200) })).tx).to.emit(s.checkout, "PlanOpened");
    });

    it("only the checkout originates plans: the relayer, the owner and strangers are refused by the engine", async () => {
      for (const who of [s.relayer, s.owner, s.stranger]) {
        await expect(
          s.engine.connect(who).createLoan(s.buyer.address, s.merchant.address, AUSD(10), 4, WEEK)
        ).to.be.revertedWithCustomError(s.engine, "NotOriginator");
      }
    });

    it("a smart-account buyer (ERC-1271) opens a plan against its standing allowance, with no permit", async () => {
      const key = ethers.Wallet.createRandom().connect(ethers.provider);
      const account = await (await ethers.getContractFactory("SmartAccount")).deploy(key.address);
      const addr = await account.getAddress();
      await s.ausd.mint(addr, AUSD(1_000));
      await s.owner.sendTransaction({ to: key.address, value: ethers.parseEther("1") }); // the account's owner sends one approve
      const q = await s.checkout.quotePlan(addr, AUSD(200), 4, WEEK);
      await account.connect(key).execute(await s.ausd.getAddress(), s.ausd.interface.encodeFunctionData("approve", [await s.engine.getAddress(), q.permitValue]));

      const intent = await planIntent({ buyer: addr });
      await expect(
        s.checkout.connect(s.relayer).openPlan(intent, await signPlan(ethers.Wallet.createRandom(), intent), ZERO_PERMIT)
      ).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");
      await expect(s.checkout.connect(s.relayer).openPlan(intent, await signPlan(key, intent), ZERO_PERMIT))
        .to.emit(s.checkout, "PlanOpened")
        .withArgs(paymentId(s.merchant.address, intent.orderId), s.merchant.address, addr, 1n, intent.orderId, AUSD(200), q.totalOwed, 4, WEEK, (x) => x > 0n);
    });

    it("the digest view is exactly what the buyer signs", async () => {
      const intent = await planIntent();
      const domain = await s.checkout.eip712Domain();
      const expected = ethers.TypedDataEncoder.hash(
        { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
        { PlanIntent: TYPES.PolarisCheckout.PlanIntent },
        intent
      );
      expect(await s.checkout.planIntentDigest(intent)).to.equal(expected);
    });
  });

  // ---------------------------------------------------------------------
  describe("Pay now", () => {
    async function authorize(signer, merchant, orderId, amount, opts) {
      return signReceive(s.ausd, signer, await s.payments.getAddress(), amount, paymentId(merchant, orderId), opts);
    }

    function relayPay(buyer, merchant, orderId, a, amount = a.value) {
      return s.checkout
        .connect(s.relayer)
        .pay(buyer, merchant, amount, orderId, a.validAfter, a.validBefore, a.v, a.r, a.s);
    }

    it("a buyer pays an order with one signature; CheckoutPaid and PaymentMade agree", async () => {
      const a = await authorize(s.buyer, s.merchant.address, "INV-1", AUSD(200));
      const key = paymentId(s.merchant.address, "INV-1");
      const before = await s.ausd.balanceOf(s.merchant.address);

      const tx = relayPay(s.buyer.address, s.merchant.address, "INV-1", a);
      await expect(tx)
        .to.emit(s.checkout, "CheckoutPaid")
        .withArgs(key, s.merchant.address, s.buyer.address, "INV-1", AUSD(200), AUSD(1))
        .and.to.emit(s.payments, "PaymentMade")
        .withArgs(key, s.buyer.address, s.merchant.address, AUSD(200), AUSD(1), "INV-1");

      expect(await s.ausd.balanceOf(s.merchant.address)).to.equal(before + AUSD(199));
      expect(await s.ausd.balanceOf(s.treasury.address)).to.equal(AUSD(1));
      expect(await s.ausd.balanceOf(await s.checkout.getAddress())).to.equal(0n);
      const order = await s.checkout.orderOf(s.merchant.address, "INV-1");
      expect(order.kind).to.equal(1n); // PayNow
      expect(order.buyer).to.equal(s.buyer.address);
      expect(order.amount).to.equal(AUSD(200));
      expect(await ethers.provider.getBalance(s.buyer.address)).to.equal(0n);
    });

    it("a relayer cannot redirect a payment to another merchant, another order or another amount", async () => {
      const a = await authorize(s.buyer, s.merchant.address, "INV-1", AUSD(200));
      await expect(relayPay(s.buyer.address, s.rival.address, "INV-1", a)).to.be.revertedWithCustomError(s.ausd, "InvalidAuthorizationSignature");
      await expect(relayPay(s.buyer.address, s.merchant.address, "INV-2", a)).to.be.revertedWithCustomError(s.ausd, "InvalidAuthorizationSignature");
      await expect(relayPay(s.buyer.address, s.merchant.address, "INV-1", a, AUSD(300))).to.be.revertedWithCustomError(s.ausd, "InvalidAuthorizationSignature");
      expect((await s.checkout.orderOf(s.rival.address, "INV-1")).kind).to.equal(0n, "a failed payment settles nothing");
      await expect(relayPay(s.buyer.address, s.merchant.address, "INV-1", a)).to.emit(s.checkout, "CheckoutPaid");
    });

    it("a replayed authorization cannot pay an order twice", async () => {
      const a = await authorize(s.buyer, s.merchant.address, "INV-1", AUSD(50));
      await relayPay(s.buyer.address, s.merchant.address, "INV-1", a);
      await expect(relayPay(s.buyer.address, s.merchant.address, "INV-1", a)).to.be.revertedWithCustomError(s.checkout, "OrderAlreadySettled");
    });

    it("an order is settled once, in one mode: paid now it cannot become a plan, and a plan cannot be paid now", async () => {
      // Paid now through the checkout.
      const a = await authorize(s.buyer, s.merchant.address, "INV-1", AUSD(200));
      await relayPay(s.buyer.address, s.merchant.address, "INV-1", a);
      await expect((await openPlan(s.buyer, { orderId: "INV-1" })).tx).to.be.revertedWithCustomError(s.checkout, "OrderAlreadySettled");

      // Paid directly on PolarisPayments with the same kind of authorization: the checkout still sees it.
      const b = await authorize(s.buyer, s.merchant.address, "INV-2", AUSD(200));
      await s.payments
        .connect(s.relayer)
        .payWithAuthorization(s.buyer.address, s.merchant.address, AUSD(200), "INV-2", b.validAfter, b.validBefore, b.v, b.r, b.s);
      await expect((await openPlan(s.buyer, { orderId: "INV-2" })).tx).to.be.revertedWithCustomError(s.checkout, "OrderAlreadySettled");

      // Opened as a plan: it cannot then be paid now as well.
      await (await openPlan(s.buyer, { orderId: "INV-3" })).tx;
      const c = await authorize(s.buyer, s.merchant.address, "INV-3", AUSD(200));
      await expect(relayPay(s.buyer.address, s.merchant.address, "INV-3", c)).to.be.revertedWithCustomError(s.checkout, "OrderAlreadySettled");
    });

    it("a Pay now authorization left over from a timed-out relay cannot charge a buyer whose order became a plan", async () => {
      // The buyer signs Pay now for INV-42; the relay times out and the
      // authorization is never submitted. The buyer then chooses Pay in 4.
      const a = await authorize(s.buyer, s.merchant.address, "INV-42", AUSD(200));
      await (await openPlan(s.buyer, { orderId: "INV-42" })).tx;
      const key = paymentId(s.merchant.address, "INV-42");
      expect((await s.checkout.orderOf(s.merchant.address, "INV-42")).kind).to.equal(2n); // PayIn4
      expect(await s.payments.settledByCheckout(key)).to.equal(true);

      // A stranger submits the old authorization straight to PolarisPayments.
      await expect(
        s.payments
          .connect(s.stranger)
          .payWithAuthorization(s.buyer.address, s.merchant.address, AUSD(200), "INV-42", a.validAfter, a.validBefore, a.v, a.r, a.s)
      )
        .to.be.revertedWithCustomError(s.payments, "OrderAlreadySettled")
        .withArgs(key);
      // Nor can anyone record a payment on it with `pay`, or re-price it.
      await s.ausd.mint(s.stranger.address, AUSD(200));
      await s.ausd.connect(s.stranger).approve(s.payments, AUSD(200));
      await expect(s.payments.connect(s.stranger).pay(s.merchant.address, AUSD(200), "INV-42"))
        .to.be.revertedWithCustomError(s.payments, "OrderAlreadySettled")
        .withArgs(key);
      await expect(s.payments.connect(s.merchant).quoteOrder(s.merchant.address, key, AUSD(1)))
        .to.be.revertedWithCustomError(s.payments, "OrderAlreadySettled")
        .withArgs(key);

      expect(await s.ausd.balanceOf(s.buyer.address)).to.equal(AUSD(2_000), "charged only by the plan's instalments");
      expect((await s.payments.paymentFor(s.merchant.address, "INV-42")).paidAt).to.equal(0n);
    });

    it("a leftover Pay now authorization cannot charge a buyer whose order became a subscription", async () => {
      await s.payments.connect(s.merchant).createPlan(AUSD(10), MONTH, "Pro");
      const planId = await s.payments.planCount();
      const a = await authorize(s.buyer, s.merchant.address, "SUB-7", AUSD(10));
      const intent = {
        buyer: s.buyer.address,
        merchant: s.merchant.address,
        planId,
        pricePerPeriod: AUSD(10),
        periodSeconds: BigInt(MONTH),
        orderId: "SUB-7",
        nonce: await s.checkout.nonces(s.buyer.address),
        deadline: (await now()) + 600n,
      };
      const sig = (await signTyped(s.buyer, s.checkout, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent)).signature;
      await s.checkout.connect(s.relayer).subscribe(intent, sig, await permitTo(s.buyer, s.payments, AUSD(120)));
      const afterFirstPeriod = await s.ausd.balanceOf(s.buyer.address);

      await expect(
        s.payments
          .connect(s.stranger)
          .payWithAuthorization(s.buyer.address, s.merchant.address, AUSD(10), "SUB-7", a.validAfter, a.validBefore, a.v, a.r, a.s)
      ).to.be.revertedWithCustomError(s.payments, "OrderAlreadySettled");
      expect(await s.ausd.balanceOf(s.buyer.address)).to.equal(afterFirstPeriod);
    });

    it("the record of a plan's order lives on PolarisPayments, so it outlasts replacing or switching off the checkout", async () => {
      const a = await authorize(s.buyer, s.merchant.address, "INV-9", AUSD(200));
      const { intent } = await openPlan(s.buyer, { orderId: "INV-9" });
      const key = paymentId(s.merchant.address, "INV-9");
      const submit = () =>
        s.payments
          .connect(s.stranger)
          .payWithAuthorization(s.buyer.address, s.merchant.address, AUSD(200), "INV-9", a.validAfter, a.validBefore, a.v, a.r, a.s);

      // A new checkout sees the order settled, though its own book is empty.
      const next = await (await ethers.getContractFactory("PolarisCheckout")).deploy(s.owner.address, s.engine, s.payments, s.scores);
      await s.payments.setCheckout(next);
      await s.engine.setOriginator(next, true);
      const again = { ...(await planIntent({ orderId: intent.orderId })), nonce: await next.nonces(s.buyer.address) };
      const againSig = (await signTyped(s.buyer, next, { PlanIntent: TYPES.PolarisCheckout.PlanIntent }, again)).signature;
      await expect(next.connect(s.relayer).openPlan(again, againSig, ZERO_PERMIT))
        .to.be.revertedWithCustomError(next, "OrderAlreadySettled")
        .withArgs(key);
      await expect(submit()).to.be.revertedWithCustomError(s.payments, "OrderAlreadySettled");

      // Switching relayed checkouts off does not reopen it either.
      await s.payments.setCheckout(ethers.ZeroAddress);
      await expect(submit()).to.be.revertedWithCustomError(s.payments, "OrderAlreadySettled");
      expect(await s.ausd.balanceOf(s.buyer.address)).to.equal(AUSD(2_000));
    });

    it("only the appointed checkout can mark an order settled; a replaced one can no longer open plans", async () => {
      const key = paymentId(s.merchant.address, "INV-X");
      for (const who of [s.stranger, s.relayer, s.owner, s.merchant]) {
        await expect(s.payments.connect(who).markSettledByCheckout(key)).to.be.revertedWithCustomError(s.payments, "NotCheckout");
      }
      // An order already paid cannot be marked, so a plan can never be opened on it.
      const a = await authorize(s.buyer, s.merchant.address, "INV-X", AUSD(200));
      await s.payments
        .connect(s.relayer)
        .payWithAuthorization(s.buyer.address, s.merchant.address, AUSD(200), "INV-X", a.validAfter, a.validBefore, a.v, a.r, a.s);
      const checkoutAddr = await s.checkout.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [checkoutAddr]);
      await ethers.provider.send("hardhat_setBalance", [checkoutAddr, "0xDE0B6B3A7640000"]);
      const asCheckout = await ethers.getSigner(checkoutAddr);
      await expect(s.payments.connect(asCheckout).markSettledByCheckout(key))
        .to.be.revertedWithCustomError(s.payments, "OrderAlreadySettled")
        .withArgs(key);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [checkoutAddr]);

      // Once PolarisPayments no longer names it, the old checkout's plans are refused.
      await s.payments.setCheckout(ethers.ZeroAddress);
      await expect((await openPlan()).tx).to.be.revertedWithCustomError(s.payments, "NotCheckout");
      expect(await s.engine.loanCount()).to.equal(0n);
    });

    it("a quoted order can only be paid now at its price", async () => {
      await s.payments.connect(s.merchant).quoteOrder(s.merchant.address, paymentId(s.merchant.address, "INV-Q"), AUSD(80));
      const a = await authorize(s.buyer, s.merchant.address, "INV-Q", AUSD(1));
      await expect(relayPay(s.buyer.address, s.merchant.address, "INV-Q", a))
        .to.be.revertedWithCustomError(s.checkout, "WrongAmount")
        .withArgs(AUSD(80), AUSD(1));
    });
  });

  // ---------------------------------------------------------------------
  describe("Subscribe", () => {
    let planId;

    beforeEach(async () => {
      await s.payments.connect(s.merchant).createPlan(AUSD(10), MONTH, "Pro");
      planId = await s.payments.planCount();
    });

    async function subIntent(overrides = {}) {
      const buyer = overrides.buyer ?? s.buyer.address;
      return {
        buyer,
        merchant: s.merchant.address,
        planId,
        pricePerPeriod: AUSD(10),
        periodSeconds: BigInt(MONTH),
        orderId: `sub-${Math.random().toString(36).slice(2)}`,
        nonce: await s.checkout.nonces(buyer),
        deadline: (await now()) + 600n,
        ...overrides,
      };
    }

    async function signSub(signer, intent) {
      return (await signTyped(signer, s.checkout, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent)).signature;
    }

    it("a buyer subscribes with an intent and a year's permit; period one is charged and renewals draw on schedule", async () => {
      const intent = await subIntent();
      const permit = await permitTo(s.buyer, s.payments, AUSD(120));
      const merchantBefore = await s.ausd.balanceOf(s.merchant.address);

      const tx = s.checkout.connect(s.relayer).subscribe(intent, await signSub(s.buyer, intent), permit);
      const receipt = await (await tx).wait();
      const at = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
      await expect(tx)
        .to.emit(s.checkout, "SubscriptionStarted")
        .withArgs(paymentId(s.merchant.address, intent.orderId), s.merchant.address, s.buyer.address, 1n, planId, intent.orderId, AUSD(10), MONTH, at + BigInt(MONTH))
        .and.to.emit(s.payments, "Subscribed")
        .withArgs(1n, planId, s.buyer.address);

      expect(await s.ausd.balanceOf(s.merchant.address)).to.equal(merchantBefore + AUSD(9.95));
      expect(await s.ausd.allowance(s.buyer.address, s.payments)).to.equal(AUSD(110));
      const order = await s.checkout.orderOf(s.merchant.address, intent.orderId);
      expect(order.kind).to.equal(3n); // Subscription
      expect(order.ref).to.equal(1n);

      await time.increase(MONTH);
      await expect(s.payments.connect(s.stranger).chargeDue(1)).to.emit(s.payments, "SubscriptionCharged").withArgs(1n, AUSD(10), AUSD(0.05), 2);
      expect(await ethers.provider.getBalance(s.buyer.address)).to.equal(0n);
    });

    it("a relayer cannot swap in another plan, or subscribe the buyer at terms they did not sign", async () => {
      await s.payments.connect(s.merchant).createPlan(AUSD(500), MONTH, "Pricier");
      const pricier = await s.payments.planCount();
      const intent = await subIntent();
      const sig = await signSub(s.buyer, intent);
      const permit = await permitTo(s.buyer, s.payments, AUSD(1_000));

      // The plan id is signed.
      await expect(
        s.checkout.connect(s.relayer).subscribe({ ...intent, planId: pricier }, sig, permit)
      ).to.be.revertedWithCustomError(s.checkout, "InvalidSignature");

      // A buyer who signed the pricier plan's id at the cheap plan's terms is refused, not charged $500.
      const mismatched = await subIntent({ planId: pricier });
      await expect(
        s.checkout.connect(s.relayer).subscribe(mismatched, await signSub(s.buyer, mismatched), permit)
      ).to.be.revertedWithCustomError(s.checkout, "PlanMismatch").withArgs(pricier);

      // Another merchant's name on the same plan.
      const otherMerchant = await subIntent({ merchant: s.rival.address });
      await expect(
        s.checkout.connect(s.relayer).subscribe(otherMerchant, await signSub(s.buyer, otherMerchant), permit)
      ).to.be.revertedWithCustomError(s.checkout, "PlanMismatch");
      // A different period.
      const otherPeriod = await subIntent({ periodSeconds: BigInt(WEEK) });
      await expect(
        s.checkout.connect(s.relayer).subscribe(otherPeriod, await signSub(s.buyer, otherPeriod), permit)
      ).to.be.revertedWithCustomError(s.checkout, "PlanMismatch");

      expect(await s.payments.subscriptionCount()).to.equal(0n);
    });

    it("a replayed subscribe intent is refused, and a retired plan cannot be joined", async () => {
      const intent = await subIntent();
      const sig = await signSub(s.buyer, intent);
      const permit = await permitTo(s.buyer, s.payments, AUSD(120));
      await s.checkout.connect(s.relayer).subscribe(intent, sig, permit);
      await expect(s.checkout.connect(s.relayer).subscribe(intent, sig, permit)).to.be.revertedWithCustomError(s.checkout, "InvalidAccountNonce");

      await s.payments.connect(s.merchant).deactivatePlan(planId);
      const late = await subIntent();
      await expect(
        s.checkout.connect(s.relayer).subscribe(late, await signSub(s.buyer, late), ZERO_PERMIT)
      ).to.be.revertedWithCustomError(s.payments, "PlanNotActive");
    });

    it("one nonce per buyer across Pay in 4 and Subscribe: the newer intent retires the older", async () => {
      const plan = await planIntent(); // nonce 0
      const planSig = await signPlan(s.buyer, plan);
      const sub = await subIntent(); // nonce 0 as well
      await s.checkout.connect(s.relayer).subscribe(sub, await signSub(s.buyer, sub), await permitTo(s.buyer, s.payments, AUSD(120)));
      await expect(s.checkout.connect(s.relayer).openPlan(plan, planSig, ZERO_PERMIT)).to.be.revertedWithCustomError(s.checkout, "InvalidAccountNonce");
    });

    it("the digest view is exactly what the buyer signs", async () => {
      const intent = await subIntent();
      const d = await s.checkout.eip712Domain();
      expect(await s.checkout.subscribeIntentDigest(intent)).to.equal(
        ethers.TypedDataEncoder.hash(
          { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract },
          { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent },
          intent
        )
      );
    });
  });

  // ---------------------------------------------------------------------
  describe("pausing", () => {
    it("the owner can stop new checkouts in every mode, while collections go on; nobody else can", async () => {
      await (await openPlan()).tx;
      await expect(s.checkout.connect(s.stranger).pause()).to.be.revertedWithCustomError(s.checkout, "OwnableUnauthorizedAccount");
      await s.checkout.pause();

      await expect((await openPlan()).tx).to.be.revertedWithCustomError(s.checkout, "EnforcedPause");
      const a = await signReceive(s.ausd, s.buyer, await s.payments.getAddress(), AUSD(5), paymentId(s.merchant.address, "P"));
      await expect(
        s.checkout.connect(s.relayer).pay(s.buyer.address, s.merchant.address, AUSD(5), "P", a.validAfter, a.validBefore, a.v, a.r, a.s)
      ).to.be.revertedWithCustomError(s.checkout, "EnforcedPause");

      await time.increase(WEEK);
      await expect(s.engine.connect(s.stranger).collectInstallment(1)).to.emit(s.engine, "InstallmentCollected");

      await expect(s.checkout.connect(s.stranger).unpause()).to.be.revertedWithCustomError(s.checkout, "OwnableUnauthorizedAccount");
      await s.checkout.unpause();
      await expect((await openPlan()).tx).to.emit(s.checkout, "PlanOpened");
    });
  });

  // ---------------------------------------------------------------------
  describe("reentrancy", () => {
    it("a merchant handed control mid-payout cannot reenter the checkout", async () => {
      s = await deployStack("HookAUSD");
      const inner = await planIntent({ orderId: "inner" });
      const innerSig = await signPlan(s.buyer, inner);
      const data = s.checkout.interface.encodeFunctionData("openPlan", [inner, innerSig, ZERO_PERMIT]);
      await s.ausd.setHook(s.merchant.address, await s.checkout.getAddress(), data);

      const intent = await planIntent({ orderId: "outer", nonce: 0n });
      const q = await s.checkout.quotePlan(s.buyer.address, AUSD(200), 4, WEEK);
      const permit = await permitTo(s.buyer, s.engine, q.permitValue);
      await expect(s.checkout.connect(s.relayer).openPlan(intent, await signPlan(s.buyer, intent), permit)).to.emit(s.checkout, "PlanOpened");

      expect(await s.ausd.hookCalled()).to.equal(true);
      expect(await s.ausd.hookOk()).to.equal(false);
      expect(await s.ausd.hookReturn()).to.equal(s.checkout.interface.getError("ReentrancyGuardReentrantCall").selector);
      expect(await s.engine.loanCount()).to.equal(1n);
    });

    it("a merchant handed control while a subscription's first period is paid cannot reenter the checkout", async () => {
      s = await deployStack("HookAUSD");
      await s.payments.connect(s.merchant).createPlan(AUSD(10), MONTH, "Pro");
      const planId = await s.payments.planCount();
      const a = await signReceive(s.ausd, s.buyer, await s.payments.getAddress(), AUSD(5), paymentId(s.merchant.address, "inner"));
      const data = s.checkout.interface.encodeFunctionData("pay", [
        s.buyer.address, s.merchant.address, AUSD(5), "inner", a.validAfter, a.validBefore, a.v, a.r, a.s,
      ]);
      await s.ausd.setHook(s.merchant.address, await s.checkout.getAddress(), data);

      const intent = {
        buyer: s.buyer.address,
        merchant: s.merchant.address,
        planId,
        pricePerPeriod: AUSD(10),
        periodSeconds: BigInt(MONTH),
        orderId: "outer",
        nonce: 0n,
        deadline: (await now()) + 600n,
      };
      const sig = (await signTyped(s.buyer, s.checkout, { SubscribeIntent: TYPES.PolarisCheckout.SubscribeIntent }, intent)).signature;
      await expect(
        s.checkout.connect(s.relayer).subscribe(intent, sig, await permitTo(s.buyer, s.payments, AUSD(120)))
      ).to.emit(s.checkout, "SubscriptionStarted");

      expect(await s.ausd.hookCalled()).to.equal(true);
      expect(await s.ausd.hookOk()).to.equal(false);
      expect(await s.ausd.hookReturn()).to.equal(s.checkout.interface.getError("ReentrancyGuardReentrantCall").selector);
      expect((await s.checkout.orderOf(s.merchant.address, "inner")).kind).to.equal(0n);
    });
  });
});

module.exports = { deployStack };
