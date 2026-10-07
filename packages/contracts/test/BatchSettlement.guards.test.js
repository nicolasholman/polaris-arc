/**
 * Input validation and accounting for BatchSettlement.
 *
 * The happy path is covered in BatchSettlement.test.js. What is covered here is
 * the set of ways a keeper can build a malformed batch, because the keeper is
 * an automated caller: a batch assembled from a bad database row will be sent
 * without a human ever looking at it, and the only thing standing between that
 * and a wrong payout is these reverts.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const U = (n) => BigInt(Math.round(n * 1e6));
const memo = (s) => ethers.encodeBytes32String(s);

describe("BatchSettlement guards", () => {
  let usdc, batch, owner, keeper, m1, m2, outsider;

  beforeEach(async () => {
    [owner, keeper, m1, m2, outsider] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    batch = await (
      await ethers.getContractFactory("BatchSettlement")
    ).deploy(owner.address, await usdc.getAddress());
    await batch.setSettler(keeper.address, true);
    await usdc.approve(await batch.getAddress(), U(1_000_000));
    await batch.fund(U(10_000));
  });

  describe("malformed batches", () => {
    it("rejects an empty batch rather than emitting a settlement of nothing", async () => {
      await expect(
        batch.connect(keeper).settleBatch(memo("empty"), [], [], [])
      ).to.be.revertedWithCustomError(batch, "EmptyBatch");
    });

    it("names the offending index on a zero amount", async () => {
      await expect(
        batch
          .connect(keeper)
          .settleBatch(
            memo("z"),
            [m1.address, m2.address],
            [U(5), 0n],
            [memo("A"), memo("B")]
          )
      )
        .to.be.revertedWithCustomError(batch, "ZeroAmount")
        .withArgs(1);
    });

    it("rejects a memo array of the wrong length", async () => {
      // The amounts line up but the memos do not, so a merchant would be paid
      // against somebody else's invoice reference.
      await expect(
        batch
          .connect(keeper)
          .settleBatch(
            memo("mm"),
            [m1.address, m2.address],
            [U(1), U(2)],
            [memo("only-one")]
          )
      ).to.be.revertedWithCustomError(batch, "LengthMismatch");
    });

    it("rejects a batch larger than one block can carry", async () => {
      const n = Number(await batch.MAX_BATCH()) + 1;
      const wallets = Array.from({ length: n }, (_, i) =>
        ethers.getAddress("0x" + (i + 1).toString(16).padStart(40, "0"))
      );
      await expect(
        batch
          .connect(keeper)
          .settleBatch(
            memo("huge"),
            wallets,
            wallets.map(() => 1n),
            wallets.map(() => memo("x"))
          )
      )
        .to.be.revertedWithCustomError(batch, "BatchTooLarge")
        .withArgs(n);
    });

    it("reports the shortfall in the revert, so the keeper knows how much to top up", async () => {
      const pot = await usdc.balanceOf(await batch.getAddress());
      await expect(
        batch.connect(keeper).settleBatch(memo("short"), [m1.address], [pot + 1n], [memo("A")])
      )
        .to.be.revertedWithCustomError(batch, "InsufficientBalance")
        .withArgs(pot, pot + 1n);
    });
  });

  describe("accounting", () => {
    it("moves exactly the batch total out of the pot, and no more", async () => {
      const potBefore = await usdc.balanceOf(await batch.getAddress());
      const amounts = [U(100), U(250.5)];

      await batch
        .connect(keeper)
        .settleBatch(memo("acct"), [m1.address, m2.address], amounts, [memo("A"), memo("B")]);

      const total = amounts.reduce((a, b) => a + b, 0n);
      expect(await usdc.balanceOf(await batch.getAddress())).to.equal(potBefore - total);
    });

    it("emits BatchSettled with the recipient count, total and the settler that ran it", async () => {
      await expect(
        batch
          .connect(keeper)
          .settleBatch(
            memo("evt"),
            [m1.address, m2.address],
            [U(3), U(7)],
            [memo("A"), memo("B")]
          )
      )
        .to.emit(batch, "BatchSettled")
        .withArgs(memo("evt"), 2, U(10), keeper.address);
    });

    it("returns the batch total to the caller, so a keeper can reconcile without a log read", async () => {
      const total = await batch
        .connect(keeper)
        .settleBatch.staticCall(memo("ret"), [m1.address], [U(42)], [memo("A")]);
      expect(total).to.equal(U(42));
    });

    it("scopes the replay guard to the batch id, so a later batch is unaffected", async () => {
      await batch.connect(keeper).settleBatch(memo("first"), [m1.address], [U(10)], [memo("A")]);
      await expect(
        batch.connect(keeper).settleBatch(memo("second"), [m1.address], [U(10)], [memo("A")])
      ).to.not.be.reverted;
      expect(await batch.batchExecuted(memo("first"))).to.equal(true);
      expect(await batch.batchExecuted(memo("second"))).to.equal(true);
    });

    it("canSettle turns false once the id has been used, so a retry is caught before sending", async () => {
      const amounts = [U(10)];
      expect((await batch.canSettle(memo("dup"), amounts))[0]).to.equal(true);
      await batch.connect(keeper).settleBatch(memo("dup"), [m1.address], amounts, [memo("A")]);
      expect((await batch.canSettle(memo("dup"), amounts))[0]).to.equal(false);
    });
  });

  describe("access control", () => {
    it("rejects a settler whose permission has been revoked", async () => {
      await batch.setSettler(keeper.address, false);
      await expect(
        batch.connect(keeper).settleBatch(memo("revoked"), [m1.address], [U(1)], [memo("A")])
      ).to.be.revertedWithCustomError(batch, "NotSettler");
    });

    it("refuses to let a non-owner appoint themselves settler", async () => {
      await expect(
        batch.connect(outsider).setSettler(outsider.address, true)
      ).to.be.revertedWithCustomError(batch, "OwnableUnauthorizedAccount");
    });

    it("refuses to let a non-owner drain the pot", async () => {
      await expect(
        batch.connect(outsider).withdraw(U(1), outsider.address)
      ).to.be.revertedWithCustomError(batch, "OwnableUnauthorizedAccount");
    });

    it("lets anyone top up the pot, since funding can only add value", async () => {
      await usdc.mint(outsider.address, U(500));
      await usdc.connect(outsider).approve(await batch.getAddress(), U(500));
      const before = await usdc.balanceOf(await batch.getAddress());
      await expect(batch.connect(outsider).fund(U(500)))
        .to.emit(batch, "Funded")
        .withArgs(outsider.address, U(500));
      expect(await usdc.balanceOf(await batch.getAddress())).to.equal(before + U(500));
    });
  });
});
