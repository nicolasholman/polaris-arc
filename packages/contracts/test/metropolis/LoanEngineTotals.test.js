/**
 * PolarisLoanEngine's pool totals, which the CRE guardian attests:
 *
 *   totalOwed        == the sum of outstandingOf(id) over Active loans
 *                    == the sum of activeDebtOf(borrower) over every borrower
 *   totalOriginated  == the sum of every loan's original totalOwed
 *   badDebt          == the sum of every liquidation's shortfall
 *   poolState()      == (freeCash, totalOwed, badDebt, totalOriginated)
 *
 * Checked after every step of each way money moves (open, collect, repay,
 * repayWithSig, liquidation with full, partial and no recovery), then after
 * every step of seeded random sequences of all of them, failures included.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { TYPES } = require("../../lib/eip712");

const AUSD = (n) => ethers.parseUnits(String(n), 6);
const HOUR = 3600;
const DAY = 24 * HOUR;
const GRACE = DAY;

async function deployEngine() {
  const signers = await ethers.getSigners();
  const [owner, merchant, treasury, keeper] = signers;
  const borrowers = signers.slice(4, 10);
  const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
  const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
  const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, ausd, scores, treasury.address, GRACE, 60);
  await scores.setWriter(engine, true);
  await engine.setOriginator(owner.address, true);
  await ausd.mint(owner.address, AUSD(1_000_000));
  await ausd.approve(engine, AUSD(1_000_000));
  await engine.fund(AUSD(100_000));
  for (const b of borrowers) {
    await ausd.mint(b.address, AUSD(2_000));
    await ausd.connect(b).approve(engine, ethers.MaxUint256);
  }
  return { ausd, scores, engine, owner, merchant, keeper, borrowers };
}

/** Recompute every total from the loans themselves and compare. */
async function expectTotals(s, shortfalls, label = "") {
  const { engine, ausd, borrowers } = s;
  const count = Number(await engine.loanCount());
  let owedActive = 0n;
  let originated = 0n;
  for (let id = 1; id <= count; id++) {
    const l = await engine.getLoan(id);
    originated += l.totalOwed;
    if (l.status === 0n) owedActive += l.totalOwed - l.totalRepaid;
  }
  let debts = 0n;
  for (const b of borrowers) debts += await engine.activeDebtOf(b.address);
  const total = await engine.totalOwed();
  expect(total, `${label} totalOwed vs sum over active loans`).to.equal(owedActive);
  expect(total, `${label} totalOwed vs sum of activeDebtOf`).to.equal(debts);
  expect(await engine.totalOriginated(), `${label} totalOriginated`).to.equal(originated);
  expect(await engine.badDebt(), `${label} badDebt`).to.equal(shortfalls.total);
  const fees = await engine.protocolFeesAccrued();
  const balance = await ausd.balanceOf(await engine.getAddress());
  const state = await engine.poolState();
  expect(state.freeCash, `${label} freeCash`).to.equal(balance > fees ? balance - fees : 0n);
  expect(state.totalOwed).to.equal(total);
  expect(state.badDebt).to.equal(shortfalls.total);
  expect(state.totalOriginated).to.equal(originated);
  expect(await engine.freeCash()).to.equal(state.freeCash);
}

/** Track bad debt from the engine's own LoanLiquidated events. */
function shortfallTracker(engine) {
  const t = { total: 0n };
  t.add = (receipt) => {
    for (const log of receipt.logs) {
      let e;
      try {
        e = engine.interface.parseLog(log);
      } catch {
        continue;
      }
      if (e && e.name === "LoanLiquidated") t.total += e.args.outstanding - e.args.recovered;
    }
  };
  return t;
}

async function signRepay(engine, borrower, loanId, amount) {
  const l = await engine.getLoan(loanId);
  const d = await engine.eip712Domain();
  const deadline = BigInt(await time.latest()) + 600n;
  const signature = await borrower.signTypedData(
    { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract },
    { RepayIntent: TYPES.PolarisLoanEngine.RepayIntent },
    { loanId, amount, expectedRepaid: l.totalRepaid, nonce: await engine.nonces(borrower.address), deadline }
  );
  return [loanId, amount, l.totalRepaid, deadline, signature];
}

