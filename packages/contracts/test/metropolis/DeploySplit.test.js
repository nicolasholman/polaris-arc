/**
 * PolarisSplit in a deployment: a fresh deployment includes it (lib/deploy.js),
 * and lib/split.js (scripts/deploy-split.js, `deploy-split:monad`) adds it to
 * one that predates it, such as Monad testnet's of 28 Sep 2026, in one
 * transaction that moves nothing else. The deployment then reads back clean.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const { deployPolaris, USD } = require("../../lib/deploy");
const { checkDeployment } = require("../../lib/check");
const { addSplit } = require("../../lib/split");
const { TYPES } = require("../../lib/eip712");

describe("PolarisSplit in a deployment", function () {
  this.timeout(300_000);
  let record, deployer;

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();
    record = JSON.parse(
      JSON.stringify(
        await deployPolaris(hre, {
          tokenMode: "mock",
          treasury: deployer.address,
          graceSeconds: 120,
          minInterval: 60,
          minPeriod: 60,
          forwarderKind: "local",
          simulationTransmitter: deployer.address,
          demoMerchant: ethers.Wallet.createRandom(),
          poolSeed: USD(1_000),
        }),
        (_, v) => (typeof v === "bigint" ? v.toString() : v)
      )
    );
  });

  it("a fresh deployment has PolarisSplit on the record's stablecoin, with its EIP-712 domain", async () => {
    const c = record.contracts.PolarisSplit;
    expect(c.abi).to.equal("abi/PolarisSplit.json");
    expect(c.args).to.deep.equal([record.contracts.Stablecoin.address]);
    const split = await ethers.getContractAt("PolarisSplit", c.address);
    expect(await split.stablecoin()).to.equal(record.contracts.Stablecoin.address);
    expect(record.eip712.PolarisSplit.domain).to.deep.equal({ name: "PolarisSplit", version: "1", chainId: 31337, verifyingContract: c.address });
    expect(record.eip712.PolarisSplit.types).to.deep.equal(TYPES.PolarisSplit);
  });

  it("adds PolarisSplit to a deployment that predates it, and nothing else changes", async () => {
    const before = JSON.parse(JSON.stringify(record));
    delete before.contracts.PolarisSplit;
    delete before.eip712.PolarisSplit;

    const lines = [];
    const { record: next, txs } = await addSplit(hre, before, { allowDirty: true }, (l) => lines.push(l));
    expect(txs).to.have.length(1);
    expect(lines.join("\n")).to.include("PolarisSplit");
    const added = next.contracts.PolarisSplit;
    expect(await ethers.provider.getCode(added.address)).to.not.equal("0x");
    expect(added.args).to.deep.equal([before.contracts.Stablecoin.address]);
    expect(added.sourceCommit).to.match(/^[0-9a-f]{40}$/);
    expect(next.eip712.PolarisSplit.domain.verifyingContract).to.equal(added.address);
    expect(next.additions.at(-1)).to.include({ contract: "PolarisSplit", address: added.address });
    // Every other contract, role and domain is exactly as it was.
    for (const [name, c] of Object.entries(before.contracts)) expect(next.contracts[name], name).to.deep.equal(c);
    expect(next.roles).to.deep.equal(before.roles);
    expect(next.eip712.PolarisCheckout).to.deep.equal(before.eip712.PolarisCheckout);
    // The input record is not mutated.
    expect(before.contracts.PolarisSplit).to.equal(undefined);

    const rows = await checkDeployment(ethers, next);
    const failed = rows.filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed)).to.deep.equal([]);
    expect(rows.map((r) => r.what)).to.include("PolarisSplit has code");
  });

  it("refuses a deployment that already has it, or one with no stablecoin", async () => {
    await expect(addSplit(hre, record, { allowDirty: true })).to.be.rejectedWith(/already deployed/);
    const noToken = JSON.parse(JSON.stringify(record));
    delete noToken.contracts.Stablecoin;
    delete noToken.contracts.PolarisSplit;
    await expect(addSplit(hre, noToken, { allowDirty: true })).to.be.rejectedWith(/no Stablecoin/);
  });
});
