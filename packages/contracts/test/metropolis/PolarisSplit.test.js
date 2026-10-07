/**
 * PolarisSplit: split the bill by link.
 *
 * The organiser signs a CreateSplit (the shares, a salt, the hash of the
 * link's words, an expiry); each friend signs one ERC-3009
 * ReceiveWithAuthorization for exactly their share, with a nonce the contract
 * derives from the split and the share; the organiser may sign a CloseSplit.
 * A relayer submits everything, so nobody holds gas, and a share's dollars go
 * straight on to the organiser in the same call. Every test names what a
 * relayer, a watcher or a stranger must not be able to do with those
 * signatures.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { domainOf, signTyped, signReceive } = require("../helpers/sign");

const AUSD = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const MIN_LIFETIME = 5 * 60;
const MAX_EXPIRY = 60 * DAY;
const MAX_SIGNATURE_WINDOW = 60 * 60;
/** How long the app lets each signature live. */
const APP_WINDOW = 10 * 60;
const UINT128_MAX = (1n << 128n) - 1n;

const CREATE_TYPES = {
  CreateSplit: [
    { name: "organiser", type: "address" },
    { name: "salt", type: "bytes32" },
    { name: "amounts", type: "uint128[]" },
    { name: "memoHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "deadline", type: "uint256" },
  ],
};
const CLOSE_TYPES = {
  CloseSplit: [
    { name: "splitId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

const coder = ethers.AbiCoder.defaultAbiCoder();

/** The ERC-3009 nonce PolarisSplit derives for a share. */
function shareNonce(splitId, index) {
  return ethers.keccak256(coder.encode(["bytes32", "uint256"], [splitId, index]));
}

function splitIdOf(organiser, salt) {
  return ethers.keccak256(coder.encode(["address", "bytes32"], [organiser, salt]));
}

/** The link's words, hashed the way the app does (apps/app src/lib/split.ts). */
function memoHashOf({ description, organiserName, billTotal, labels }) {
  return ethers.keccak256(
    coder.encode(["string", "string", "uint256", "string[]"], [description, organiserName, billTotal, labels])
  );
}

async function inSeconds(seconds) {
  return BigInt(await time.latest()) + BigInt(seconds);
}

describe("PolarisSplit: split the bill by link", () => {
  let ausd, split, splitAddr, maya, sam, priya, jon, relayer, attacker;

  beforeEach(async () => {
    [, maya, sam, priya, jon, relayer, attacker] = await ethers.getSigners();
    ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
    split = await (await ethers.getContractFactory("PolarisSplit")).deploy(await ausd.getAddress());
    splitAddr = await split.getAddress();
    for (const friend of [sam, priya, jon, attacker]) await ausd.mint(friend.address, AUSD(1_000));
  });

  // ---------------------------------------------------------------
  // Helpers: each signs or submits exactly what the app would.
  // ---------------------------------------------------------------

  async function signCreate(organiser, fields = {}, via = split) {
    const c = {
      organiser: organiser.address,
      salt: fields.salt ?? ethers.hexlify(ethers.randomBytes(32)),
      amounts: fields.amounts ?? [AUSD(30), AUSD(30), AUSD(30)],
      memoHash: fields.memoHash ?? memoHashOf({ description: "Dinner at Lucia", organiserName: "Maya", billTotal: AUSD(120), labels: ["Sam", "Priya", "Jon"] }),
      expiresAt: fields.expiresAt ?? (await inSeconds(14 * DAY)),
      deadline: fields.deadline ?? (await inSeconds(APP_WINDOW)),
    };
    const { signature } = await signTyped(fields.signer ?? organiser, via, CREATE_TYPES, c);
    return { c, signature };
  }

  /** Sign and relay a split in one step. */
  async function openSplit(organiser = maya, fields = {}) {
    const { c, signature } = await signCreate(organiser, fields);
    await split.connect(relayer).createSplit(c, signature);
    return { ...c, splitId: splitIdOf(c.organiser, c.salt) };
  }

  /** A friend's authorization for one share, as the app signs it. */
  async function signShare(friend, splitId, index, value, opts = {}) {
    return signReceive(opts.token ?? ausd, friend, opts.to ?? splitAddr, value, opts.nonce ?? shareNonce(splitId, index), {
      validBefore: opts.validBefore ?? (await inSeconds(APP_WINDOW)),
    });
  }

  function submitShare(splitId, index, payer, a, via = split) {
    return via.connect(relayer).payShare(splitId, index, payer, a.validAfter, a.validBefore, a.v, a.r, a.s);
  }

  async function pay(friend, s, index) {
    const amount = s.amounts[index];
    return submitShare(s.splitId, index, friend.address, await signShare(friend, s.splitId, index, amount));
  }

  async function signClose(organiser, splitId, deadline) {
    deadline = deadline ?? (await inSeconds(APP_WINDOW));
    const { signature } = await signTyped(organiser, split, CLOSE_TYPES, { splitId, deadline });
    return { signature, deadline };
  }

  // ---------------------------------------------------------------

  describe("the happy path", () => {
    it("an organiser opens a split, three friends pay, and each share lands with the organiser at once", async () => {
      const s = await openSplit();
      const view = await split.splitOf(s.splitId);
      expect(view.organiser).to.equal(maya.address);
      expect(view.shareCount).to.equal(3);
      expect(view.paidCount).to.equal(0);
      expect(view.total).to.equal(AUSD(90));
      expect(view.closed).to.equal(false);
      expect(view.memoHash).to.equal(s.memoHash);

      await expect(pay(sam, s, 0))
        .to.emit(split, "SharePaid")
        .withArgs(s.splitId, 0, sam.address, AUSD(30), 1, 3);
      expect(await ausd.balanceOf(maya.address)).to.equal(AUSD(30));
      await pay(priya, s, 1);
      await pay(jon, s, 2);

      expect(await ausd.balanceOf(maya.address)).to.equal(AUSD(90));
      expect(await ausd.balanceOf(sam.address)).to.equal(AUSD(970));
      // No custody: nothing stays behind.
      expect(await ausd.balanceOf(splitAddr)).to.equal(0n);

      const done = await split.splitOf(s.splitId);
      expect(done.paidCount).to.equal(3);
      expect(done.paidTotal).to.equal(AUSD(90));
      const [amounts, payers] = await split.sharesOf(s.splitId);
      expect(amounts).to.deep.equal([AUSD(30), AUSD(30), AUSD(30)]);
      expect(payers).to.deep.equal([sam.address, priya.address, jon.address]);
    });

    it("nobody but the relayer holds gas: a brand-new organiser and a brand-new friend only sign", async () => {
      const organiser = ethers.Wallet.createRandom();
      const friend = ethers.Wallet.createRandom();
      await ausd.mint(friend.address, AUSD(25));
      const s = await openSplit(organiser, { amounts: [AUSD(25)] });
      await pay(friend, s, 0);

      for (const who of [organiser, friend]) {
        expect(await ethers.provider.getBalance(who.address)).to.equal(0n);
        expect(await ethers.provider.getTransactionCount(who.address)).to.equal(0);
      }
      expect(await ausd.allowance(friend.address, splitAddr)).to.equal(0n);
      expect(await ausd.balanceOf(organiser.address)).to.equal(AUSD(25));
    });

    it("named amounts: each share is its own amount, paid in any order, by anyone holding its signature", async () => {
      const s = await openSplit(maya, { amounts: [AUSD(12.5), AUSD(40), AUSD("7.25")] });
      await pay(jon, s, 2);
      await pay(sam, s, 0);
      expect((await split.splitOf(s.splitId)).paidTotal).to.equal(AUSD("19.75"));
      expect(await ausd.balanceOf(maya.address)).to.equal(AUSD("19.75"));
      expect(await split.paidBy(s.splitId, 1)).to.equal(ethers.ZeroAddress);
    });

    it("the split's id is the organiser's and the salt's, known before it lands", async () => {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      const { c, signature } = await signCreate(maya, { salt });
      const expected = await split.splitIdOf(maya.address, salt);
      expect(expected).to.equal(splitIdOf(maya.address, salt));
      await expect(split.connect(relayer).createSplit(c, signature))
        .to.emit(split, "SplitCreated")
        .withArgs(expected, maya.address, AUSD(90), c.amounts, c.expiresAt, c.memoHash);
    });

    it("a smart-account organiser opens and closes a split with ERC-1271", async () => {
      const account = await (await ethers.getContractFactory("SmartAccount")).deploy(maya.address);
      const organiser = { address: await account.getAddress() };
      const s = await openSplit(organiser, { signer: maya });
      expect((await split.splitOf(s.splitId)).organiser).to.equal(organiser.address);
      await pay(sam, s, 0);
      expect(await ausd.balanceOf(organiser.address)).to.equal(AUSD(30));
      const { signature, deadline } = await signClose(maya, s.splitId);
      await expect(split.connect(relayer).closeSplit(s.splitId, deadline, signature)).to.emit(split, "SplitClosed");
    });
  });

  describe("a share is paid once, in full", () => {
    it("double pay: the same share can't be paid twice, by the same friend or another", async () => {
      const s = await openSplit();
      await pay(sam, s, 0);
      await expect(pay(sam, s, 0)).to.be.revertedWithCustomError(split, "ShareAlreadyPaid").withArgs(0);
      await expect(pay(priya, s, 0)).to.be.revertedWithCustomError(split, "ShareAlreadyPaid").withArgs(0);
      expect(await ausd.balanceOf(maya.address)).to.equal(AUSD(30));
    });

    it("replay: a used authorization is refused before the token, and the token refuses it too", async () => {
      const s = await openSplit();
      const a = await signShare(sam, s.splitId, 0, AUSD(30));
      await submitShare(s.splitId, 0, sam.address, a);
      await expect(submitShare(s.splitId, 0, sam.address, a)).to.be.revertedWithCustomError(split, "ShareAlreadyPaid");
      // Straight to the token it fails too: only the payee may submit a receive authorization.
      await expect(
        ausd.connect(relayer).receiveWithAuthorization(sam.address, splitAddr, AUSD(30), a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s)
      ).to.be.revertedWithCustomError(ausd, "CallerMustBePayee");
      expect(await ausd.authorizationState(sam.address, a.nonce)).to.equal(true);
    });

    it("replay: a friend's signature for one share can't pay another share, or another split", async () => {
      const s = await openSplit();
      const other = await openSplit();
      const a = await signShare(sam, s.splitId, 0, AUSD(30));
      await expect(submitShare(s.splitId, 1, sam.address, a)).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
      await expect(submitShare(other.splitId, 0, sam.address, a)).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
      // The refusals burned nothing: it still pays the share it was signed for.
      await submitShare(s.splitId, 0, sam.address, a);
      expect(await split.paidBy(s.splitId, 0)).to.equal(sam.address);
    });

    it("overpay: an authorization for more (or less) than the share is refused by the token", async () => {
      const s = await openSplit();
      for (const value of [AUSD(31), AUSD(29)]) {
        const a = await signShare(sam, s.splitId, 0, value);
        await expect(submitShare(s.splitId, 0, sam.address, a)).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
      }
      expect(await ausd.balanceOf(sam.address)).to.equal(AUSD(1_000));
      expect((await split.splitOf(s.splitId)).paidCount).to.equal(0);
    });

    it("overpay: once every share is paid, nothing more can be paid into the split", async () => {
      const s = await openSplit(maya, { amounts: [AUSD(10), AUSD(10)] });
      await pay(sam, s, 0);
      await pay(priya, s, 1);
      await expect(pay(jon, s, 0)).to.be.revertedWithCustomError(split, "ShareAlreadyPaid");
      await expect(submitShare(s.splitId, 2, jon.address, await signShare(jon, s.splitId, 2, AUSD(10))))
        .to.be.revertedWithCustomError(split, "ShareOutOfRange")
        .withArgs(2, 2);
      expect(await ausd.balanceOf(maya.address)).to.equal(AUSD(20));
    });

    it("wrong signer: an authorization signed by someone else can't pay in the payer's name", async () => {
      const s = await openSplit();
      // The attacker signs, and names sam as the payer: the token recovers the attacker, not sam.
      const a = await signShare(attacker, s.splitId, 0, AUSD(30));
      await expect(submitShare(s.splitId, 0, sam.address, a)).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
      expect(await ausd.balanceOf(sam.address)).to.equal(AUSD(1_000));
    });

    it("a relayer can't spend a friend's share authorization anywhere but the split", async () => {
      const s = await openSplit();
      // Signed payable to the relayer's own address instead: the split's call names itself as payee.
      const a = await signShare(sam, s.splitId, 0, AUSD(30), { to: relayer.address });
      await expect(submitShare(s.splitId, 0, sam.address, a)).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
    });

    it("anyone can pay a share for a friend, and the chain records who did", async () => {
      const s = await openSplit();
      await pay(jon, s, 0);
      expect(await split.paidBy(s.splitId, 0)).to.equal(jon.address);
    });

    it("a token that delivers less than was signed can't mark a share paid", async () => {
      const fot = await (await ethers.getContractFactory("FeeOnTransferAUSD")).deploy();
      const fotSplit = await (await ethers.getContractFactory("PolarisSplit")).deploy(await fot.getAddress());
      await fot.mint(sam.address, AUSD(100));
      const { c, signature } = await signCreate(maya, { amounts: [AUSD(30)] }, fotSplit);
      await fotSplit.connect(relayer).createSplit(c, signature);
      const splitId = splitIdOf(maya.address, c.salt);
      const a = await signShare(sam, splitId, 0, AUSD(30), { token: fot, to: await fotSplit.getAddress() });
      await expect(submitShare(splitId, 0, sam.address, a, fotSplit))
        .to.be.revertedWithCustomError(fotSplit, "UnexpectedAmount")
        .withArgs(AUSD(30), AUSD("29.7"));
    });

    it("a token that hands the organiser control mid-transfer can't reenter to pay again", async () => {
      const hook = await (await ethers.getContractFactory("HookAUSD")).deploy();
      const hookSplit = await (await ethers.getContractFactory("PolarisSplit")).deploy(await hook.getAddress());
      await hook.mint(sam.address, AUSD(100));
      const { c, signature } = await signCreate(maya, { amounts: [AUSD(30), AUSD(30)] }, hookSplit);
      await hookSplit.connect(relayer).createSplit(c, signature);
      const splitId = splitIdOf(maya.address, c.salt);
      const second = await signShare(sam, splitId, 1, AUSD(30), { token: hook, to: await hookSplit.getAddress() });
      const reenter = hookSplit.interface.encodeFunctionData("payShare", [splitId, 1, sam.address, second.validAfter, second.validBefore, second.v, second.r, second.s]);
      await hook.setHook(maya.address, await hookSplit.getAddress(), reenter);

      const first = await signShare(sam, splitId, 0, AUSD(30), { token: hook, to: await hookSplit.getAddress() });
      await submitShare(splitId, 0, sam.address, first, hookSplit);
      expect(await hook.hookCalled()).to.equal(true);
      expect(await hook.hookOk()).to.equal(false);
      expect((await hookSplit.splitOf(splitId)).paidCount).to.equal(1);
    });

    it("an unknown split or a zero payer is refused", async () => {
      const s = await openSplit();
      const ghost = ethers.hexlify(ethers.randomBytes(32));
      const a = await signShare(sam, ghost, 0, AUSD(30));
      await expect(submitShare(ghost, 0, sam.address, a)).to.be.revertedWithCustomError(split, "SplitNotFound");
      const b = await signShare(sam, s.splitId, 0, AUSD(30));
      await expect(submitShare(s.splitId, 0, ethers.ZeroAddress, b)).to.be.revertedWithCustomError(split, "ZeroAddress");
    });
  });

  describe("closing", () => {
    it("closed split: the organiser closes it, and no unpaid share can be paid after", async () => {
      const s = await openSplit();
      await pay(sam, s, 0);
      // Priya signed before the close; her authorization must not land after it.
      const pending = await signShare(priya, s.splitId, 1, AUSD(30));
      const { signature, deadline } = await signClose(maya, s.splitId);
      await expect(split.connect(relayer).closeSplit(s.splitId, deadline, signature))
        .to.emit(split, "SplitClosed")
        .withArgs(s.splitId, maya.address, 1, 3);
      await expect(submitShare(s.splitId, 1, priya.address, pending)).to.be.revertedWithCustomError(split, "SplitIsClosed");

      // Nothing moves on a close: the paid share stays with the organiser, the unpaid ones never left.
      expect(await ausd.balanceOf(maya.address)).to.equal(AUSD(30));
      expect(await ausd.balanceOf(priya.address)).to.equal(AUSD(1_000));
      expect(await ausd.balanceOf(splitAddr)).to.equal(0n);
      expect((await split.splitOf(s.splitId)).closed).to.equal(true);
    });

    it("wrong signer: only the organiser can close a split", async () => {
      const s = await openSplit();
      for (const who of [sam, attacker, relayer]) {
        const { signature, deadline } = await signClose(who, s.splitId);
        await expect(split.connect(relayer).closeSplit(s.splitId, deadline, signature)).to.be.revertedWithCustomError(split, "InvalidSignature");
      }
      await pay(sam, s, 0);
    });

    it("replay: a close signature for one split can't close another, and a split closes once", async () => {
      const s = await openSplit();
      const other = await openSplit();
      const { signature, deadline } = await signClose(maya, s.splitId);
      await expect(split.connect(relayer).closeSplit(other.splitId, deadline, signature)).to.be.revertedWithCustomError(split, "InvalidSignature");
      await split.connect(relayer).closeSplit(s.splitId, deadline, signature);
      await expect(split.connect(relayer).closeSplit(s.splitId, deadline, signature)).to.be.revertedWithCustomError(split, "SplitIsClosed");
    });

    it("expiry: a close past its deadline, or valid for more than an hour, is refused", async () => {
      const s = await openSplit();
      const stale = await signClose(maya, s.splitId, await inSeconds(60));
      await time.increase(120);
      await expect(split.connect(relayer).closeSplit(s.splitId, stale.deadline, stale.signature)).to.be.revertedWithCustomError(split, "SignatureExpired");
      const long = await signClose(maya, s.splitId, await inSeconds(MAX_SIGNATURE_WINDOW + 60));
      await expect(split.connect(relayer).closeSplit(s.splitId, long.deadline, long.signature)).to.be.revertedWithCustomError(split, "SignatureWindowTooLong");
    });

    it("an expired split can still be closed; an unknown one can't", async () => {
      const s = await openSplit(maya, { expiresAt: await inSeconds(DAY) });
      await time.increase(DAY + 1);
      const { signature, deadline } = await signClose(maya, s.splitId);
      await split.connect(relayer).closeSplit(s.splitId, deadline, signature);
      const ghost = ethers.hexlify(ethers.randomBytes(32));
      const g = await signClose(maya, ghost);
      await expect(split.connect(relayer).closeSplit(ghost, g.deadline, g.signature)).to.be.revertedWithCustomError(split, "SplitNotFound");
    });
  });

  describe("expiry", () => {
    it("a split is payable until its expiry and not from it", async () => {
      const s = await openSplit(maya, { expiresAt: await inSeconds(DAY) });
      await time.increaseTo(s.expiresAt - 10n);
      const a = await signShare(sam, s.splitId, 0, AUSD(30));
      await submitShare(s.splitId, 0, sam.address, a);
      const b = await signShare(priya, s.splitId, 1, AUSD(30));
      await time.setNextBlockTimestamp(s.expiresAt);
      await expect(submitShare(s.splitId, 1, priya.address, b)).to.be.revertedWithCustomError(split, "SplitExpired");
    });

    it("a friend's authorization past its validBefore is refused by the token", async () => {
      const s = await openSplit();
      const a = await signShare(sam, s.splitId, 0, AUSD(30), { validBefore: await inSeconds(60) });
      await time.increase(120);
      await expect(submitShare(s.splitId, 0, sam.address, a)).to.be.revertedWithCustomError(ausd, "AuthorizationExpired");
    });

    it("a friend's authorization valid for more than an hour is refused, so a relayer can't sit on it", async () => {
      const s = await openSplit();
      const a = await signShare(sam, s.splitId, 0, AUSD(30), { validBefore: await inSeconds(MAX_SIGNATURE_WINDOW + 60) });
      await expect(submitShare(s.splitId, 0, sam.address, a)).to.be.revertedWithCustomError(split, "SignatureWindowTooLong");
    });

    it("a create past its deadline, or valid for more than an hour, is refused", async () => {
      const stale = await signCreate(maya, { deadline: await inSeconds(60) });
      await time.increase(120);
      await expect(split.connect(relayer).createSplit(stale.c, stale.signature)).to.be.revertedWithCustomError(split, "SignatureExpired");
      const long = await signCreate(maya, { deadline: await inSeconds(MAX_SIGNATURE_WINDOW + 60) });
      await expect(split.connect(relayer).createSplit(long.c, long.signature)).to.be.revertedWithCustomError(split, "SignatureWindowTooLong");
    });

    it("a split lives at least five minutes and at most sixty days", async () => {
      const at = async (seconds) => signCreate(maya, { expiresAt: await inSeconds(seconds) });
      // The next block is a second later than `time.latest()`, so the bounds are checked with a second's slack.
      const tooShort = await at(MIN_LIFETIME - 5);
      await expect(split.connect(relayer).createSplit(tooShort.c, tooShort.signature)).to.be.revertedWithCustomError(split, "InvalidExpiry");
      const tooLong = await at(MAX_EXPIRY + 60);
      await expect(split.connect(relayer).createSplit(tooLong.c, tooLong.signature)).to.be.revertedWithCustomError(split, "InvalidExpiry");
      const shortest = await at(MIN_LIFETIME + 5);
      await split.connect(relayer).createSplit(shortest.c, shortest.signature);
      const longest = await at(MAX_EXPIRY - 5);
      await split.connect(relayer).createSplit(longest.c, longest.signature);
    });
  });

  describe("creating", () => {
    it("wrong signer: only the organiser can open a split in their name", async () => {
      const { c, signature } = await signCreate(maya, { signer: attacker });
      await expect(split.connect(relayer).createSplit(c, signature)).to.be.revertedWithCustomError(split, "InvalidSignature");
    });

    it("a relayer can't change the amounts, the words, the expiry or the salt the organiser signed", async () => {
      const { c, signature } = await signCreate(maya);
      const tampered = [
        { ...c, amounts: [AUSD(300), AUSD(30), AUSD(30)] },
        { ...c, amounts: [AUSD(30), AUSD(30)] },
        { ...c, memoHash: ethers.ZeroHash },
        { ...c, expiresAt: c.expiresAt + 1n },
        { ...c, salt: ethers.ZeroHash },
        { ...c, organiser: attacker.address },
      ];
      for (const t of tampered) {
        await expect(split.connect(relayer).createSplit(t, signature)).to.be.revertedWithCustomError(split, "InvalidSignature");
      }
      await split.connect(relayer).createSplit(c, signature);
    });

    it("replay: a create lands once, and nobody can take a split's id first", async () => {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      const { c, signature } = await signCreate(maya, { salt });
      await split.connect(relayer).createSplit(c, signature);
      await expect(split.connect(relayer).createSplit(c, signature))
        .to.be.revertedWithCustomError(split, "SplitExists")
        .withArgs(splitIdOf(maya.address, salt));
      // The same salt under another organiser is another id: the attacker only opens a split of its own.
      const theirs = await signCreate(attacker, { salt });
      await split.connect(relayer).createSplit(theirs.c, theirs.signature);
      expect((await split.splitOf(splitIdOf(maya.address, salt))).organiser).to.equal(maya.address);
    });

    it("a signed create for one deployment is refused by another", async () => {
      const other = await (await ethers.getContractFactory("PolarisSplit")).deploy(await ausd.getAddress());
      const { c, signature } = await signCreate(maya, {}, other);
      await expect(split.connect(relayer).createSplit(c, signature)).to.be.revertedWithCustomError(split, "InvalidSignature");
    });

    it("shares: at least one, at most fifty, none zero, and the total fits", async () => {
      const refused = async (amounts, error) => {
        const { c, signature } = await signCreate(maya, { amounts });
        await expect(split.connect(relayer).createSplit(c, signature)).to.be.revertedWithCustomError(split, error);
      };
      await refused([], "NoShares");
      await refused(Array(51).fill(AUSD(1)), "TooManyShares");
      await refused([AUSD(1), 0n], "InvalidAmount");
      await refused([UINT128_MAX, 1n], "InvalidAmount");
      const fifty = await signCreate(maya, { amounts: Array(50).fill(AUSD(1)) });
      await split.connect(relayer).createSplit(fifty.c, fifty.signature);
      expect((await split.splitOf(splitIdOf(maya.address, fifty.c.salt))).shareCount).to.equal(50);
    });

    it("a split needs an organiser, and the contract needs a stablecoin", async () => {
      const { c, signature } = await signCreate(maya);
      await expect(split.connect(relayer).createSplit({ ...c, organiser: ethers.ZeroAddress }, signature)).to.be.revertedWithCustomError(split, "ZeroAddress");
      const factory = await ethers.getContractFactory("PolarisSplit");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(split, "ZeroAddress");
    });
  });

  describe("for clients", () => {
    it("the digests and nonce the contract exposes are the ones a wallet signs", async () => {
      const { c } = await signCreate(maya);
      const domain = await domainOf(split);
      expect(domain.name).to.equal("PolarisSplit");
      expect(domain.version).to.equal("1");
      expect(await split.createDigest(c)).to.equal(ethers.TypedDataEncoder.hash(domain, CREATE_TYPES, c));
      const splitId = splitIdOf(maya.address, c.salt);
      expect(await split.closeDigest(splitId, 123n)).to.equal(ethers.TypedDataEncoder.hash(domain, CLOSE_TYPES, { splitId, deadline: 123n }));
      expect(await split.shareNonce(splitId, 7)).to.equal(shareNonce(splitId, 7));
      expect(await split.CREATE_TYPEHASH()).to.equal(
        ethers.id("CreateSplit(address organiser,bytes32 salt,uint128[] amounts,bytes32 memoHash,uint64 expiresAt,uint256 deadline)")
      );
      expect(await split.CLOSE_TYPEHASH()).to.equal(ethers.id("CloseSplit(bytes32 splitId,uint256 deadline)"));
    });

    it("an unknown split reads as empty", async () => {
      const ghost = ethers.hexlify(ethers.randomBytes(32));
      expect((await split.splitOf(ghost)).organiser).to.equal(ethers.ZeroAddress);
      const [amounts, payers] = await split.sharesOf(ghost);
      expect(amounts).to.deep.equal([]);
      expect(payers).to.deep.equal([]);
    });
  });
});
