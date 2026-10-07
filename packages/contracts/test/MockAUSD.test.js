const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { signPermit, signReceive, signTransfer } = require("./helpers/sign");

const AUSD = (n) => ethers.parseUnits(String(n), 6);

describe("MockAUSD: the gasless standards Polaris relies on", () => {
  let ausd, alice, bob, relayer;

  beforeEach(async () => {
    [, alice, bob, relayer] = await ethers.getSigners();
    ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
    await ausd.mint(alice.address, AUSD(1_000));
  });

  it("has six decimals, like AUSD", async () => {
    expect(await ausd.decimals()).to.equal(6);
  });

  describe("ERC-2612 permit", () => {
    it("sets an allowance from a signature someone else submits", async () => {
      const p = await signPermit(ausd, alice, bob.address, AUSD(250));
      await ausd.connect(relayer).permit(alice.address, bob.address, p.value, p.deadline, p.v, p.r, p.s);
      expect(await ausd.allowance(alice.address, bob.address)).to.equal(AUSD(250));
    });

    it("refuses a replayed permit", async () => {
      const p = await signPermit(ausd, alice, bob.address, AUSD(250));
      await ausd.permit(alice.address, bob.address, p.value, p.deadline, p.v, p.r, p.s);
      await expect(ausd.permit(alice.address, bob.address, p.value, p.deadline, p.v, p.r, p.s)).to.be
        .reverted;
    });
  });

  describe("ERC-3009", () => {
    const nonce = ethers.id("order-1");

    it("moves funds on a transfer authorization anyone submits", async () => {
      const a = await signTransfer(ausd, alice, bob.address, AUSD(40), nonce);
      await ausd
        .connect(relayer)
        .transferWithAuthorization(alice.address, bob.address, a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s);
      expect(await ausd.balanceOf(bob.address)).to.equal(AUSD(40));
      expect(await ausd.authorizationState(alice.address, nonce)).to.equal(true);
    });

    it("refuses to use the same authorization twice", async () => {
      const a = await signTransfer(ausd, alice, bob.address, AUSD(40), nonce);
      const args = [alice.address, bob.address, a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s];
      await ausd.transferWithAuthorization(...args);
      await expect(ausd.transferWithAuthorization(...args)).to.be.revertedWithCustomError(
        ausd,
        "AuthorizationAlreadyUsed"
      );
    });

    it("refuses a receive authorization submitted by anyone but the payee", async () => {
      const a = await signReceive(ausd, alice, bob.address, AUSD(40), nonce);
      await expect(
        ausd
          .connect(relayer)
          .receiveWithAuthorization(alice.address, bob.address, a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s)
      ).to.be.revertedWithCustomError(ausd, "CallerMustBePayee");
      await ausd
        .connect(bob)
        .receiveWithAuthorization(alice.address, bob.address, a.value, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s);
      expect(await ausd.balanceOf(bob.address)).to.equal(AUSD(40));
    });

    it("refuses an authorization whose amount was changed after signing", async () => {
      const a = await signTransfer(ausd, alice, bob.address, AUSD(40), nonce);
      await expect(
        ausd.transferWithAuthorization(alice.address, bob.address, AUSD(400), a.validAfter, a.validBefore, nonce, a.v, a.r, a.s)
      ).to.be.revertedWithCustomError(ausd, "InvalidAuthorizationSignature");
    });

    it("refuses an expired authorization", async () => {
      const validBefore = BigInt(await time.latest()) + 60n;
      const a = await signTransfer(ausd, alice, bob.address, AUSD(40), nonce, { validBefore });
      await time.increase(120);
      await expect(
        ausd.transferWithAuthorization(alice.address, bob.address, a.value, a.validAfter, validBefore, nonce, a.v, a.r, a.s)
      ).to.be.revertedWithCustomError(ausd, "AuthorizationExpired");
    });
  });
});
