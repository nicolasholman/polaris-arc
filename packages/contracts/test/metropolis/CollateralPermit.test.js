/**
 * CollateralVault.lockWithPermit: collateral a relayer carries, so a borrower
 * who secures a Pay in 4 line never holds MON.
 *
 * The permit is the borrower's consent (spender: the vault, value: the
 * amount), and the vault only moves it into the borrower's own position. It is
 * not wrapped in try/catch, so a standing allowance can't be used to lock a
 * borrower's dollars without a fresh signature.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { signPermit } = require("../helpers/sign");

const USD = (n) => BigInt(Math.round(n * 1e6));

describe("CollateralVault.lockWithPermit (gasless collateral)", () => {
  let token, vault, owner, borrower, relayer, stranger;

  beforeEach(async () => {
    [owner, borrower, relayer, stranger] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockAUSD")).deploy();
    vault = await (await ethers.getContractFactory("CollateralVault")).deploy(owner.address, await token.getAddress());
    await token.mint(borrower.address, USD(500));
  });

  it("locks for the borrower who signed, submitted by anyone, and the borrower sends nothing", async () => {
    const vaultAddress = await vault.getAddress();
    const p = await signPermit(token, borrower, vaultAddress, USD(202), BigInt((await ethers.provider.getBlock("latest")).timestamp + 600));
    const nonceBefore = await ethers.provider.getTransactionCount(borrower.address);

    await expect(vault.connect(relayer).lockWithPermit(borrower.address, USD(202), p.deadline, p.v, p.r, p.s))
      .to.emit(vault, "CollateralLocked")
      .withArgs(borrower.address, USD(202), USD(202));

    expect(await vault.lockedOf(borrower.address)).to.equal(USD(202));
    expect(await vault.lockedOf(relayer.address)).to.equal(0n);
    expect(await vault.totalLocked()).to.equal(USD(202));
    expect(await token.balanceOf(borrower.address)).to.equal(USD(298));
    expect(await token.allowance(borrower.address, vaultAddress)).to.equal(0n);
    expect(await ethers.provider.getTransactionCount(borrower.address)).to.equal(nonceBefore);
  });

  it("refuses an amount other than the one the borrower signed", async () => {
    const p = await signPermit(token, borrower, await vault.getAddress(), USD(10));
    await expect(vault.connect(relayer).lockWithPermit(borrower.address, USD(400), p.deadline, p.v, p.r, p.s)).to.be.reverted;
    expect(await vault.lockedOf(borrower.address)).to.equal(0n);
  });

  it("refuses a permit signed by someone else, or for another spender", async () => {
    const vaultAddress = await vault.getAddress();
    await token.mint(stranger.address, USD(50));
    const fromStranger = await signPermit(token, stranger, vaultAddress, USD(50));
    await expect(vault.connect(relayer).lockWithPermit(borrower.address, USD(50), fromStranger.deadline, fromStranger.v, fromStranger.r, fromStranger.s)).to.be.reverted;

    const toRelayer = await signPermit(token, borrower, relayer.address, USD(50));
    await expect(vault.connect(relayer).lockWithPermit(borrower.address, USD(50), toRelayer.deadline, toRelayer.v, toRelayer.r, toRelayer.s)).to.be.reverted;
    expect(await vault.totalLocked()).to.equal(0n);
  });

  it("never falls back to a standing allowance: no signature, no lock", async () => {
    const vaultAddress = await vault.getAddress();
    await token.connect(borrower).approve(vaultAddress, USD(500));
    const junk = { v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash };
    await expect(vault.connect(stranger).lockWithPermit(borrower.address, USD(100), ethers.MaxUint256, junk.v, junk.r, junk.s)).to.be.reverted;
    expect(await vault.lockedOf(borrower.address)).to.equal(0n);
    expect(await token.allowance(borrower.address, vaultAddress)).to.equal(USD(500));
  });

  it("can't be replayed, and a permit someone submitted first only makes it revert", async () => {
    const vaultAddress = await vault.getAddress();
    const p = await signPermit(token, borrower, vaultAddress, USD(20));
    await vault.connect(relayer).lockWithPermit(borrower.address, USD(20), p.deadline, p.v, p.r, p.s);
    await expect(vault.connect(relayer).lockWithPermit(borrower.address, USD(20), p.deadline, p.v, p.r, p.s)).to.be.reverted;

    const q = await signPermit(token, borrower, vaultAddress, USD(30));
    await token.connect(stranger).permit(borrower.address, vaultAddress, USD(30), q.deadline, q.v, q.r, q.s);
    await expect(vault.connect(relayer).lockWithPermit(borrower.address, USD(30), q.deadline, q.v, q.r, q.s)).to.be.reverted;
    expect(await vault.lockedOf(borrower.address)).to.equal(USD(20));
  });

  it("refuses zero, and an expired permit", async () => {
    const vaultAddress = await vault.getAddress();
    const zero = await signPermit(token, borrower, vaultAddress, 0n);
    await expect(vault.lockWithPermit(borrower.address, 0n, zero.deadline, zero.v, zero.r, zero.s)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const old = await signPermit(token, borrower, vaultAddress, USD(5), BigInt(now - 1));
    await expect(vault.lockWithPermit(borrower.address, USD(5), old.deadline, old.v, old.r, old.s)).to.be.reverted;
  });

  it("locks exactly like lock(): withdraw returns it to the borrower", async () => {
    const p = await signPermit(token, borrower, await vault.getAddress(), USD(40));
    await vault.connect(relayer).lockWithPermit(borrower.address, USD(40), p.deadline, p.v, p.r, p.s);
    expect(await vault.creditBoostOf(borrower.address)).to.equal(USD(60));
    await vault.connect(borrower).withdraw(USD(40));
    expect(await token.balanceOf(borrower.address)).to.equal(USD(500));
  });
});
