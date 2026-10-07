/**
 * Rehearsing real AUSD on a local fork of Monad testnet (deploy:fork,
 * fund-pool:fork, fork:smoke): the fork gets real AUSD and a record of its
 * own, never the testnet record; a plain local node still refuses AUSD; the
 * fork scripts refuse any node that is not a local fork of testnet; and the
 * testnet deploy refuses an RPC that is a local node. The run itself needs an
 * anvil fork, so it is not part of this suite (README, "Rehearse real AUSD on
 * a fork").
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const { buildConfig, deploymentFile, refuseWrongNode, FORK_NETWORKS, LOCAL_NETWORKS } = require("../../scripts/deploy-monad");
const { MONAD_TESTNET } = require("../../lib/deploy");
const { requireForkNode, devNodeInfo, dripUntil } = require("../../lib/fork");

/** A JSON-RPC provider that answers only `answers` (method -> result) and the given chain id. */
function fakeProvider(answers, chainId = 10143n) {
  return {
    send: async (method) => {
      if (!(method in answers)) throw new Error(`the method ${method} does not exist/is not available`);
      return answers[method];
    },
    getNetwork: async () => ({ chainId }),
  };
}

const anvilFork = { anvil_nodeInfo: { forkConfig: { forkUrl: "https://testnet-rpc.monad.xyz", forkBlockNumber: 68487690 } } };

async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e.message;
  }
  throw new Error("expected a refusal");
}

describe("rehearsing real AUSD on a fork", () => {
  let deployer, second;
  before(async () => {
    [deployer, second] = await ethers.getSigners();
  });

  describe("the deployment record", () => {
    it("a fork writes deployments/monad-fork.json, never the testnet record", () => {
      expect(deploymentFile("monadFork")).to.equal("monad-fork.json");
      for (const n of FORK_NETWORKS) expect(deploymentFile(n)).to.not.equal("monad-testnet.json");
      expect(deploymentFile("monadTestnet")).to.equal("monad-testnet.json");
      for (const n of LOCAL_NETWORKS) expect(deploymentFile(n)).to.equal("monad-local.json");
    });

    it("monadFork is chain 10143 on a local RPC, signed by the node's own accounts, never a key from .env", () => {
      const net = hre.config.networks.monadFork;
      expect(net.chainId).to.equal(10143);
      expect(net.url).to.match(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(net.accounts).to.equal("remote");
    });
  });

  describe("buildConfig", () => {
    it("on a fork: real AUSD, Chainlink's simulation forwarder, the node's second account as transmitter, a throwaway merchant", async () => {
      const cfg = await buildConfig("monadFork", deployer, { env: {}, accounts: [deployer, second] });
      expect(cfg.tokenMode).to.equal("ausd");
      expect(cfg.tokenAddress).to.equal(MONAD_TESTNET.AUSD);
      expect(cfg.forwarderKind).to.equal("simulation");
      expect(cfg.forwarderAddress).to.equal(MONAD_TESTNET.CRE_MOCK_FORWARDER);
      expect(cfg.simulationTransmitter).to.equal(second.address);
      expect(cfg.mintToDeployer).to.equal(0n);
      const again = await buildConfig("monadFork", deployer, { env: {}, accounts: [deployer, second] });
      expect(again.demoMerchant.address).to.not.equal(cfg.demoMerchant.address);
    });

    it("on a fork: CRE_SIMULATION_TRANSMITTER wins, and the deployer is refused however it is given", async () => {
      const cre = ethers.Wallet.createRandom().address;
      const cfg = await buildConfig("monadFork", deployer, { env: { CRE_SIMULATION_TRANSMITTER: cre }, accounts: [deployer, second] });
      expect(cfg.simulationTransmitter).to.equal(cre);
      expect(await rejects(buildConfig("monadFork", deployer, { env: { CRE_SIMULATION_TRANSMITTER: deployer.address }, accounts: [deployer, second] })))
        .to.match(/must not be the deployer/);
      expect(await rejects(buildConfig("monadFork", deployer, { env: {}, accounts: [deployer] }))).to.match(/one account/);
    });

    it("on a fork, AUSD_MODE=mock still works", async () => {
      const cfg = await buildConfig("monadFork", deployer, { env: { AUSD_MODE: "mock" }, accounts: [deployer, second] });
      expect(cfg.tokenMode).to.equal("mock");
      expect(cfg.tokenAddress).to.equal(undefined);
    });

    it("a plain local node still refuses AUSD_MODE=ausd", async () => {
      for (const n of LOCAL_NETWORKS) {
        expect(await rejects(buildConfig(n, deployer, { env: { AUSD_MODE: "ausd" } }))).to.match(/local node has no AUSD/);
      }
    });
  });

  describe("which node", () => {
    it("the fork scripts take a local anvil fork of chain 10143", async () => {
      const info = await requireForkNode(fakeProvider(anvilFork));
      expect(info).to.deep.equal({ kind: "anvil", forkUrl: "https://testnet-rpc.monad.xyz", forkBlock: 68487690 });
      await refuseWrongNode("monadFork", fakeProvider(anvilFork));
    });

    it("and refuse a public RPC, a node that is not a fork, and a fork on another chain id", async () => {
      expect(await rejects(refuseWrongNode("monadFork", fakeProvider({})))).to.match(/not a local development node/);
      expect(await rejects(refuseWrongNode("monadFork", ethers.provider))).to.match(/not a fork/);
      expect(await rejects(refuseWrongNode("monadFork", fakeProvider({ anvil_nodeInfo: { forkConfig: {} } })))).to.match(/not a fork/);
      expect(await rejects(refuseWrongNode("monadFork", fakeProvider(anvilFork, 31337n)))).to.match(/--chain-id 10143/);
    });

    it("the testnet deploy refuses an RPC that is a local node, so a fork cannot overwrite the testnet record", async () => {
      expect(await devNodeInfo(ethers.provider)).to.include({ kind: "hardhat", forkUrl: null });
      expect(await rejects(refuseWrongNode("monadTestnet", ethers.provider))).to.match(/local hardhat node/);
      expect(await rejects(refuseWrongNode("monadTestnet", fakeProvider(anvilFork)))).to.match(/local anvil node/);
      await refuseWrongNode("monadTestnet", fakeProvider({}));
    });

    it("the faucet helper sends nothing on a node that is not a fork", async () => {
      const nonce = await ethers.provider.getTransactionCount(deployer.address);
      const message = await rejects(
        dripUntil({ provider: ethers.provider, signer: deployer, token: null, to: deployer.address, target: 1n })
      );
      expect(message).to.match(/not a fork/);
      expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(nonce);
    });
  });
});
