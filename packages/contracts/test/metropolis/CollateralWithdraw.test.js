/**
 * CollateralVault.withdrawWithSig: "Take out of Boost" with no MON.
 *
 * The borrower signs an EIP-712 Withdraw (borrower, amount, nonce, deadline)
 * under the vault's own domain; anyone submits it (the relayer does). The
 * dollars go to the borrower and never to the caller, under exactly
 * `withdraw`'s rules: nothing while a loan is outstanding, never more than is
 * locked, never zero. A signature is spent once, expires within the hour, and
 * an ERC-1271 smart account signs as well as an EOA.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { TYPES, DOMAIN_NAMES } = require("../../lib/eip712");
const { signPermit } = require("../helpers/sign");

const USD = (n) => BigInt(Math.round(n * 1e6));
const DAY = 24 * 60 * 60;

describe("CollateralVault.withdrawWithSig (take out of Boost, gasless)", () => {
  let token, scores, engine, vault, owner, borrower, relayer, stranger, merchant;

  const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);

  async function domain(v = vault) {
    const d = await v.eip712Domain();
    return { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
  }

  /** The borrower's Withdraw, signed by `signer` (the borrower unless a test says otherwise). */
  async function signWithdraw({ who = borrower, signer = who, amount, nonce, deadline, v = vault } = {}) {
    const message = {
      borrower: who.address ?? who,
      amount,
      nonce: nonce ?? (await v.nonces(who.address ?? who)),
      deadline: deadline ?? (await now()) + 600n,
    };
    const signature = await signer.signTypedData(await domain(v), TYPES.CollateralVault, message);
    return { ...message, signature };
  }

  const submit = (w, by = relayer) => vault.connect(by).withdrawWithSig(w.borrower, w.amount, w.deadline, w.signature);

  beforeEach(async () => {
    [owner, borrower, relayer, stranger, merchant] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockAUSD")).deploy();
    scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, token, scores, owner.address, 3 * DAY, 0);
    vault = await (await ethers.getContractFactory("CollateralVault")).deploy(owner.address, token);
    await scores.setWriter(engine, true);
    await scores.setCollateralVault(vault);
    await vault.setLoanEngine(engine);
    await vault.setSeizer(engine, true);
    await engine.setCollateralVault(vault);
    await engine.setOriginator(owner.address, true);
    await token.mint(owner.address, USD(100_000));
    await token.approve(engine, USD(100_000));
    await engine.fund(USD(50_000));

    // The borrower boosts the way the app does: one permit, carried by the relayer.
    await token.mint(borrower.address, USD(500));
    const p = await signPermit(token, borrower, await vault.getAddress(), USD(300), (await now()) + 600n);
    await vault.connect(relayer).lockWithPermit(borrower.address, USD(300), p.deadline, p.v, p.r, p.s);
    // What a Pay in 4 plan's permit sets up (the tests below open plans directly on the engine).
    await token.connect(borrower).approve(engine, ethers.MaxUint256);
  });

  describe("the happy path", () => {
    it("pays the borrower who signed, submitted by anyone, and the borrower sends nothing", async () => {
      const nonceBefore = await ethers.provider.getTransactionCount(borrower.address);
      const relayerBefore = await token.balanceOf(relayer.address);
      const w = await signWithdraw({ amount: USD(120) });

      await expect(submit(w)).to.emit(vault, "CollateralWithdrawn").withArgs(borrower.address, USD(120), USD(180));

      expect(await token.balanceOf(borrower.address)).to.equal(USD(200 + 120));
      expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore);
      expect(await token.balanceOf(await vault.getAddress())).to.equal(USD(180));
      expect(await vault.lockedOf(borrower.address)).to.equal(USD(180));
      expect(await vault.totalLocked()).to.equal(USD(180));
      expect(await vault.creditBoostOf(borrower.address)).to.equal(USD(270));
      expect(await vault.nonces(borrower.address)).to.equal(1n);
      expect(await ethers.provider.getTransactionCount(borrower.address)).to.equal(nonceBefore);
    });

    it("takes everything out, and a second signature with the next nonce works", async () => {
      await submit(await signWithdraw({ amount: USD(100) }));
      await submit(await signWithdraw({ amount: USD(200) }));
      expect(await vault.lockedOf(borrower.address)).to.equal(0n);
      expect(await vault.withdrawable(borrower.address)).to.equal(0n);
      expect(await token.balanceOf(borrower.address)).to.equal(USD(500));
      expect(await vault.nonces(borrower.address)).to.equal(2n);
    });

    it("signs under the domain published for it, and the digest is the EIP-712 one a client computes", async () => {
      const d = await vault.eip712Domain();
      expect(d.fields).to.equal("0x0f");
      expect([d.name, d.version]).to.deep.equal([DOMAIN_NAMES.CollateralVault.name, DOMAIN_NAMES.CollateralVault.version]);
      expect(d.chainId).to.equal((await ethers.provider.getNetwork()).chainId);
      expect(d.verifyingContract).to.equal(await vault.getAddress());
      expect(d.salt).to.equal(ethers.ZeroHash);
      expect(d.extensions).to.deep.equal([]);

      const message = { borrower: borrower.address, amount: USD(5), nonce: 7n, deadline: 1_900_000_000n };
      expect(await vault.withdrawDigest(message.borrower, message.amount, message.nonce, message.deadline)).to.equal(
        ethers.TypedDataEncoder.hash(await domain(), TYPES.CollateralVault, message),
      );
      expect(await vault.DOMAIN_SEPARATOR()).to.equal(ethers.TypedDataEncoder.hashDomain(await domain()));
    });
  });

  describe("consent", () => {
    it("refuses a Withdraw signed by anyone but the borrower", async () => {
      const forged = await signWithdraw({ amount: USD(100), signer: stranger });
      await expect(submit(forged)).to.be.revertedWithCustomError(vault, "InvalidSignature");
      const byRelayer = await signWithdraw({ amount: USD(100), signer: relayer });
      await expect(submit(byRelayer)).to.be.revertedWithCustomError(vault, "InvalidSignature");
      expect(await vault.lockedOf(borrower.address)).to.equal(USD(300));
    });

    it("refuses another amount, deadline or borrower than the one signed", async () => {
      const w = await signWithdraw({ amount: USD(50) });
      await expect(vault.connect(relayer).withdrawWithSig(w.borrower, USD(51), w.deadline, w.signature)).to.be.revertedWithCustomError(vault, "InvalidSignature");
      await expect(vault.connect(relayer).withdrawWithSig(w.borrower, w.amount, w.deadline + 1n, w.signature)).to.be.revertedWithCustomError(vault, "InvalidSignature");
      await expect(vault.connect(relayer).withdrawWithSig(stranger.address, w.amount, w.deadline, w.signature)).to.be.revertedWithCustomError(vault, "InvalidSignature");
      expect(await vault.lockedOf(borrower.address)).to.equal(USD(300));
    });

    it("refuses a signature for another vault (the domain names the contract)", async () => {
      const other = await (await ethers.getContractFactory("CollateralVault")).deploy(owner.address, token);
      const w = await signWithdraw({ amount: USD(50), v: other, nonce: 0n });
      await expect(submit(w)).to.be.revertedWithCustomError(vault, "InvalidSignature");
    });

    it("refuses a malformed signature", async () => {
      const w = await signWithdraw({ amount: USD(50) });
      await expect(vault.connect(relayer).withdrawWithSig(w.borrower, w.amount, w.deadline, "0x1234")).to.be.revertedWithCustomError(vault, "InvalidSignature");
    });

    it("never pays the caller: the relayer's own signature over the borrower's position takes nothing", async () => {
      const relayerBefore = await token.balanceOf(relayer.address);
      const w = await signWithdraw({ who: relayer, amount: USD(100) });
      await expect(submit(w)).to.be.revertedWithCustomError(vault, "InsufficientCollateral");
      expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore);
      expect(await vault.lockedOf(borrower.address)).to.equal(USD(300));
    });
  });

  describe("replay and expiry", () => {
    it("spends a signature once", async () => {
      const w = await signWithdraw({ amount: USD(10) });
      await submit(w);
      await expect(submit(w)).to.be.revertedWithCustomError(vault, "InvalidSignature");
      await expect(submit(w, stranger)).to.be.revertedWithCustomError(vault, "InvalidSignature");
      expect(await vault.lockedOf(borrower.address)).to.equal(USD(290));
    });

    it("a newer signature retires an older one still unspent, and so does invalidateNonce", async () => {
      const older = await signWithdraw({ amount: USD(10) });
      const newer = await signWithdraw({ amount: USD(20) });
      await submit(newer);
      await expect(submit(older)).to.be.revertedWithCustomError(vault, "InvalidSignature");

      const held = await signWithdraw({ amount: USD(30) });
      await expect(vault.connect(borrower).invalidateNonce()).to.emit(vault, "NonceInvalidated").withArgs(borrower.address, 1n);
      await expect(submit(held)).to.be.revertedWithCustomError(vault, "InvalidSignature");
      expect(await vault.lockedOf(borrower.address)).to.equal(USD(280));
    });

    it("refuses a signature with a future nonce", async () => {
      const ahead = await signWithdraw({ amount: USD(10), nonce: 1n });
      await expect(submit(ahead)).to.be.revertedWithCustomError(vault, "InvalidSignature");
    });

    it("refuses an expired Withdraw, and one that would stay usable for more than an hour", async () => {
      const w = await signWithdraw({ amount: USD(10), deadline: (await now()) + 60n });
      await time.increase(61);
      await expect(submit(w)).to.be.revertedWithCustomError(vault, "SignatureExpired");

      const far = await signWithdraw({ amount: USD(10), deadline: (await now()) + 3600n + 120n });
      await expect(submit(far)).to.be.revertedWithCustomError(vault, "SignatureWindowTooLong");
      expect(await vault.MAX_SIGNATURE_WINDOW()).to.equal(3600n);
      expect(await vault.nonces(borrower.address)).to.equal(0n);
    });
  });

  describe("withdraw's rules, exactly", () => {
    it("refuses anything while a loan is outstanding, without spending the nonce, then pays out once it is repaid", async () => {
      await engine.createLoan(borrower.address, merchant.address, USD(200), 4, 14 * DAY);
      const debt = await engine.activeDebtOf(borrower.address);
      expect(debt).to.be.greaterThan(0n);
      expect(await vault.withdrawable(borrower.address)).to.equal(0n);

      const w = await signWithdraw({ amount: USD(1) });
      await expect(submit(w)).to.be.revertedWithCustomError(vault, "DebtOutstanding").withArgs(debt);
      expect(await vault.nonces(borrower.address)).to.equal(0n);
      expect(await vault.lockedOf(borrower.address)).to.equal(USD(300));

      await token.mint(borrower.address, debt);
      await engine.connect(borrower).repay(1, debt);
      expect(await vault.withdrawable(borrower.address)).to.equal(USD(300));
      await expect(submit(w)).to.emit(vault, "CollateralWithdrawn").withArgs(borrower.address, USD(1), USD(299));
    });

    it("refuses more than is locked, and zero", async () => {
      await expect(submit(await signWithdraw({ amount: USD(301) }))).to.be.revertedWithCustomError(vault, "InsufficientCollateral");
      await expect(submit(await signWithdraw({ amount: 0n }))).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("agrees with withdraw(): the same refusals, the same event, and withdraw() still pays only its caller", async () => {
      await expect(vault.connect(borrower).withdraw(USD(301))).to.be.revertedWithCustomError(vault, "InsufficientCollateral");
      await expect(vault.connect(borrower).withdraw(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await expect(vault.connect(borrower).withdraw(USD(50))).to.emit(vault, "CollateralWithdrawn").withArgs(borrower.address, USD(50), USD(250));
      await expect(vault.connect(stranger).withdraw(USD(1))).to.be.revertedWithCustomError(vault, "InsufficientCollateral");
      expect(await vault.nonces(borrower.address)).to.equal(0n, "withdraw() spends no signature nonce");
    });

    it("collateral seized on default can't be taken out after", async () => {
      await engine.createLoan(borrower.address, merchant.address, USD(200), 4, 14 * DAY);
      await vault.setSeizer(owner.address, true);
      await vault.seize(borrower.address, USD(300), owner.address);
      expect(await vault.lockedOf(borrower.address)).to.equal(0n);
      await expect(submit(await signWithdraw({ amount: USD(1) }))).to.be.revertedWithCustomError(vault, "InsufficientCollateral");
    });
  });

  describe("smart accounts (ERC-1271)", () => {
    it("pays a contract account whose owner signed, and refuses another key", async () => {
      const account = await (await ethers.getContractFactory("SmartAccount")).deploy(stranger.address);
      const accountAddress = await account.getAddress();
      await token.mint(accountAddress, USD(40));
      await account.connect(stranger).execute(token, token.interface.encodeFunctionData("approve", [await vault.getAddress(), USD(40)]));
      await account.connect(stranger).execute(vault, vault.interface.encodeFunctionData("lock", [USD(40)]));
      expect(await vault.lockedOf(accountAddress)).to.equal(USD(40));

      const message = { borrower: accountAddress, amount: USD(15), nonce: 0n, deadline: (await now()) + 600n };
      const digest = await vault.withdrawDigest(message.borrower, message.amount, message.nonce, message.deadline);
      const wrong = new ethers.SigningKey(await keyOf(borrower)).sign(digest).serialized;
      await expect(vault.connect(relayer).withdrawWithSig(accountAddress, message.amount, message.deadline, wrong)).to.be.revertedWithCustomError(vault, "InvalidSignature");

      // SmartAccount checks a raw ECDSA signature over the digest by its owner key.
      const ownerKey = new ethers.SigningKey(await keyOf(stranger));
      const signature = ownerKey.sign(digest).serialized;
      await expect(vault.connect(relayer).withdrawWithSig(accountAddress, message.amount, message.deadline, signature))
        .to.emit(vault, "CollateralWithdrawn")
        .withArgs(accountAddress, USD(15), USD(25));
      expect(await token.balanceOf(accountAddress)).to.equal(USD(15));
    });
  });

  describe("reentrancy and layout", () => {
    it("a token that hands the borrower control mid-transfer can't reenter for a second payout", async () => {
      const hook = await (await ethers.getContractFactory("HookAUSD")).deploy();
      const v = await (await ethers.getContractFactory("CollateralVault")).deploy(owner.address, hook);
      await hook.mint(borrower.address, USD(100));
      await hook.connect(borrower).approve(v, USD(100));
      await v.connect(borrower).lock(USD(100));
      const first = await signWithdraw({ amount: USD(10), v, nonce: 0n });
      const second = await signWithdraw({ amount: USD(10), v, nonce: 1n });
      await hook.setHook(borrower.address, v, v.interface.encodeFunctionData("withdrawWithSig", [second.borrower, second.amount, second.deadline, second.signature]));

      await v.connect(relayer).withdrawWithSig(first.borrower, first.amount, first.deadline, first.signature);
      expect(await hook.hookCalled()).to.equal(true);
      expect(await hook.hookOk()).to.equal(false);
      expect(ethers.dataSlice(await hook.hookReturn(), 0, 4)).to.equal(v.interface.getError("ReentrancyGuardReentrantCall").selector);
      expect(await v.lockedOf(borrower.address)).to.equal(USD(90));
      expect(await hook.balanceOf(borrower.address)).to.equal(USD(10));
    });

    it("keeps every storage slot of the vault before signed withdrawal; nonces come after", async () => {
      const at = await vault.getAddress();
      const slot = (n) => ethers.provider.getStorage(at, n);
      const mapSlot = (key, n) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [key, n]));
      const word = (v) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
      await submit(await signWithdraw({ amount: USD(1) }));

      expect(await slot(0)).to.equal(word(owner.address)); // Ownable._owner
      expect(await slot(1)).to.equal(word(15_000n)); // creditMultiplierBps
      expect(await slot(2)).to.equal(word(await engine.getAddress())); // loanEngine
      expect(await ethers.provider.getStorage(at, mapSlot(borrower.address, 3))).to.equal(word(USD(299))); // lockedOf
      expect(await slot(5)).to.equal(word(USD(299))); // totalLocked
      expect(await ethers.provider.getStorage(at, mapSlot(await engine.getAddress(), 6))).to.equal(word(1n)); // isSeizer
      expect(await ethers.provider.getStorage(at, mapSlot(borrower.address, 7))).to.equal(word(1n)); // nonces
    });
  });
});

/** The private key of a Hardhat default account (they come from the well-known test mnemonic). */
async function keyOf(signer) {
  const accounts = require("hardhat").network.config.accounts;
  const mnemonic = accounts.mnemonic ?? "test test test test test test test test test test test junk";
  for (let i = 0; i < 20; i++) {
    const w = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`);
    if (w.address === signer.address) return w.privateKey;
  }
  throw new Error(`no key for ${signer.address}`);
}
