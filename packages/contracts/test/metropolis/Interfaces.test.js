/**
 * The interfaces other packages build against stay true to the contracts:
 * the exported ABIs in abi/, and the EIP-712 struct types in lib/eip712.js
 * that the deployment record publishes and every client signs.
 */
const { expect } = require("chai");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");
const { ethers } = hre;

const { CONTRACTS, ABI_DIR, camel } = require("../../scripts/export-abi");
const { TYPES, DOMAIN_NAMES, AUSD_DOMAIN_NAME, typeString } = require("../../lib/eip712");

describe("Published interfaces", () => {
  describe("abi/", () => {
    it("every exported ABI equals its compiled artifact (run `pnpm abi` after changing a contract)", async () => {
      for (const name of CONTRACTS) {
        const artifact = await hre.artifacts.readArtifact(name);
        // Compared as canonical JSON: the file is JSON.stringify of the artifact's ABI.
        const exported = JSON.stringify(JSON.parse(readFileSync(join(ABI_DIR, `${name}.json`), "utf8")));
        expect(exported === JSON.stringify(artifact.abi), `abi/${name}.json is stale`).to.equal(true);
      }
    });

    it("the indexes export every ABI under its documented name", () => {
      const cjs = require(join(ABI_DIR, "index.js"));
      const dts = readFileSync(join(ABI_DIR, "index.d.ts"), "utf8");
      const esm = readFileSync(join(ABI_DIR, "index.mjs"), "utf8");
      for (const name of CONTRACTS) {
        const id = `${camel(name)}Abi`;
        const file = JSON.stringify(JSON.parse(readFileSync(join(ABI_DIR, `${name}.json`), "utf8")));
        expect(JSON.stringify(cjs[id]) === file, `index.js ${id}`).to.equal(true);
        expect(dts).to.include(`export declare const ${id}: readonly [`);
        expect(esm).to.include(`export const ${id} = [`);
      }
      expect(Object.keys(cjs)).to.include.members(["polarisCheckoutAbi", "collectionsReceiverAbi", "underwritingReceiverAbi", "iausdAbi"]);
    });
  });

  describe("EIP-712", () => {
    const deployed = {};

    before(async () => {
      const [owner] = await ethers.getSigners();
      const ausd = await (await ethers.getContractFactory("MockAUSD")).deploy();
      const scores = await (await ethers.getContractFactory("ScoreManager")).deploy(owner.address);
      const engine = await (await ethers.getContractFactory("PolarisLoanEngine")).deploy(owner.address, ausd, scores, owner.address, 0, 0);
      const payments = await (await ethers.getContractFactory("PolarisPayments")).deploy(owner.address, ausd, owner.address, 0);
      Object.assign(deployed, {
        MockAUSD: ausd,
        PolarisLoanEngine: engine,
        PolarisPayments: payments,
        PolarisCheckout: await (await ethers.getContractFactory("PolarisCheckout")).deploy(owner.address, engine, payments, scores),
        PolarisSend: await (await ethers.getContractFactory("PolarisSend")).deploy(ausd),
        PolarisSplit: await (await ethers.getContractFactory("PolarisSplit")).deploy(ausd),
        MerchantRegistry: await (await ethers.getContractFactory("MerchantRegistry")).deploy(owner.address),
        CollateralVault: await (await ethers.getContractFactory("CollateralVault")).deploy(owner.address, ausd),
      });
    });

    it("every typehash constant is the keccak of the struct type published in lib/eip712.js", async () => {
      const cases = [
        ["PolarisCheckout", "PLAN_INTENT_TYPEHASH", "PolarisCheckout", "PlanIntent"],
        ["PolarisCheckout", "SUBSCRIBE_INTENT_TYPEHASH", "PolarisCheckout", "SubscribeIntent"],
        ["PolarisLoanEngine", "REPAY_INTENT_TYPEHASH", "PolarisLoanEngine", "RepayIntent"],
        ["PolarisPayments", "CANCEL_SUBSCRIPTION_TYPEHASH", "PolarisPayments", "CancelSubscription"],
        ["PolarisSend", "OPEN_TYPEHASH", "PolarisSend", "Open"],
        ["PolarisSend", "CLAIM_TYPEHASH", "PolarisSend", "Claim"],
        ["PolarisSend", "CANCEL_TYPEHASH", "PolarisSend", "Cancel"],
        ["PolarisSplit", "CREATE_TYPEHASH", "PolarisSplit", "CreateSplit"],
        ["PolarisSplit", "CLOSE_TYPEHASH", "PolarisSplit", "CloseSplit"],
        ["MerchantRegistry", "REGISTRATION_TYPEHASH", "MerchantRegistry", "Registration"],
        ["MerchantRegistry", "PAYOUT_UPDATE_TYPEHASH", "MerchantRegistry", "PayoutUpdate"],
        ["CollateralVault", "WITHDRAW_TYPEHASH", "CollateralVault", "Withdraw"],
        ["MockAUSD", "RECEIVE_WITH_AUTHORIZATION_TYPEHASH", "Stablecoin", "ReceiveWithAuthorization"],
        ["MockAUSD", "TRANSFER_WITH_AUTHORIZATION_TYPEHASH", "Stablecoin", "TransferWithAuthorization"],
      ];
      for (const [contract, constant, group, primary] of cases) {
        const s = typeString(primary, TYPES[group][primary]);
        expect(await deployed[contract][constant](), `${contract}.${constant} vs "${s}"`).to.equal(ethers.id(s));
      }
      expect(typeString("Permit", TYPES.Stablecoin.Permit)).to.equal(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
      );
    });

    it("every contract signs under the domain name and version published for it", async () => {
      for (const [name, { name: dn, version }] of Object.entries(DOMAIN_NAMES)) {
        const d = await deployed[name].eip712Domain();
        expect([d.name, d.version], name).to.deep.equal([dn, version]);
      }
      const t = await deployed.MockAUSD.eip712Domain();
      expect([t.name, t.version]).to.deep.equal([AUSD_DOMAIN_NAME.name, AUSD_DOMAIN_NAME.version]);
      expect(await deployed.MockAUSD.name()).to.equal("Mock AUSD", "name() is not the EIP-712 name, as on real AUSD");
    });
  });
});