describe("PolarisLoanEngine pool totals (the guardian's inputs)", () => {
  let s;
  let bad;

  beforeEach(async () => {
    s = await loadFixture(deployEngine);
    bad = shortfallTracker(s.engine);
  });

  const open = async (b, principal = AUSD(100), n = 4, interval = 7 * DAY) => {
    await s.engine.createLoan(b.address, s.merchant.address, principal, n, interval);
    return s.engine.loanCount();
  };

  it("starts at zero", async () => {
    expect(await s.engine.totalOwed()).to.equal(0n);
    expect(await s.engine.totalOriginated()).to.equal(0n);
    await expectTotals(s, bad, "empty");
  });

  it("each way money moves keeps the totals exact", async () => {
    const [a, b, c, d] = s.borrowers;
    const table = [
      ["open a plan", async () => open(a)],
      ["open a second borrower's plan", async () => open(b, AUSD(60), 3, 2 * DAY)],
      ["open a one-instalment plan", async () => open(c, AUSD(40), 1, DAY)],
      ["collect a due instalment", async () => {
        await time.increase(7 * DAY);
        await s.engine.connect(s.keeper).collectInstallment(1);
      }],
      ["repay part of an instalment", async () => s.engine.connect(a).repay(1, AUSD(7))],
      ["repay by signature", async () => s.engine.connect(s.keeper).repayWithSig(...(await signRepay(s.engine, b, 2n, AUSD(10))))],
      ["overpay (capped at what is owed) closes the plan", async () => s.engine.connect(a).repay(1, AUSD(10_000))],
      ["liquidate with full recovery from the allowance", async () => {
        await time.increase(3 * DAY);
        const r = await (await s.engine.connect(s.keeper).liquidate(3)).wait();
        bad.add(r);
        expect(await s.engine.badDebt()).to.equal(0n);
      }],
      ["liquidate with no recovery books the whole outstanding as bad debt", async () => {
        await s.ausd.connect(b).approve(s.engine, 0);
        await time.increase(30 * DAY);
        const outstanding = await s.engine.outstandingOf(2);
        bad.add(await (await s.engine.connect(s.keeper).liquidate(2)).wait());
        expect(await s.engine.badDebt()).to.equal(outstanding);
      }],
      ["liquidate with a partial recovery books the rest", async () => {
        const id = await open(d, AUSD(100), 2, DAY);
        await s.ausd.connect(d).approve(s.engine, AUSD(30));
        await time.increase(10 * DAY);
        const before = await s.engine.badDebt();
        const outstanding = await s.engine.outstandingOf(id);
        bad.add(await (await s.engine.connect(s.keeper).liquidate(id)).wait());
        expect((await s.engine.badDebt()) - before).to.equal(outstanding - AUSD(30));
      }],
    ];
    for (const [label, step] of table) {
      await step();
      await expectTotals(s, bad, label);
    }
    expect(await s.engine.totalOwed()).to.equal(0n, "every plan closed or liquidated");
    expect(await s.engine.loanIdsOf(s.borrowers[0].address)).to.deep.equal([1n]);
  });

  it("a refused call moves nothing", async () => {
    const [a] = s.borrowers;
    await open(a);
    await expect(s.engine.connect(s.keeper).collectInstallment(1)).to.be.revertedWithCustomError(s.engine, "NotDue");
    await expect(s.engine.connect(s.keeper).liquidate(1)).to.be.revertedWithCustomError(s.engine, "NotLiquidatable");
    await expect(s.engine.createLoan(a.address, s.merchant.address, AUSD(10_000), 4, DAY)).to.be.revertedWithCustomError(s.engine, "ExceedsCreditLimit");
    await expectTotals(s, bad, "after refusals");
  });

  // A seeded generator, so a failure is reproducible from its seed.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 7, 2026]) {
    it(`random sequences keep every total exact after every step (seed ${seed})`, async function () {
      this.timeout(300_000);
      const rnd = mulberry32(seed);
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
      const counts = {};
      for (let step = 0; step < 90; step++) {
        const loans = Number(await s.engine.loanCount());
        const b = pick(s.borrowers);
        const id = loans > 0 ? int(1, loans) : 0;
        const action = pick(["open", "open", "collect", "collect", "repay", "repaySig", "liquidate", "time", "revoke", "restore", "drain"]);
        let receipt = null;
        try {
          if (action === "open") {
            receipt = await (await s.engine.createLoan(b.address, s.merchant.address, AUSD(int(5, 90)), int(1, 6), int(60, 10 * DAY))).wait();
          } else if (action === "collect" && id) {
            receipt = await (await s.engine.connect(s.keeper).collectInstallment(id)).wait();
          } else if (action === "repay" && id) {
            const owner = (await s.engine.getLoan(id)).borrower;
            receipt = await (await s.engine.connect(await ethers.getSigner(owner)).repay(id, AUSD(int(1, 60)))).wait();
          } else if (action === "repaySig" && id) {
            const owner = await ethers.getSigner((await s.engine.getLoan(id)).borrower);
            receipt = await (await s.engine.connect(s.keeper).repayWithSig(...(await signRepay(s.engine, owner, BigInt(id), AUSD(int(1, 40)))))).wait();
          } else if (action === "liquidate" && id) {
            receipt = await (await s.engine.connect(s.keeper).liquidate(id)).wait();
          } else if (action === "time") {
            await time.increase(int(60, 12 * DAY));
          } else if (action === "revoke") {
            await s.ausd.connect(b).approve(s.engine, AUSD(int(0, 20)));
          } else if (action === "restore") {
            await s.ausd.connect(b).approve(s.engine, ethers.MaxUint256);
            await s.ausd.mint(b.address, AUSD(200));
          } else if (action === "drain") {
            await s.ausd.connect(b).transfer(s.merchant.address, (await s.ausd.balanceOf(b.address)) / 2n);
          }
          counts[action] = (counts[action] ?? 0) + 1;
        } catch {
          counts[`${action} refused`] = (counts[`${action} refused`] ?? 0) + 1;
        }
        if (receipt) bad.add(receipt);
        await expectTotals(s, bad, `seed ${seed} step ${step} (${action} #${id})`);
      }
      // The sequence exercised the paths it claims to.
      expect(counts.open ?? 0).to.be.greaterThan(5);
      expect((counts.collect ?? 0) + (counts.repay ?? 0) + (counts.repaySig ?? 0)).to.be.greaterThan(3);
      expect(counts.liquidate ?? 0).to.be.greaterThan(0);
      expect(bad.total).to.be.greaterThan(0n, "a liquidation left a shortfall");
    });
  }
});
