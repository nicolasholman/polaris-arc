/**
 * MerchantRegistry operators: the platform registers merchants who hold no gas.
 *
 * Merchants sign up with Privy embedded wallets that never hold MON, so they
 * cannot send `register` themselves. An operator sends it for them, carrying
 * the merchant's signature. What these tests prove is that this is a delivery
 * mechanism and not a privilege: the entry an operator creates is exactly the
 * one the merchant signed for, an operator can neither invent one nor squat an
 * address, a gasless merchant can still move its payouts, a signature the
 * merchant has since overridden or cancelled moves nothing, and only the owner
 * decides who is an operator.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { MAX_UINT, signTyped } = require("../helpers/sign");

const AUSD = (n) => BigInt(Math.round(n * 1e6));
const DAY = 24 * 60 * 60;

const REGISTRATION_TYPES = {
  Registration: [
    { name: "merchant", type: "address" },
    { name: "name", type: "string" },
    { name: "payoutAddress", type: "address" },
    { name: "metadataURI", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const PAYOUT_UPDATE_TYPES = {
  PayoutUpdate: [
    { name: "merchant", type: "address" },
    { name: "payoutAddress", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

describe("merchant registry operators", () => {
  let registry, owner, operator, merchant, stranger, payout;

  beforeEach(async () => {
    [owner, operator, merchant, stranger, payout] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("MerchantRegistry")).deploy(owner.address);
    await registry.setOperator(operator.address, true);
  });

  /// A Privy-style embedded wallet: an address with no MON, never funded.
  function gaslessWallet() {
    return ethers.Wallet.createRandom().connect(ethers.provider);
  }

  /// What the merchant's embedded wallet signs at onboarding.
  async function signRegistration(
    signer,
    { merchant: who, name, payoutAddress, metadataURI = "", deadline = MAX_UINT, nonce } = {}
  ) {
    const subject = who ?? signer.address;
    const { signature } = await signTyped(signer, registry, REGISTRATION_TYPES, {
      merchant: subject,
      name,
      payoutAddress,
      metadataURI,
      nonce: nonce ?? (await registry.nonces(subject)),
      deadline,
    });
    return signature;
  }

  /// Sign and relay in one step: the happy path every onboarding takes.
  async function onboard(wallet, name, payoutAddress, metadataURI = "", via = operator) {
    const sig = await signRegistration(wallet, { name, payoutAddress, metadataURI });
    return registry
      .connect(via)
      .registerFor(wallet.address, name, payoutAddress, metadataURI, MAX_UINT, sig);
  }

  async function signPayoutUpdate(signer, payoutAddress, { deadline = MAX_UINT, nonce } = {}) {
    const { signature } = await signTyped(signer, registry, PAYOUT_UPDATE_TYPES, {
      merchant: signer.address,
      payoutAddress,
      nonce: nonce ?? (await registry.nonces(signer.address)),
      deadline,
    });
    return signature;
  }

  it("an operator can register a merchant who holds no gas", async () => {
    const shop = gaslessWallet();
    expect(await ethers.provider.getBalance(shop.address)).to.equal(0n);

    await expect(onboard(shop, "Corner Shop", payout.address, "ipfs://shop"))
      .to.emit(registry, "MerchantRegistered")
      .withArgs(shop.address, "Corner Shop", payout.address)
      .and.to.emit(registry, "MerchantRegisteredBy")
      .withArgs(shop.address, operator.address);

    const m = await registry.merchantOf(shop.address);
    expect(m.name).to.equal("Corner Shop");
    expect(m.payoutAddress).to.equal(payout.address);
    expect(m.metadataURI).to.equal("ipfs://shop");
    expect(m.registeredAt).to.be.greaterThan(0n);
    expect(await registry.merchantCount()).to.equal(1n);
    expect(await registry.merchantAt(0)).to.equal(shop.address);
    // The merchant never needed a unit of MON.
    expect(await ethers.provider.getBalance(shop.address)).to.equal(0n);
  });

  it("they start inactive with the default cap", async () => {
    const shop = gaslessWallet();
    await onboard(shop, "Corner Shop", payout.address);
    await registry.connect(merchant).register("Self Serve", merchant.address, "");

    const viaOperator = await registry.merchantOf(shop.address);
    const selfRegistered = await registry.merchantOf(merchant.address);
    expect(viaOperator.active).to.equal(false);
    expect(viaOperator.maxOrderValue).to.equal(AUSD(500));
    expect(viaOperator.maxOrderValue).to.equal(await registry.DEFAULT_MAX_ORDER_VALUE());
    // Identical to what the merchant would have given themselves.
    expect(viaOperator.active).to.equal(selfRegistered.active);
    expect(viaOperator.maxOrderValue).to.equal(selfRegistered.maxOrderValue);
    expect(viaOperator.totalSettled).to.equal(0n);

    expect(await registry.canOriginate(shop.address, 1n)).to.equal(false);
  });

  it("the owner can register a merchant without appointing itself an operator", async () => {
    const shop = gaslessWallet();
    expect(await registry.isOperator(owner.address)).to.equal(false);
    await expect(onboard(shop, "Owner Onboarded", payout.address, "", owner))
      .to.emit(registry, "MerchantRegistered")
      .withArgs(shop.address, "Owner Onboarded", payout.address)
      .and.to.emit(registry, "MerchantRegisteredBy")
      .withArgs(shop.address, owner.address);
  });

  it("a stranger cannot register someone else", async () => {
    const shop = gaslessWallet();
    // Not even carrying the merchant's genuine signature.
    const sig = await signRegistration(shop, { name: "Shop", payoutAddress: shop.address });
    await expect(
      registry.connect(stranger).registerFor(shop.address, "Shop", shop.address, "", MAX_UINT, sig)
    ).to.be.revertedWithCustomError(registry, "NotOperator");

    // Nor can a merchant register another merchant.
    await registry.connect(merchant).register("Shop", merchant.address, "");
    await expect(
      registry.connect(merchant).registerFor(shop.address, "Shop", shop.address, "", MAX_UINT, sig)
    ).to.be.revertedWithCustomError(registry, "NotOperator");

    expect((await registry.merchantOf(shop.address)).registeredAt).to.equal(0n);
  });

  it("an operator cannot bind a merchant to a payout address, name or metadata the merchant never signed for", async () => {
    const victim = gaslessWallet();
    const attackerPayout = stranger.address;

    // The reproduced attack: no signature from the merchant at all.
    await expect(
      registry
        .connect(operator)
        .registerFor(victim.address, "Victim Coffee", attackerPayout, "ipfs://attacker", MAX_UINT, "0x")
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");

    // The operator's own signature over the victim's entry.
    const selfSigned = await signRegistration(operator, {
      merchant: victim.address,
      name: "Victim Coffee",
      payoutAddress: attackerPayout,
      nonce: 0n,
    });
    await expect(
      registry
        .connect(operator)
        .registerFor(victim.address, "Victim Coffee", attackerPayout, "", MAX_UINT, selfSigned)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");

    // The victim's genuine signature, with any one field swapped.
    const genuine = await signRegistration(victim, {
      name: "Victim Coffee",
      payoutAddress: victim.address,
      metadataURI: "ipfs://victim",
    });
    for (const [name, payoutAddress, metadataURI] of [
      ["Victim Coffee", attackerPayout, "ipfs://victim"],
      ["Scam Coffee", victim.address, "ipfs://victim"],
      ["Victim Coffee", victim.address, "ipfs://attacker"],
    ]) {
      await expect(
        registry
          .connect(operator)
          .registerFor(victim.address, name, payoutAddress, metadataURI, MAX_UINT, genuine)
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    }

    // Nothing was written, so the address was not squatted: the merchant's own
    // registration, relayed or self-sent, still goes through as signed.
    expect((await registry.merchantOf(victim.address)).registeredAt).to.equal(0n);
    await registry
      .connect(operator)
      .registerFor(victim.address, "Victim Coffee", victim.address, "ipfs://victim", MAX_UINT, genuine);
    expect((await registry.merchantOf(victim.address)).payoutAddress).to.equal(victim.address);
  });

  it("a registration signature cannot be used after its deadline, or once it has been used", async () => {
    const shop = gaslessWallet();
    const deadline = BigInt(await time.latest()) + 100n;
    const sig = await signRegistration(shop, { name: "Shop", payoutAddress: shop.address, deadline });

    await time.setNextBlockTimestamp(deadline + 1n);
    await expect(
      registry.connect(operator).registerFor(shop.address, "Shop", shop.address, "", deadline, sig)
    ).to.be.revertedWithCustomError(registry, "SignatureExpired");

    const later = deadline + 1_000n;
    const fresh = await signRegistration(shop, { name: "Shop", payoutAddress: shop.address, deadline: later });
    await registry.connect(operator).registerFor(shop.address, "Shop", shop.address, "", later, fresh);
    expect(await registry.nonces(shop.address)).to.equal(1n);

    // The nonce moved on, so the same signature is dead however it is relayed.
    await expect(
      registry.connect(operator).registerFor(shop.address, "Shop", shop.address, "", later, fresh)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");
  });

  it("the same merchant cannot be registered twice by either path", async () => {
    // Self first, then the operator, even with the merchant's signature.
    await registry.connect(merchant).register("Shop", merchant.address, "");
    const overwrite = await signRegistration(merchant, { name: "Overwrite", payoutAddress: payout.address });
    await expect(
      registry
        .connect(operator)
        .registerFor(merchant.address, "Overwrite", payout.address, "", MAX_UINT, overwrite)
    ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");

    // Operator first, then self.
    await onboard(stranger, "Shop", stranger.address);
    await expect(
      registry.connect(stranger).register("Overwrite", merchant.address, "")
    ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");

    // Operator twice, and the owner after an operator.
    for (const via of [operator, owner]) {
      const again = await signRegistration(stranger, { name: "Again", payoutAddress: merchant.address });
      await expect(
        registry
          .connect(via)
          .registerFor(stranger.address, "Again", merchant.address, "", MAX_UINT, again)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    }

    // Nothing was overwritten, and the list holds each merchant once.
    expect((await registry.merchantOf(merchant.address)).payoutAddress).to.equal(merchant.address);
    expect((await registry.merchantOf(stranger.address)).payoutAddress).to.equal(stranger.address);
    expect(await registry.merchantCount()).to.equal(2n);
  });

  it("revoking an operator stops it", async () => {
    await expect(registry.setOperator(operator.address, false))
      .to.emit(registry, "OperatorSet")
      .withArgs(operator.address, false);
    expect(await registry.isOperator(operator.address)).to.equal(false);

    await expect(onboard(gaslessWallet(), "Late", payout.address)).to.be.revertedWithCustomError(
      registry,
      "NotOperator"
    );
  });

  it("only the owner decides who is an operator", async () => {
    await expect(
      registry.connect(stranger).setOperator(stranger.address, true)
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(
      registry.connect(operator).setOperator(stranger.address, true)
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");

    await expect(registry.setOperator(stranger.address, true))
      .to.emit(registry, "OperatorSet")
      .withArgs(stranger.address, true);
  });

  it("an operator cannot activate or raise the cap of a merchant it registered", async () => {
    const shop = gaslessWallet();
    await onboard(shop, "Shop", payout.address);

    await expect(
      registry.connect(operator).setActive(shop.address, true)
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(
      registry.connect(operator).setMaxOrderValue(shop.address, AUSD(1_000_000))
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(
      registry.connect(operator).recordSettlement(shop.address, AUSD(1))
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });

  it("a gasless merchant moves its payouts through a relayer with its signature, and nobody else can", async () => {
    const shop = gaslessWallet();
    await onboard(shop, "Shop", payout.address);

    // The operator has no hold over where the merchant is paid: not directly,
    const newPayout = merchant.address;
    await expect(
      registry.connect(operator).updatePayoutAddress(operator.address)
    ).to.be.revertedWithCustomError(registry, "NotRegistered");
    // and not with a signature of its own.
    const forged = await signTyped(operator, registry, PAYOUT_UPDATE_TYPES, {
      merchant: shop.address,
      payoutAddress: operator.address,
      nonce: await registry.nonces(shop.address),
      deadline: MAX_UINT,
    });
    await expect(
      registry
        .connect(operator)
        .updatePayoutAddressWithSig(shop.address, operator.address, MAX_UINT, forged.signature)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");

    // The merchant signs; anyone relays; the merchant still holds no MON.
    const sig = await signPayoutUpdate(shop, newPayout);
    await expect(
      registry.connect(stranger).updatePayoutAddressWithSig(shop.address, operator.address, MAX_UINT, sig)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    await expect(
      registry.connect(stranger).updatePayoutAddressWithSig(shop.address, newPayout, MAX_UINT, sig)
    )
      .to.emit(registry, "MerchantUpdated")
      .withArgs(shop.address, newPayout, AUSD(500));
    expect((await registry.merchantOf(shop.address)).payoutAddress).to.equal(newPayout);
    expect(await ethers.provider.getBalance(shop.address)).to.equal(0n);

    // A superseded update cannot be replayed to send payouts back.
    await registry
      .connect(stranger)
      .updatePayoutAddressWithSig(shop.address, payout.address, MAX_UINT, await signPayoutUpdate(shop, payout.address));
    await expect(
      registry.connect(stranger).updatePayoutAddressWithSig(shop.address, newPayout, MAX_UINT, sig)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    expect((await registry.merchantOf(shop.address)).payoutAddress).to.equal(payout.address);

    // An expired one is refused, and an unregistered merchant has nothing to move.
    const deadline = BigInt(await time.latest()) + 10n;
    const stale = await signPayoutUpdate(shop, newPayout, { deadline });
    await time.setNextBlockTimestamp(deadline + 1n);
    await expect(
      registry.connect(stranger).updatePayoutAddressWithSig(shop.address, newPayout, deadline, stale)
    ).to.be.revertedWithCustomError(registry, "SignatureExpired");
    const nobody = gaslessWallet();
    await expect(
      registry
        .connect(stranger)
        .updatePayoutAddressWithSig(nobody.address, newPayout, MAX_UINT, await signPayoutUpdate(nobody, newPayout))
    ).to.be.revertedWithCustomError(registry, "NotRegistered");

    // A merchant with gas keeps the direct path too.
    await registry.connect(merchant).register("Self Serve", merchant.address, "");
    await registry.connect(merchant).updatePayoutAddress(payout.address);
    expect((await registry.merchantOf(merchant.address)).payoutAddress).to.equal(payout.address);
  });

  it("a signed payout update the merchant has since overridden directly cannot be relayed to move payouts back", async () => {
    const [, , , , , , abandoned, safe] = await ethers.getSigners();
    await registry.connect(merchant).register("Shop", merchant.address, "");

    // The merchant signs an update to an address it later learns is
    // compromised, and moves payouts somewhere safe itself.
    const held = await signPayoutUpdate(merchant, abandoned.address);
    await expect(registry.connect(merchant).updatePayoutAddress(safe.address))
      .to.emit(registry, "MerchantUpdated")
      .withArgs(merchant.address, safe.address, AUSD(500));
    expect(await registry.nonces(merchant.address)).to.equal(1n);

    // Whoever held the signature back can no longer roll payouts back.
    await expect(
      registry
        .connect(stranger)
        .updatePayoutAddressWithSig(merchant.address, abandoned.address, MAX_UINT, held)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    expect((await registry.merchantOf(merchant.address)).payoutAddress).to.equal(safe.address);
  });

  it("a merchant can cancel a signature it no longer wants, with gas or through a relayer", async () => {
    const [, , , , , , abandoned] = await ethers.getSigners();

    // With gas: cancel outright.
    await registry.connect(merchant).register("Shop", merchant.address, "");
    const held = await signPayoutUpdate(merchant, abandoned.address);
    await expect(registry.connect(merchant).invalidateNonce())
      .to.emit(registry, "NonceInvalidated")
      .withArgs(merchant.address, 0n);
    await expect(
      registry.connect(stranger).updatePayoutAddressWithSig(merchant.address, abandoned.address, MAX_UINT, held)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    expect((await registry.merchantOf(merchant.address)).payoutAddress).to.equal(merchant.address);

    // Without gas: a fresh update to where payouts already go spends the same
    // nonce and changes nothing else.
    const shop = gaslessWallet();
    await onboard(shop, "Gasless", payout.address);
    const stale = await signPayoutUpdate(shop, abandoned.address);
    await registry
      .connect(operator)
      .updatePayoutAddressWithSig(
        shop.address,
        payout.address,
        MAX_UINT,
        await signPayoutUpdate(shop, payout.address)
      );
    await expect(
      registry.connect(stranger).updatePayoutAddressWithSig(shop.address, abandoned.address, MAX_UINT, stale)
    ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    expect((await registry.merchantOf(shop.address)).payoutAddress).to.equal(payout.address);
    expect(await ethers.provider.getBalance(shop.address)).to.equal(0n);
  });

  it("refuses to register the zero address", async () => {
    await expect(
      registry.connect(operator).registerFor(ethers.ZeroAddress, "Nobody", payout.address, "", MAX_UINT, "0x")
    ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    expect(await registry.merchantCount()).to.equal(0n);
  });

  it("an operator-registered merchant is gated by the engine exactly like a self-registered one", async () => {
    const [, , , , , borrower] = await ethers.getSigners();
    const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
    const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
    const engine = await (
      await ethers.getContractFactory("PolarisLoanEngine")
    ).deploy(
      owner.address,
      await ausd.getAddress(),
      await scores.getAddress(),
      owner.address,
      0,
      0
    );
    await scores.setWriter(await engine.getAddress(), true);
    await engine.setOriginator(owner.address, true);
    await engine.setMerchantRegistry(await registry.getAddress());
    await ausd.mint(owner.address, AUSD(10_000));
    await ausd.approve(await engine.getAddress(), AUSD(10_000));
    await engine.fund(AUSD(10_000));
    await ausd.mint(borrower.address, AUSD(1_000));
    await ausd.connect(borrower).approve(await engine.getAddress(), AUSD(1_000));

    const shop = gaslessWallet();
    await onboard(shop, "Shop", shop.address);

    // Registered, not yet activated: no plan can open against it.
    await expect(
      engine.createLoan(borrower.address, shop.address, AUSD(100), 4, 14 * DAY)
    ).to.be.revertedWithCustomError(engine, "MerchantNotEligible");

    await registry.setActive(shop.address, true);
    await engine.createLoan(borrower.address, shop.address, AUSD(100), 4, 14 * DAY);
    // Paid up front, into a wallet that has still never held MON.
    expect(await ausd.balanceOf(shop.address)).to.equal(AUSD(100));
    expect(await ethers.provider.getBalance(shop.address)).to.equal(0n);

    // And the default cap holds.
    await expect(
      engine.createLoan(borrower.address, shop.address, AUSD(501), 4, 14 * DAY)
    ).to.be.revertedWithCustomError(engine, "MerchantNotEligible");
  });
});
