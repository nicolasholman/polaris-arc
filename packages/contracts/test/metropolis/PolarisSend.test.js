/**
 * PolarisSend: dollars sent as a link.
 *
 * The link carries a throwaway private key in its URL fragment. The sender
 * signs one ERC-3009 authorization and the app signs an Open with the
 * throwaway key; the recipient later signs a claim with that key; a relayer
 * submits everything, so neither side ever holds gas. Every test here names
 * what a relayer, a mempool watcher or a stranger must not be able to do with
 * those signatures.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { MAX_UINT, domainOf, signTyped, signReceive } = require("../helpers/sign");

const AUSD = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const MIN_LIFETIME = 5 * 60;
const MAX_EXPIRY = 30 * DAY;
const MAX_SIGNATURE_WINDOW = 60 * 60;
/** How long the app lets each signature live: minutes, well inside the hour. */
const APP_WINDOW = 10 * 60;
const UINT128_MAX = (1n << 128n) - 1n;
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

const OPEN_TYPES = {
  Open: [
    { name: "sender", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
  ],
};
const CLAIM_TYPES = {
  Claim: [
    { name: "to", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};
const CANCEL_TYPES = {
  Cancel: [
    { name: "linkKey", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};
const CANCEL_AUTHORIZATION_TYPES = {
  CancelAuthorization: [
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** The ERC-3009 nonce PolarisSend derives from the link key and expiry. */
function linkNonce(linkKey, expiresAt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint64"], [linkKey, expiresAt])
  );
}

/** A fresh throwaway key, as the app would put in the link's #k= fragment. */
function newLinkKey() {
  return ethers.Wallet.createRandom();
}

async function expiryIn(seconds) {
  return BigInt(await time.latest()) + BigInt(seconds);
}

/** The cutoff the app signs into every signature: a few minutes from now. */
function appCutoff() {
  return expiryIn(APP_WINDOW);
}

describe("PolarisSend: send dollars by link", () => {
  let ausd, ps, psAddr, alice, bob, carol, relayer, attacker;

  beforeEach(async () => {
    [, alice, bob, carol, relayer, attacker] = await ethers.getSigners();
    ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
    ps = await (await ethers.getContractFactory("PolarisSend")).deploy(await ausd.getAddress());
    psAddr = await ps.getAddress();
    await ausd.mint(alice.address, AUSD(1_000));
  });

  // ---------------------------------------------------------------
  // Helpers: each one signs or submits exactly what the app would.
  // `via` and `token` point them at another deployment when a test
  // needs a token MockAUSD cannot imitate.
  // ---------------------------------------------------------------

  /**
   * Everything the app signs to open one link: the sender's
   * ReceiveWithAuthorization, and the link key's Open.
   */
  async function signSend(sender, key, amount, expiresAt, { validBefore, via = ps, token = ausd } = {}) {
    const auth = await signReceive(token, sender, await via.getAddress(), amount, linkNonce(key.address, expiresAt), {
      validBefore: validBefore ?? (await appCutoff()),
    });
    const open = await signTyped(key, via, OPEN_TYPES, { sender: sender.address, amount, expiresAt });
    return { ...auth, open };
  }

  function submitSend(sender, linkKey, expiresAt, a, by = relayer, via = ps) {
    return via
      .connect(by)
      .send(sender, linkKey, a.value, expiresAt, a.validAfter, a.validBefore, a.v, a.r, a.s, a.open.v, a.open.r, a.open.s);
  }

  /** Sign and relay a send in one step. */
  async function openLink({ sender = alice, amount = AUSD(100), lifetime = 7 * DAY, key = newLinkKey() } = {}) {
    const expiresAt = await expiryIn(lifetime);
    const a = await signSend(sender, key, amount, expiresAt);
    await submitSend(sender.address, key.address, expiresAt, a);
    return { key, expiresAt, amount };
  }

  async function signClaim(key, to, deadline, contract = ps) {
    deadline = deadline ?? (await appCutoff());
    const sig = await signTyped(key, contract, CLAIM_TYPES, { to, deadline });
    return { ...sig, deadline };
  }

  function submitClaim(linkKey, to, c, by = relayer) {
    return ps.connect(by).claim(linkKey, to, c.deadline, c.v, c.r, c.s);
  }

  async function signCancel(sender, linkKey, deadline, contract = ps) {
    deadline = deadline ?? (await appCutoff());
    const sig = await signTyped(sender, contract, CANCEL_TYPES, { linkKey, deadline });
    return { ...sig, deadline };
  }

  function submitCancel(linkKey, c, by = relayer, via = ps) {
    return via.connect(by).cancel(linkKey, c.deadline, c.v, c.r, c.s);
  }

  // ---------------------------------------------------------------

  describe("sending", () => {
    it("a sender sends with a signature and nothing else", async () => {
      // A brand-new account: no MON, no transactions, no allowance.
      const sender = ethers.Wallet.createRandom();
      await ausd.mint(sender.address, AUSD(50));
      const key = newLinkKey();
      const expiresAt = await expiryIn(DAY);

      const a = await signSend(sender, key, AUSD(50), expiresAt);
      await submitSend(sender.address, key.address, expiresAt, a);

      expect(await ethers.provider.getBalance(sender.address)).to.equal(0n);
      expect(await ethers.provider.getTransactionCount(sender.address)).to.equal(0);
      expect(await ausd.allowance(sender.address, psAddr)).to.equal(0n);
      expect(await ausd.balanceOf(sender.address)).to.equal(0n);
      expect(await ausd.balanceOf(psAddr)).to.equal(AUSD(50));

      const link = await ps.linkOf(key.address);
      expect(link.sender).to.equal(sender.address);
      expect(link.amount).to.equal(AUSD(50));
      expect(link.expiresAt).to.equal(expiresAt);
      expect(await ps.keyUsed(key.address)).to.equal(true);
    });

    it("a relayer cannot swap in its own link key", async () => {
      const key = newLinkKey();
      const relayersKey = newLinkKey();
      const expiresAt = await expiryIn(DAY);
      const a = await signSend(alice, key, AUSD(100), expiresAt);

      // The relayer holds its own key, so it can sign Open for it. The nonce
      // is derived from the key, so the token no longer sees alice's
      // signature over what it is asked to execute.
      const relayersOpen = await signTyped(relayersKey, ps, OPEN_TYPES, {
        sender: alice.address,
        amount: AUSD(100),
        expiresAt,
      });
      await expect(
        submitSend(alice.address, relayersKey.address, expiresAt, { ...a, open: relayersOpen })
      ).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
      expect(await ps.keyUsed(relayersKey.address)).to.equal(false);
      expect((await ps.linkOf(relayersKey.address)).sender).to.equal(ethers.ZeroAddress);

      // And the refusal did not burn alice's authorization: it still funds
      // the link she actually signed for.
      await submitSend(alice.address, key.address, expiresAt, a);
      expect((await ps.linkOf(key.address)).amount).to.equal(AUSD(100));
    });

    it("a relayer cannot change the expiry, amount or sender that was signed, even holding the link key", async () => {
      await ausd.mint(bob.address, AUSD(1_000));
      const key = newLinkKey();
      const expiresAt = await expiryIn(DAY);
      const a = await signSend(alice, key, AUSD(100), expiresAt);
      const tampered = (sender, amount, e, open) =>
        ps
          .connect(relayer)
          .send(sender, key.address, amount, e, a.validAfter, a.validBefore, a.v, a.r, a.s, open.v, open.r, open.s);

      // Without the key, the link key's Open no longer matches, so the
      // contract refuses before the token is even asked.
      await expect(tampered(alice.address, AUSD(100), expiresAt + 3600n, a.open)).to.be.revertedWithCustomError(
        ps,
        "InvalidOpenSignature"
      );
      await expect(tampered(alice.address, AUSD(900), expiresAt, a.open)).to.be.revertedWithCustomError(
        ps,
        "InvalidOpenSignature"
      );
      await expect(tampered(bob.address, AUSD(100), expiresAt, a.open)).to.be.revertedWithCustomError(
        ps,
        "InvalidOpenSignature"
      );

      // The worst case: the relayer has the link itself, so it can sign an
      // Open for whatever it submits. The sender's authorization still stops
      // it: a longer expiry, to keep the money out of her reach longer...
      const reopen = (sender, amount, e) => signTyped(key, ps, OPEN_TYPES, { sender, amount, expiresAt: e });
      await expect(
        tampered(alice.address, AUSD(100), expiresAt + 3600n, await reopen(alice.address, AUSD(100), expiresAt + 3600n))
      ).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
      // ...a larger amount...
      await expect(
        tampered(alice.address, AUSD(900), expiresAt, await reopen(alice.address, AUSD(900), expiresAt))
      ).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
      // ...or someone else's money, under alice's signature.
      await expect(
        tampered(bob.address, AUSD(100), expiresAt, await reopen(bob.address, AUSD(100), expiresAt))
      ).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");

      expect(await ausd.balanceOf(psAddr)).to.equal(0n);
      expect(await ps.keyUsed(key.address)).to.equal(false);
    });

    it("a stranger who learns a pending link key cannot burn it with a link of its own", async () => {
      // Alice's send is on its way. The attacker relays it, or runs an RPC
      // node, so it sees the link key's address and alice's signatures, but
      // never the key itself.
      const key = newLinkKey();
      const expiresAt = await expiryIn(7 * DAY);
      const alices = await signSend(alice, key, AUSD(100), expiresAt);

      // It tries to file a one-unit link of its own under the key, meaning to
      // cancel it at once and so burn the key for free.
      await ausd.mint(attacker.address, 1n);
      const atkExpiry = await expiryIn(MIN_LIFETIME + 60);
      const own = await signReceive(ausd, attacker, psAddr, 1n, linkNonce(key.address, atkExpiry), {
        validBefore: await appCutoff(),
      });
      const squat = (open) =>
        ps
          .connect(attacker)
          .send(attacker.address, key.address, 1n, atkExpiry, own.validAfter, own.validBefore, own.v, own.r, own.s, open.v, open.r, open.s);

      // With an Open signed by a key it does hold...
      const forged = await signTyped(attacker, ps, OPEN_TYPES, { sender: attacker.address, amount: 1n, expiresAt: atkExpiry });
      await expect(squat(forged)).to.be.revertedWithCustomError(ps, "InvalidOpenSignature");
      // ...or with the link key's own Open, lifted from alice's pending send.
      await expect(squat(alices.open)).to.be.revertedWithCustomError(ps, "InvalidOpenSignature");

      expect(await ps.keyUsed(key.address)).to.equal(false);
      expect(await ausd.balanceOf(attacker.address)).to.equal(1n);

      // Alice's send lands, and the only Sent under the key is hers.
      await expect(submitSend(alice.address, key.address, expiresAt, alices))
        .to.emit(ps, "Sent")
        .withArgs(key.address, alice.address, AUSD(100), expiresAt);
      const sent = await ps.queryFilter(ps.filters.Sent(key.address));
      expect(sent.map((e) => [e.args.sender, e.args.amount])).to.deep.equal([[alice.address, AUSD(100)]]);
    });

    it("a replayed send is refused before it reaches the token", async () => {
      const key = newLinkKey();
      const expiresAt = await expiryIn(DAY);
      const a = await signSend(alice, key, AUSD(100), expiresAt);
      await submitSend(alice.address, key.address, expiresAt, a);

      await expect(submitSend(alice.address, key.address, expiresAt, a)).to.be.revertedWithCustomError(
        ps,
        "LinkKeyUsed"
      );
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(900));
    });

    it("a relayer cannot spend the send authorization anywhere but PolarisSend", async () => {
      const key = newLinkKey();
      const expiresAt = await expiryIn(DAY);
      const a = await signSend(alice, key, AUSD(100), expiresAt);
      const nonce = linkNonce(key.address, expiresAt);

      // Straight to the token, naming PolarisSend as payee: only the payee may call.
      await expect(
        ausd
          .connect(relayer)
          .receiveWithAuthorization(alice.address, psAddr, a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s)
      ).to.be.revertedWithCustomError(ausd, "CallerMustBePayee");
      // As a plain transfer to itself: a different typehash, so a different signer.
      await expect(
        ausd
          .connect(relayer)
          .transferWithAuthorization(
            alice.address,
            relayer.address,
            a.value,
            a.validAfter,
            a.validBefore,
            nonce,
            a.v,
            a.r,
            a.s
          )
      ).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");

      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000));
    });

    it("a token that delivers less than was signed cannot leave a link promising more than the escrow holds", async () => {
      // A token that burns 1% of every transfer: the escrow would receive 99
      // against a link that promises 100, and the last claimant on this
      // escrow could not be paid.
      const feeToken = await (await ethers.getContractFactory("FeeOnTransferAUSD")).deploy();
      const psFee = await (await ethers.getContractFactory("PolarisSend")).deploy(await feeToken.getAddress());
      await feeToken.mint(alice.address, AUSD(1_000));
      const key = newLinkKey();
      const expiresAt = await expiryIn(DAY);
      const a = await signSend(alice, key, AUSD(100), expiresAt, { via: psFee, token: feeToken });

      await expect(submitSend(alice.address, key.address, expiresAt, a, relayer, psFee))
        .to.be.revertedWithCustomError(psFee, "UnexpectedAmount")
        .withArgs(AUSD(100), AUSD(99));

      // Everything rolls back: the key is still unused, no link is filed,
      // and alice keeps her money.
      expect(await psFee.keyUsed(key.address)).to.equal(false);
      expect((await psFee.linkOf(key.address)).sender).to.equal(ethers.ZeroAddress);
      expect(await feeToken.balanceOf(await psFee.getAddress())).to.equal(0n);
      expect(await feeToken.balanceOf(alice.address)).to.equal(AUSD(1_000));
    });

    describe("a link key can never fund a second link, even after a claim, cancel or refund", () => {
      // A fresh expiry makes a fresh ERC-3009 nonce, and the key holder signs
      // a fresh Open, so the token and the Open check alone would accept the
      // second send. Only keyUsed stops it.
      async function expectKeyRefused(key) {
        const expiresAt = await expiryIn(2 * DAY);
        const again = await signSend(alice, key, AUSD(10), expiresAt);
        await expect(submitSend(alice.address, key.address, expiresAt, again)).to.be.revertedWithCustomError(
          ps,
          "LinkKeyUsed"
        );

        await ausd.mint(bob.address, AUSD(10));
        const fromBob = await signSend(bob, key, AUSD(10), expiresAt);
        await expect(submitSend(bob.address, key.address, expiresAt, fromBob)).to.be.revertedWithCustomError(
          ps,
          "LinkKeyUsed"
        );
      }

      it("after a claim", async () => {
        const { key } = await openLink();
        await submitClaim(key.address, bob.address, await signClaim(key, bob.address));
        await expectKeyRefused(key);
      });

      it("after a cancel", async () => {
        const { key } = await openLink();
        await submitCancel(key.address, await signCancel(alice, key.address));
        await expectKeyRefused(key);
      });

      it("after a refund", async () => {
        const { key, expiresAt } = await openLink();
        await time.increaseTo(expiresAt);
        await ps.connect(carol).refund(key.address);
        await expectKeyRefused(key);
      });
    });

    it("expiry bounds: a link must live at least five minutes and at most thirty days", async () => {
      // Each send is mined at a second chosen in advance, with its expiry set
      // relative to that second, so the bounds are checked to the second.
      let now = BigInt(await time.latest());
      const sendLiving = async (lifetime) => {
        now += 10n;
        const key = newLinkKey();
        const expiresAt = now + lifetime;
        const a = await signSend(alice, key, AUSD(1), expiresAt, { validBefore: now + BigInt(APP_WINDOW) });
        await time.setNextBlockTimestamp(now);
        return { key, expiresAt, submit: () => submitSend(alice.address, key.address, expiresAt, a) };
      };

      const tooShort = await sendLiving(BigInt(MIN_LIFETIME) - 1n);
      await expect(tooShort.submit()).to.be.revertedWithCustomError(ps, "InvalidExpiry");

      const tooLong = await sendLiving(BigInt(MAX_EXPIRY) + 1n);
      await expect(tooLong.submit()).to.be.revertedWithCustomError(ps, "InvalidExpiry");

      const alreadyPast = await sendLiving(-1n);
      await expect(alreadyPast.submit()).to.be.revertedWithCustomError(ps, "InvalidExpiry");

      const shortest = await sendLiving(BigInt(MIN_LIFETIME));
      await shortest.submit();
      expect((await ps.linkOf(shortest.key.address)).expiresAt).to.equal(shortest.expiresAt);

      const longest = await sendLiving(BigInt(MAX_EXPIRY));
      await longest.submit();
      expect((await ps.linkOf(longest.key.address)).expiresAt).to.equal(longest.expiresAt);
    });

    it("amount bounds: zero and anything that does not fit in a uint128 are refused", async () => {
      const expiresAt = await expiryIn(DAY);

      let key = newLinkKey();
      let a = await signSend(alice, key, 0n, expiresAt);
      await expect(submitSend(alice.address, key.address, expiresAt, a)).to.be.revertedWithCustomError(
        ps,
        "InvalidAmount"
      );

      key = newLinkKey();
      a = await signSend(alice, key, UINT128_MAX + 1n, expiresAt);
      await expect(submitSend(alice.address, key.address, expiresAt, a)).to.be.revertedWithCustomError(
        ps,
        "InvalidAmount"
      );

      // The largest amount that fits is stored without truncation.
      await ausd.mint(carol.address, UINT128_MAX);
      key = newLinkKey();
      a = await signSend(carol, key, UINT128_MAX, expiresAt);
      await submitSend(carol.address, key.address, expiresAt, a);
      expect((await ps.linkOf(key.address)).amount).to.equal(UINT128_MAX);
    });

    it("a send needs a real sender and a real link key", async () => {
      const expiresAt = await expiryIn(DAY);
      const key = newLinkKey();
      const a = await signSend(alice, key, AUSD(1), expiresAt);

      await expect(submitSend(alice.address, ethers.ZeroAddress, expiresAt, a)).to.be.revertedWithCustomError(
        ps,
        "ZeroAddress"
      );
      await expect(submitSend(ethers.ZeroAddress, key.address, expiresAt, a)).to.be.revertedWithCustomError(
        ps,
        "ZeroAddress"
      );
    });

    it("refuses to deploy without a stablecoin", async () => {
      const factory = await ethers.getContractFactory("PolarisSend");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  // ---------------------------------------------------------------

  describe("claiming", () => {
    it("the recipient claims with the link and holds no gas (a relayer submits)", async () => {
      const { key, amount } = await openLink();
      // Someone who has never touched the chain.
      const recipient = ethers.Wallet.createRandom().address;

      await submitClaim(key.address, recipient, await signClaim(key, recipient));

      expect(await ausd.balanceOf(recipient)).to.equal(amount);
      expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
      expect(await ethers.provider.getBalance(key.address)).to.equal(0n);
      expect(await ausd.balanceOf(psAddr)).to.equal(0n);
      expect((await ps.linkOf(key.address)).sender).to.equal(ethers.ZeroAddress);
    });

    it("a watched claim cannot be redirected", async () => {
      const { key, amount } = await openLink();
      const c = await signClaim(key, bob.address);

      // The attacker copies the signature out of the mempool and names itself.
      await expect(submitClaim(key.address, attacker.address, c, attacker)).to.be.revertedWithCustomError(
        ps,
        "InvalidClaimSignature"
      );
      // Nor can it stretch the deadline it was signed with.
      await expect(
        submitClaim(key.address, bob.address, { ...c, deadline: c.deadline + 60n }, attacker)
      ).to.be.revertedWithCustomError(ps, "InvalidClaimSignature");
      expect(await ausd.balanceOf(attacker.address)).to.equal(0n);

      await submitClaim(key.address, bob.address, c);
      expect(await ausd.balanceOf(bob.address)).to.equal(amount);
    });

    it("front-running a claim with the same signature only pays the recipient sooner", async () => {
      const { key, amount } = await openLink();
      const c = await signClaim(key, bob.address);

      await submitClaim(key.address, bob.address, c, attacker);
      expect(await ausd.balanceOf(bob.address)).to.equal(amount);
      expect(await ausd.balanceOf(attacker.address)).to.equal(0n);

      await expect(submitClaim(key.address, bob.address, c)).to.be.revertedWithCustomError(ps, "LinkNotFound");
    });

    it("only the link key can authorize a claim", async () => {
      const { key } = await openLink();
      const stranger = newLinkKey();

      await expect(
        submitClaim(key.address, attacker.address, await signClaim(stranger, attacker.address))
      ).to.be.revertedWithCustomError(ps, "InvalidClaimSignature");
      // The sender is not the link: to take the money back it cancels.
      await expect(
        submitClaim(key.address, alice.address, await signClaim(alice, alice.address))
      ).to.be.revertedWithCustomError(ps, "InvalidClaimSignature");
    });

    it("a claim signature for one link cannot claim another", async () => {
      const small = await openLink({ amount: AUSD(5) });
      const large = await openLink({ amount: AUSD(500) });

      const c = await signClaim(small.key, bob.address);
      await expect(submitClaim(large.key.address, bob.address, c)).to.be.revertedWithCustomError(
        ps,
        "InvalidClaimSignature"
      );

      await submitClaim(small.key.address, bob.address, c);
      expect(await ausd.balanceOf(bob.address)).to.equal(AUSD(5));
      expect((await ps.linkOf(large.key.address)).amount).to.equal(AUSD(500));
    });

    it("a claim signed for another deployment is refused", async () => {
      const { key } = await openLink();
      const other = await (await ethers.getContractFactory("PolarisSend")).deploy(await ausd.getAddress());

      const c = await signClaim(key, bob.address, undefined, other);
      await expect(submitClaim(key.address, bob.address, c)).to.be.revertedWithCustomError(
        ps,
        "InvalidClaimSignature"
      );
    });

    it("a malleated or malformed claim signature is refused with the contract's own error", async () => {
      const { key } = await openLink();
      const c = await signClaim(key, bob.address);

      // The high-s twin of a valid signature recovers the same key through
      // ecrecover, but is not the signature the key produced.
      const highS = ethers.toBeHex(SECP256K1_N - BigInt(c.s), 32);
      const flippedV = c.v === 27 ? 28 : 27;
      await expect(
        ps.claim(key.address, bob.address, c.deadline, flippedV, c.r, highS)
      ).to.be.revertedWithCustomError(ps, "InvalidClaimSignature");
      // Garbage recovers to no one.
      await expect(ps.claim(key.address, bob.address, c.deadline, 0, c.r, c.s)).to.be.revertedWithCustomError(
        ps,
        "InvalidClaimSignature"
      );
    });

    it("a claim to the zero address is refused", async () => {
      const { key } = await openLink();
      const c = await signClaim(key, ethers.ZeroAddress);
      await expect(submitClaim(key.address, ethers.ZeroAddress, c)).to.be.revertedWithCustomError(ps, "ZeroAddress");
    });

    it("a claim after expiry is refused and the refund goes only to the sender, whoever calls it", async () => {
      const { key, expiresAt, amount } = await openLink();
      const c = await signClaim(key, bob.address);
      await time.increaseTo(expiresAt);

      await expect(submitClaim(key.address, bob.address, c)).to.be.revertedWithCustomError(ps, "LinkExpired");

      const aliceBefore = await ausd.balanceOf(alice.address);
      await expect(ps.connect(attacker).refund(key.address))
        .to.emit(ps, "Refunded")
        .withArgs(key.address, alice.address, amount);

      expect(await ausd.balanceOf(alice.address)).to.equal(aliceBefore + amount);
      expect(await ausd.balanceOf(attacker.address)).to.equal(0n);
      expect(await ausd.balanceOf(psAddr)).to.equal(0n);
    });

    it("a refund before expiry is refused", async () => {
      const { key, amount } = await openLink();
      await expect(ps.connect(attacker).refund(key.address)).to.be.revertedWithCustomError(ps, "NotExpired");
      expect((await ps.linkOf(key.address)).amount).to.equal(amount);
    });

    it("expiry is one instant: claimable until it, refundable from it, never both", async () => {
      // Every transaction here is mined, reverted or not, so each check gets
      // its own second and its own link, expiring relative to that second.
      const T = await expiryIn(DAY);
      const at = async (expiresAt, amount) => {
        const key = newLinkKey();
        await submitSend(alice.address, key.address, expiresAt, await signSend(alice, key, amount, expiresAt));
        return key;
      };
      const refundEarly = await at(T + 1n, AUSD(1));
      const claimLate = await at(T + 2n, AUSD(2));
      const claimAtExpiry = await at(T + 2n, AUSD(3));
      const refundAtExpiry = await at(T + 3n, AUSD(4));
      // Signed for the moment they land, a day from now.
      const claimSig = await signClaim(claimLate, bob.address, T + BigInt(APP_WINDOW));
      const lateSig = await signClaim(claimAtExpiry, bob.address, T + BigInt(APP_WINDOW));

      // One second before expiry: not yet refundable...
      await time.setNextBlockTimestamp(T);
      await expect(ps.refund(refundEarly.address)).to.be.revertedWithCustomError(ps, "NotExpired");
      // ...and still claimable.
      await time.setNextBlockTimestamp(T + 1n);
      await submitClaim(claimLate.address, bob.address, claimSig);
      expect(await ausd.balanceOf(bob.address)).to.equal(AUSD(2));

      // At expiry: no longer claimable...
      await time.setNextBlockTimestamp(T + 2n);
      await expect(submitClaim(claimAtExpiry.address, bob.address, lateSig)).to.be.revertedWithCustomError(
        ps,
        "LinkExpired"
      );
      // ...and refundable.
      await time.setNextBlockTimestamp(T + 3n);
      await expect(ps.refund(refundAtExpiry.address))
        .to.emit(ps, "Refunded")
        .withArgs(refundAtExpiry.address, alice.address, AUSD(4));
    });
  });

  // ---------------------------------------------------------------

  describe("a link pays out once, whichever way it closes", () => {
    // Bob's link shares the escrow, so a second payout on alice's link would
    // be paid out of bob's money.
    let bobs;

    beforeEach(async () => {
      await ausd.mint(bob.address, AUSD(100));
      bobs = await openLink({ sender: bob, amount: AUSD(100), lifetime: 7 * DAY });
    });

    async function expectClosedForGood({ key, expiresAt }) {
      await expect(
        submitClaim(key.address, carol.address, await signClaim(key, carol.address))
      ).to.be.revertedWithCustomError(ps, "LinkNotFound");
      // A fresh cancel signature, not a replay of an old one.
      await expect(submitCancel(key.address, await signCancel(alice, key.address))).to.be.revertedWithCustomError(
        ps,
        "LinkNotFound"
      );
      if (BigInt(await time.latest()) < expiresAt) await time.increaseTo(expiresAt);
      await expect(ps.connect(attacker).refund(key.address)).to.be.revertedWithCustomError(ps, "LinkNotFound");

      // Bob's link is untouched, fully backed, and still pays out in full.
      expect(await ausd.balanceOf(psAddr)).to.equal(AUSD(100));
      await submitClaim(bobs.key.address, bob.address, await signClaim(bobs.key, bob.address));
      expect(await ausd.balanceOf(bob.address)).to.equal(AUSD(100));
      expect(await ausd.balanceOf(psAddr)).to.equal(0n);
    }

    it("a claimed link pays out once", async () => {
      const alices = await openLink({ lifetime: DAY });
      await submitClaim(alices.key.address, carol.address, await signClaim(alices.key, carol.address));
      expect(await ausd.balanceOf(carol.address)).to.equal(AUSD(100));

      await expectClosedForGood(alices);
      expect(await ausd.balanceOf(carol.address)).to.equal(AUSD(100));
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(900));
    });

    it("a cancelled link pays out once, even to a fresh cancel signature", async () => {
      const alices = await openLink({ lifetime: DAY });
      await submitCancel(alices.key.address, await signCancel(alice, alices.key.address));
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000));

      await expectClosedForGood(alices);
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000));
    });

    it("a refunded link pays out once, so a second refund cannot drain other senders' links", async () => {
      const alices = await openLink({ lifetime: MIN_LIFETIME + 60 });
      await time.increaseTo(alices.expiresAt);
      await ps.connect(attacker).refund(alices.key.address);
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000));

      await expectClosedForGood(alices);
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000));
      expect(await ausd.balanceOf(attacker.address)).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------

  describe("cancelling", () => {
    it("cancel needs the sender's signature, returns the funds to the sender, and a cancelled link cannot be claimed", async () => {
      const { key, amount } = await openLink();

      // Neither a stranger nor the holder of the link can cancel it.
      await expect(
        submitCancel(key.address, await signCancel(attacker, key.address))
      ).to.be.revertedWithCustomError(ps, "NotSender");
      await expect(submitCancel(key.address, await signCancel(key, key.address))).to.be.revertedWithCustomError(
        ps,
        "NotSender"
      );

      // The sender signs; a relayer submits; the money comes home.
      await expect(submitCancel(key.address, await signCancel(alice, key.address)))
        .to.emit(ps, "Cancelled")
        .withArgs(key.address, alice.address, amount);
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000));
      expect(await ausd.balanceOf(relayer.address)).to.equal(0n);
      expect(await ausd.balanceOf(psAddr)).to.equal(0n);

      await expect(
        submitClaim(key.address, bob.address, await signClaim(key, bob.address))
      ).to.be.revertedWithCustomError(ps, "LinkNotFound");
    });

    it("a cancel signature for one link cannot cancel another", async () => {
      const first = await openLink({ amount: AUSD(10) });
      const second = await openLink({ amount: AUSD(20) });

      const c = await signCancel(alice, first.key.address);
      await expect(submitCancel(second.key.address, c)).to.be.revertedWithCustomError(ps, "NotSender");
      expect((await ps.linkOf(second.key.address)).amount).to.equal(AUSD(20));

      await submitCancel(first.key.address, c);
      expect((await ps.linkOf(first.key.address)).sender).to.equal(ethers.ZeroAddress);
      expect((await ps.linkOf(second.key.address)).amount).to.equal(AUSD(20));
    });

    it("a cancel signature for another sender's link is refused, even when signed by a sender", async () => {
      await ausd.mint(bob.address, AUSD(100));
      const bobs = await openLink({ sender: bob });
      await expect(
        submitCancel(bobs.key.address, await signCancel(alice, bobs.key.address))
      ).to.be.revertedWithCustomError(ps, "NotSender");
    });

    it("a cancel signature past its deadline is refused", async () => {
      const { key } = await openLink();
      const c = await signCancel(alice, key.address, await expiryIn(60));
      await time.increase(120);

      await expect(submitCancel(key.address, c)).to.be.revertedWithCustomError(ps, "SignatureExpired");
      expect((await ps.linkOf(key.address)).sender).to.equal(alice.address);
    });

    it("a cancel signature is spent with its link and cannot be replayed", async () => {
      const { key } = await openLink();
      const c = await signCancel(alice, key.address);
      await submitCancel(key.address, c);
      await expect(submitCancel(key.address, c)).to.be.revertedWithCustomError(ps, "LinkNotFound");
    });

    it("a sender may still cancel after expiry, and the money goes where a refund would send it", async () => {
      const { key, expiresAt, amount } = await openLink();
      await time.increaseTo(expiresAt + 10n);
      await expect(submitCancel(key.address, await signCancel(alice, key.address)))
        .to.emit(ps, "Cancelled")
        .withArgs(key.address, alice.address, amount);
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000));
    });

    describe("smart-account senders", () => {
      // Real AUSD checks the sender's ERC-3009 authorization with ERC-1271
      // for a contract account, so a Safe can fund a link. ERC1271AUSD does
      // the same; OwnedSmartAccount accepts whatever its owner, alice, signs.
      let token, psSA, account, accountAddr, asAccount;

      beforeEach(async () => {
        token = await (await ethers.getContractFactory("ERC1271AUSD")).deploy();
        psSA = await (await ethers.getContractFactory("PolarisSend")).deploy(await token.getAddress());
        account = await (await ethers.getContractFactory("OwnedSmartAccount")).deploy(alice.address);
        accountAddr = await account.getAddress();
        await token.mint(accountAddr, AUSD(1_000));
        // What the account's wallet signs with: the account's address, the owner's key.
        asAccount = { address: accountAddr, signTypedData: (...args) => alice.signTypedData(...args) };
      });

      async function openSmartLink() {
        const key = newLinkKey();
        const expiresAt = await expiryIn(7 * DAY);
        const a = await signSend(asAccount, key, AUSD(100), expiresAt, { via: psSA, token });
        await submitSend(accountAddr, key.address, expiresAt, a, relayer, psSA);
        expect((await psSA.linkOf(key.address)).sender).to.equal(accountAddr);
        return key;
      }

      it("a smart-account sender that can fund a link can also cancel it, without waiting for expiry", async () => {
        const key = await openSmartLink();
        expect(await token.balanceOf(accountAddr)).to.equal(AUSD(900));

        const c = await signCancel(asAccount, key.address, undefined, psSA);
        await expect(submitCancel(key.address, c, relayer, psSA))
          .to.emit(psSA, "Cancelled")
          .withArgs(key.address, accountAddr, AUSD(100));
        expect(await token.balanceOf(accountAddr)).to.equal(AUSD(1_000));
        expect(await token.balanceOf(await psSA.getAddress())).to.equal(0n);
      });

      it("a stranger cannot cancel a smart account's link: the account refuses its signature", async () => {
        const key = await openSmartLink();
        const c = await signCancel(attacker, key.address, undefined, psSA);
        await expect(submitCancel(key.address, c, relayer, psSA)).to.be.revertedWithCustomError(psSA, "NotSender");
        expect((await psSA.linkOf(key.address)).amount).to.equal(AUSD(100));
      });
    });
  });

  // ---------------------------------------------------------------

  describe("every signature is short-lived", () => {
    it("a relayer cannot sit on a send and land it when the link has almost run out", async () => {
      const key = newLinkKey();
      const expiresAt = await expiryIn(7 * DAY);
      const a = await signSend(alice, key, AUSD(100), expiresAt);

      // Held back until the week-long link has five minutes left.
      await time.setNextBlockTimestamp(expiresAt - BigInt(MIN_LIFETIME));
      await expect(submitSend(alice.address, key.address, expiresAt, a)).to.be.revertedWithCustomError(
        ausd,
        "AuthorizationExpired"
      );
      expect(await ps.keyUsed(key.address)).to.equal(false);
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000));
    });

    it("retrying a send under the same link key can never escrow the sender twice", async () => {
      const key = newLinkKey();
      const expiresAt = await expiryIn(7 * DAY);
      const withheld = await signSend(alice, key, AUSD(100), expiresAt);

      // The app gives up on the first attempt and signs again under the same
      // key, here even with a different expiry and so a different nonce.
      const retryExpiry = expiresAt + 60n;
      const retry = await signSend(alice, key, AUSD(100), retryExpiry);
      await submitSend(alice.address, key.address, retryExpiry, retry);

      // The first attempt surfaces while it is still valid, and is refused.
      await expect(submitSend(alice.address, key.address, expiresAt, withheld)).to.be.revertedWithCustomError(
        ps,
        "LinkKeyUsed"
      );
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(900));
      expect(await ausd.balanceOf(psAddr)).to.equal(AUSD(100));
    });

    it("an app that must switch to a fresh key first spends the old authorization, so both cannot land", async () => {
      const oldKey = newLinkKey();
      const oldExpiry = await expiryIn(7 * DAY);
      const withheld = await signSend(alice, oldKey, AUSD(100), oldExpiry);

      // Alice spends the withheld authorization's nonce at the token, with
      // the nonce the contract reports for that key and expiry.
      const nonce = await ps.sendNonce(oldKey.address, oldExpiry);
      const spent = await signTyped(alice, ausd, CANCEL_AUTHORIZATION_TYPES, { authorizer: alice.address, nonce });
      await ausd.connect(relayer).cancelAuthorization(alice.address, nonce, spent.v, spent.r, spent.s);

      const fresh = await openLink({ amount: AUSD(100) });
      await expect(submitSend(alice.address, oldKey.address, oldExpiry, withheld)).to.be.revertedWithCustomError(
        ausd,
        "AuthorizationAlreadyUsed"
      );
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(900));
      expect((await ps.linkOf(fresh.key.address)).amount).to.equal(AUSD(100));
    });

    it("a relayer cannot hold a cancel for days and fire it just ahead of the recipient's claim", async () => {
      const { key, amount } = await openLink();
      const abandoned = await signCancel(alice, key.address);
      await time.increase(2 * DAY);

      await expect(submitCancel(key.address, abandoned)).to.be.revertedWithCustomError(ps, "SignatureExpired");
      await submitClaim(key.address, bob.address, await signClaim(key, bob.address));
      expect(await ausd.balanceOf(bob.address)).to.equal(amount);
    });

    it("a claim the holder has since corrected cannot land once its deadline has passed", async () => {
      const { key, amount } = await openLink();
      // A claim to a mistyped address, which the relayer keeps.
      const mistyped = await signClaim(key, carol.address);
      // The holder waits out its deadline, then signs the corrected one.
      await time.increase(APP_WINDOW + 1);
      const corrected = await signClaim(key, bob.address);

      await expect(submitClaim(key.address, carol.address, mistyped)).to.be.revertedWithCustomError(
        ps,
        "SignatureExpired"
      );
      await submitClaim(key.address, bob.address, corrected);
      expect(await ausd.balanceOf(bob.address)).to.equal(amount);
      expect(await ausd.balanceOf(carol.address)).to.equal(0n);
    });

    it("a signature valid for longer than an hour is refused, so an app cannot ship one by mistake", async () => {
      const W = BigInt(MAX_SIGNATURE_WINDOW);
      // `prepare(cutoff)` signs with that cutoff and returns the submission.
      // Each attempt lands at a second chosen in advance, so the hour is
      // checked to the second: a cutoff that never expires and one a second
      // past the hour are refused, the hour itself is accepted.
      async function expectCappedAtTheHour(prepare) {
        const attempts = [
          [() => MAX_UINT, true],
          [(landing) => landing + W + 1n, true],
          [(landing) => landing + W, false],
        ];
        for (const [cutoffFor, refused] of attempts) {
          const landing = BigInt(await time.latest()) + 10n;
          const submit = await prepare(cutoffFor(landing));
          await time.setNextBlockTimestamp(landing);
          if (refused) await expect(submit()).to.be.revertedWithCustomError(ps, "SignatureWindowTooLong");
          else await submit();
        }
      }

      // A send's validBefore.
      const key = newLinkKey();
      const expiresAt = await expiryIn(DAY);
      await expectCappedAtTheHour(async (validBefore) => {
        const a = await signSend(alice, key, AUSD(1), expiresAt, { validBefore });
        return () => submitSend(alice.address, key.address, expiresAt, a);
      });
      expect((await ps.linkOf(key.address)).amount).to.equal(AUSD(1));

      // A claim's deadline.
      const forClaim = await openLink();
      await expectCappedAtTheHour(async (deadline) => {
        const c = await signClaim(forClaim.key, bob.address, deadline);
        return () => submitClaim(forClaim.key.address, bob.address, c);
      });
      expect(await ausd.balanceOf(bob.address)).to.equal(forClaim.amount);

      // A cancel's deadline.
      const forCancel = await openLink();
      await expectCappedAtTheHour(async (deadline) => {
        const c = await signCancel(alice, forCancel.key.address, deadline);
        return () => submitCancel(forCancel.key.address, c);
      });
      expect((await ps.linkOf(forCancel.key.address)).sender).to.equal(ethers.ZeroAddress);
    });
  });

  // ---------------------------------------------------------------

  describe("for indexers and clients", () => {
    it("events carry what an indexer needs", async () => {
      const key = newLinkKey();
      const expiresAt = await expiryIn(DAY);
      const a = await signSend(alice, key, AUSD(42), expiresAt);
      await expect(submitSend(alice.address, key.address, expiresAt, a))
        .to.emit(ps, "Sent")
        .withArgs(key.address, alice.address, AUSD(42), expiresAt);

      await expect(submitClaim(key.address, bob.address, await signClaim(key, bob.address)))
        .to.emit(ps, "Claimed")
        .withArgs(key.address, bob.address, AUSD(42));

      const cancelled = await openLink({ amount: AUSD(7) });
      await expect(submitCancel(cancelled.key.address, await signCancel(alice, cancelled.key.address)))
        .to.emit(ps, "Cancelled")
        .withArgs(cancelled.key.address, alice.address, AUSD(7));

      const refunded = await openLink({ amount: AUSD(3), lifetime: MIN_LIFETIME + 1 });
      await time.increaseTo(refunded.expiresAt);
      await expect(ps.refund(refunded.key.address))
        .to.emit(ps, "Refunded")
        .withArgs(refunded.key.address, alice.address, AUSD(3));

      // Link key and party are indexed, so a link's page can find its whole
      // history, and a sender's activity feed is one filter.
      expect(await ps.queryFilter(ps.filters.Sent(key.address))).to.have.length(1);
      expect(await ps.queryFilter(ps.filters.Claimed(key.address, bob.address))).to.have.length(1);
      expect(await ps.queryFilter(ps.filters.Sent(null, alice.address))).to.have.length(3);
      expect(await ps.queryFilter(ps.filters.Cancelled(null, alice.address))).to.have.length(1);
      expect(await ps.queryFilter(ps.filters.Refunded(refunded.key.address, alice.address))).to.have.length(1);
    });

    it("the digests and nonce the contract exposes are the ones a wallet signs", async () => {
      const domain = await domainOf(ps);
      expect(domain.name).to.equal("PolarisSend");
      expect(domain.version).to.equal("1");

      const key = newLinkKey();
      expect(await ps.openDigest(alice.address, AUSD(5), 99n)).to.equal(
        ethers.TypedDataEncoder.hash(domain, OPEN_TYPES, { sender: alice.address, amount: AUSD(5), expiresAt: 99n })
      );
      expect(await ps.claimDigest(bob.address, 1234n)).to.equal(
        ethers.TypedDataEncoder.hash(domain, CLAIM_TYPES, { to: bob.address, deadline: 1234n })
      );
      expect(await ps.cancelDigest(key.address, 1234n)).to.equal(
        ethers.TypedDataEncoder.hash(domain, CANCEL_TYPES, { linkKey: key.address, deadline: 1234n })
      );
      expect(await ps.sendNonce(key.address, 99n)).to.equal(linkNonce(key.address, 99n));

      // A signature over the exposed digest recovers to the key that signed it.
      const c = await signClaim(key, bob.address, 1234n);
      expect(ethers.recoverAddress(await ps.claimDigest(bob.address, 1234n), c.signature)).to.equal(key.address);
    });

    it("the escrow always holds exactly what open links owe", async () => {
      const a = await openLink({ amount: AUSD(10) });
      const b = await openLink({ amount: AUSD(20) });
      const c = await openLink({ amount: AUSD(30), lifetime: MIN_LIFETIME + 1 });
      expect(await ausd.balanceOf(psAddr)).to.equal(AUSD(60));

      await submitClaim(a.key.address, bob.address, await signClaim(a.key, bob.address));
      expect(await ausd.balanceOf(psAddr)).to.equal(AUSD(50));

      await submitCancel(b.key.address, await signCancel(alice, b.key.address));
      expect(await ausd.balanceOf(psAddr)).to.equal(AUSD(30));

      await time.increaseTo(c.expiresAt);
      await ps.refund(c.key.address);
      expect(await ausd.balanceOf(psAddr)).to.equal(0n);
      expect(await ausd.balanceOf(alice.address)).to.equal(AUSD(1_000) - AUSD(10));
    });
  });
});
