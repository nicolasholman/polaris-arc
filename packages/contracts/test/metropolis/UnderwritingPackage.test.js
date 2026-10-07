/**
 * @polarispay/underwriting against the contracts it mirrors.
 *
 * The package computes a buyer's score, limit and Pay in 4 ceiling off chain,
 * so the app can explain a line before it opens, and it encodes the report
 * the DON signs. These tests hold all of that to the deployed bytecode: the
 * package's score is ScoreManager's, its report bytes decode as the batch
 * UnderwritingReceiver takes (on metropolis/cre) with each item's Facts the
 * struct ScoreManager takes, and its "you can pay in 4 for up to $X" is
 * exactly what PolarisLoanEngine.createLoan accepts, to the base unit.
 *
 * The package is TypeScript and is imported as source, which needs Node's
 * type stripping (on by default from Node 22.18). On older Node the suite
 * skips rather than fails.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PKG = path.join(__dirname, "../../../underwriting/src");
const load = (rel) => import(pathToFileURL(path.join(PKG, rel)).href);

const AUSD = (n) => BigInt(Math.round(n * 1e6));
const DAY = 24 * 60 * 60;
const FACTS_TUPLE = "tuple(uint32 walletAgeDays, uint32 txCount, uint64 stableBalance, uint32 defiTenureDays, uint16 priorLiquidations, uint16 relatedWallets, bool exchangeFunded, uint64 observedAt)";
/** UnderwritingReceiver._processReport: abi.decode(report, (uint8, Underwriting[])). */
const REPORT_TYPES = ["uint8", `tuple(address user, address linkedWallet, ${FACTS_TUPLE} facts)[]`];

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("@polarispay/underwriting against ScoreManager and PolarisLoanEngine", function () {
  let core, collect, fixtures, nansenMod, zerionMod, etherscanMod, rpcMod;
  let ausd, scores, engine, owner, underwriter, merchant;

  before(async function () {
    if (!process.features || !process.features.typescript) this.skip();
    core = await load("core/index.ts");
    collect = await load("node/collect.ts");
    fixtures = await load("testing/fixtures.ts");
    nansenMod = await load("node/nansen.ts");
    zerionMod = await load("node/zerion.ts");
    etherscanMod = await load("node/etherscan.ts");
    rpcMod = await load("node/rpc.ts");
  });

  beforeEach(async () => {
    [owner, underwriter, merchant] = await ethers.getSigners();
    ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
    scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, await ausd.getAddress(), await scores.getAddress(), owner.address, 3 * DAY, 0);
    await scores.setWriter(await engine.getAddress(), true);
    await scores.setUnderwriter(underwriter.address, true);
    await scores.setRequireUnderwriting(true);
    await engine.setOriginator(owner.address, true);
    await ausd.mint(owner.address, AUSD(1_000_000));
    await ausd.approve(await engine.getAddress(), AUSD(1_000_000));
    await engine.fund(AUSD(500_000));
  });

  /** Providers answered by the package's fixture test double, with test keys so they run as live clients do. */
  function providers() {
    const opts = { transport: fixtures.fixtureTransport(), cacheTtlMs: 0, minIntervalMs: 0 };
    return {
      nansen: new nansenMod.NansenClient({ ...opts, apiKey: "test-nansen-key" }),
      zerion: new zerionMod.ZerionClient({ ...opts, apiKey: "test-zerion-key" }),
      etherscan: new etherscanMod.EtherscanClient({ ...opts, apiKey: "test-etherscan-key" }),
      accountRpc: new rpcMod.RpcClient(core.MONAD_TESTNET.rpcUrl, core.MONAD_TESTNET.chainId, opts),
      historyRpcs: core.HISTORY_CHAINS.map((c) => new rpcMod.RpcClient(c.rpcUrl, c.chainId, opts)),
    };
  }

  it("scores exactly as scoreFromFacts does, across a seeded sweep", async () => {
    const rand = mulberry32(0xfac7);
    const pick = (max) => Math.floor(rand() * (max + 1));
    for (let i = 0; i < 120; i++) {
      const f = {
        walletAgeDays: pick(1_200),
        txCount: pick(1_500),
        stableBalance: BigInt(pick(7_000)) * 1_000_000n + BigInt(pick(999_999)),
        defiTenureDays: pick(1_000),
        priorLiquidations: pick(3),
        relatedWallets: pick(70),
        exchangeFunded: rand() < 0.5,
        observedAt: 0n,
      };
      const [score, declined] = await scores.scoreFromFacts(f);
      expect(core.scoreFromFacts(f)).to.deep.equal({ score: Number(score), declined });
    }
  });

  it("uses the contract's constants", async () => {
    expect(await scores.UNDERWRITE_FLOOR()).to.equal(BigInt(core.SCORE.UNDERWRITE_FLOOR));
    expect(await scores.MAX_UNDERWRITTEN_SCORE()).to.equal(BigInt(core.SCORE.MAX_UNDERWRITTEN));
    expect(await scores.MAX_EVIDENCE_AGE()).to.equal(BigInt(core.SCORE.MAX_EVIDENCE_AGE));
    expect(await scores.ON_TIME_BONUS()).to.equal(BigInt(core.SCORE.ON_TIME_BONUS));
    expect(await scores.BONUS_PERIOD()).to.equal(BigInt(core.SCORE.BONUS_PERIOD));
    expect(await engine.INTEREST_RATE_BPS()).to.equal(BigInt(core.LOAN.INTEREST_RATE_BPS));
  });

  it("a thin file is never reported, and the chain agrees it has no line: not underwritten is secured-only", async () => {
    const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    const now = await time.latest();
    // The review's proof: a brand-new account with no history at all. Built from evidence rather than the
    // dated fixtures, because other suites move the chain's clock and would age a fixture past the gate.
    const e = core.evidence;
    const account = {
      address: buyer.address,
      role: "account",
      firstSeenAt: e.empty(null, "zerion.transactions"),
      sentCount: e.ok(0, "zerion.transactions"),
      stableBalance: e.ok(0, "rpc.balance"),
      ...core.accountRules(),
    };
    const out = core.underwrite({ user: buyer.address, observedAt: now, account, linked: null, linkVerified: true });
    expect(out.final).to.equal(true);
    expect(out.attest).to.equal(false);
    expect(out.report).to.equal(null);
    expect(out.decision.limit).to.equal(0n);
    expect(await scores.creditLimitOf(buyer.address)).to.equal(out.decision.limit);
    // Had the DON attested the same facts anyway, ScoreManager refuses them itself (isThinFile), and
    // the package's gate is the contract's: the same facts are thin on both sides.
    expect(await scores.isThinFile(out.facts)).to.equal(true);
    await expect(scores.connect(underwriter).underwrite(buyer.address, out.facts)).to.be.revertedWithCustomError(scores, "ThinFile");
    expect(await scores.creditLimitOf(buyer.address)).to.equal(0n);
    expect(BigInt(core.ATTEST_MINIMUM.walletAgeDays)).to.equal(await scores.MIN_HISTORY_DAYS());
    expect(BigInt(core.ATTEST_MINIMUM.txCount)).to.equal(await scores.MIN_HISTORY_TXS());
  });

  for (const persona of [
    { name: "regular file (an account with three months of its own use)", account: 2, linked: null },
    { name: "strong file (a Coinbase-funded wallet linked)", account: 1, linked: "0xb0b0000000000000000000000000000000000001" },
    { name: "modest file (a small cluster)", account: 2, linked: "0xb0b0000000000000000000000000000000000002" },
    { name: "declined (two liquidations)", account: 1, linked: "0xb0b0000000000000000000000000000000000003" },
  ]) {
    it(`fixtures → package report → ScoreManager: the chain gives the line the package promised, ${persona.name}`, async () => {
      const buyer = ethers.Wallet.createRandom().connect(ethers.provider);
      const now = await time.latest();
      const p = providers();
      const account = await collect.collectAccount(`0xacc000000000000000000000000000000000000${persona.account}`, p, { now });
      const linked = persona.linked ? await collect.collectLinked(persona.linked, p, { now }) : null;
      const out = core.underwrite({
        user: buyer.address,
        observedAt: now,
        account: account.evidence,
        linked: linked ? linked.evidence : null,
        linkVerified: true,
      });
      expect(out.final, out.missing.join(", ")).to.equal(true);
      expect(out.attest).to.equal(true);

      // The report's bytes decode as UnderwritingReceiver decodes them, and the
      // one item's Facts are the struct the receiver hands to ScoreManager.
      const [kind, items] = ethers.AbiCoder.defaultAbiCoder().decode(REPORT_TYPES, out.report);
      expect(kind).to.equal(2n);
      expect(items.length).to.equal(1);
      const { user, linkedWallet, facts } = items[0];
      expect(user).to.equal(buyer.address);
      expect(linkedWallet.toLowerCase()).to.equal(persona.linked ?? ethers.ZeroAddress);

      await scores.connect(underwriter).underwrite(user, facts.toObject());
      expect(await scores.scoreOf(user)).to.equal(BigInt(out.breakdown.score));
      expect((await scores.profileOf(user)).declined).to.equal(out.breakdown.declined);
      expect(await scores.creditLimitOf(user)).to.equal(out.decision.limit);

      if (out.decision.limit === 0n) {
        expect(out.decision.payIn4.allowed).to.equal(false);
        return;
      }

      // "You can pay in 4 for up to $X" is exactly what the engine accepts.
      const max = out.decision.payIn4.maxPurchase;
      await ausd.mint(buyer.address, AUSD(10_000));
      await owner.sendTransaction({ to: buyer.address, value: ethers.parseEther("1") });
      await ausd.connect(buyer).approve(await engine.getAddress(), AUSD(10_000));
      const week = BigInt(core.LOAN.PAY_IN_4_INTERVAL);
      await expect(engine.createLoan(buyer.address, merchant.address, max + 1n, 4, week)).to.be.revertedWithCustomError(engine, "ExceedsCreditLimit");
      await expect(engine.createLoan(buyer.address, merchant.address, max, 4, week)).to.emit(engine, "LoanCreated");

      // And the plan it opened is the quote the buyer was shown.
      const quote = core.quotePlan(max);
      const loan = await engine.loans(await engine.loanCount());
      expect(loan.totalOwed).to.equal(quote.total);
      const ladder = [];
      for (let k = 1; k <= 4; k++) ladder.push((await engine.thresholdFor(await engine.loanCount(), k)) - (k === 1 ? 0n : await engine.thresholdFor(await engine.loanCount(), k - 1)));
      expect(ladder).to.deep.equal(quote.amounts);
    });
  }
});
