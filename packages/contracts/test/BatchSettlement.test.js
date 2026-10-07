const { expect } = require("chai");
const { ethers } = require("hardhat");
const U = (n) => BigInt(Math.round(n * 1e6));
const memo = (s) => ethers.encodeBytes32String(s);

describe("BatchSettlement", () => {
  let usdc, batch, owner, keeper, m1, m2, m3;

  beforeEach(async () => {
    [owner, keeper, m1, m2, m3] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    batch = await (await ethers.getContractFactory("BatchSettlement"))
      .deploy(owner.address, await usdc.getAddress());
    await batch.setSettler(keeper.address, true);
    await usdc.approve(await batch.getAddress(), U(1_000_000));
    await batch.fund(U(10_000));
  });

  it("pays every merchant in one transaction", async () => {
    const before = await Promise.all([m1, m2, m3].map((m) => usdc.balanceOf(m.address)));
    await batch.connect(keeper).settleBatch(
      memo("batch-1"),
      [m1.address, m2.address, m3.address],
      [U(100), U(250), U(37.5)],
      [memo("INV-1"), memo("INV-2"), memo("INV-3")]
    );
    expect(await usdc.balanceOf(m1.address)).to.equal(before[0] + U(100));
    expect(await usdc.balanceOf(m2.address)).to.equal(before[1] + U(250));
    expect(await usdc.balanceOf(m3.address)).to.equal(before[2] + U(37.5));
  });

  it("emits an indexed memo per leg, so a merchant can find their own payment", async () => {
    await expect(
      batch.connect(keeper).settleBatch(memo("b2"), [m1.address], [U(5)], [memo("INV-42")])
    )
      .to.emit(batch, "MerchantPaid")
      .withArgs(memo("b2"), m1.address, U(5), memo("INV-42"));
  });

  it("refuses to run the same batch twice, so a retry cannot double-pay", async () => {
    await batch.connect(keeper).settleBatch(memo("b3"), [m1.address], [U(10)], [memo("I")]);
    await expect(
      batch.connect(keeper).settleBatch(memo("b3"), [m1.address], [U(10)], [memo("I")])
    ).to.be.revertedWithCustomError(batch, "BatchAlreadyExecuted");
  });

  it("is atomic — a shortfall pays nobody, rather than paying some", async () => {
    const before = await usdc.balanceOf(m1.address);
    await expect(
      batch.connect(keeper).settleBatch(
        memo("b4"),
        [m1.address, m2.address],
        [U(50), U(999_999)],
        [memo("A"), memo("B")]
      )
    ).to.be.revertedWithCustomError(batch, "InsufficientBalance");
    // m1 was first in the list and would have been paid by a naive loop.
    expect(await usdc.balanceOf(m1.address)).to.equal(before);
  });

  it("reports whether a batch would succeed without sending it", async () => {
    const [ok, required, available] = await batch.canSettle(memo("b5"), [U(100), U(200)]);
    expect(ok).to.equal(true);
    expect(required).to.equal(U(300));
    expect(available).to.equal(U(10_000));

    const [tooBig] = await batch.canSettle(memo("b5"), [U(99_999)]);
    expect(tooBig).to.equal(false);
  });

  it("rejects an unregistered settler", async () => {
    await expect(
      batch.connect(m1).settleBatch(memo("b6"), [m1.address], [U(1)], [memo("X")])
    ).to.be.revertedWithCustomError(batch, "NotSettler");
  });

  it("rejects mismatched array lengths rather than paying a wrong amount", async () => {
    await expect(
      batch.connect(keeper).settleBatch(memo("b7"), [m1.address, m2.address], [U(1)], [memo("X")])
    ).to.be.revertedWithCustomError(batch, "LengthMismatch");
  });

  it("names the offending index on a bad recipient", async () => {
    await expect(
      batch.connect(keeper).settleBatch(
        memo("b8"),
        [m1.address, ethers.ZeroAddress],
        [U(1), U(1)],
        [memo("A"), memo("B")]
      )
    ).to.be.revertedWithCustomError(batch, "ZeroRecipient").withArgs(1);
  });

  it("tracks cumulative settled volume", async () => {
    await batch.connect(keeper).settleBatch(memo("b9"), [m1.address], [U(10)], [memo("A")]);
    await batch.connect(keeper).settleBatch(memo("b10"), [m2.address], [U(15)], [memo("B")]);
    expect(await batch.totalSettled()).to.equal(U(25));
    expect(await batch.batchCount()).to.equal(2);
  });

  it("settles 50 merchants in a single transaction", async () => {
    const wallets = Array.from({ length: 50 }, (_, i) =>
      ethers.getAddress("0x" + (i + 1).toString(16).padStart(40, "0"))
    );
    const amounts = wallets.map(() => U(1));
    const memos = wallets.map((_, i) => memo(`INV-${i}`));

    const tx = await batch.connect(keeper).settleBatch(memo("bulk"), wallets, amounts, memos);
    const receipt = await tx.wait();
    expect(await usdc.balanceOf(wallets[0])).to.equal(U(1));
    expect(await usdc.balanceOf(wallets[49])).to.equal(U(1));
    // One transaction instead of fifty is the entire point.
    console.log(`      50 merchants paid in one tx, ${receipt.gasUsed} gas (${Math.round(Number(receipt.gasUsed) / 50)}/merchant)`);
  });
});
