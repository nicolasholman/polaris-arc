/**
 * The committed Monad testnet deployment record, and the hand-kept copies of
 * its addresses in the apps' example env files: they must agree, and the
 * record must describe what decision 24 and the CRE setup require (a labelled
 * mock dollar, the simulation forwarder, a transmitter that is not the
 * deployer). Reads files only; the chain itself is checked by
 * check:deployment:monad (lib/check.js).
 */
const { expect } = require("chai");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { getAddress } = require("ethers");

const REPO = join(__dirname, "..", "..", "..", "..");
const RECORD = join(__dirname, "..", "..", "deployments", "monad-testnet.json");

describe("deployments/monad-testnet.json", function () {
  before(function () {
    if (!existsSync(RECORD)) this.skip();
  });
  const record = () => JSON.parse(readFileSync(RECORD, "utf8"));
  const at = (name) => getAddress(record().contracts[name].address);
  const read = (p) => readFileSync(join(REPO, p), "utf8");

  it("is Monad testnet with a labelled mock dollar behind Chainlink's simulation forwarder", () => {
    const r = record();
    expect(r.chainId).to.equal(10143);
    expect(r.config.tokenMode).to.equal("mock");
    expect(r.contracts.Stablecoin.kind).to.equal("MockAUSD");
    expect(r.cre.forwarderKind).to.equal("simulation");
    expect(getAddress(r.cre.forwarder)).to.equal("0xB9F79d863261869B234c481D1f9A7af84AeAd192");
    expect(getAddress(r.cre.simulationTransmitter)).to.not.equal(getAddress(r.deployer));
    expect(r.cre.workflows.guardian.priceFeed).to.include({ chainSelectorName: "monad-mainnet", kind: "chainlink", address: "0xE20751C7B5867bCBef815ffc1b284c3f412a9e13" });
    for (const c of Object.values(r.contracts)) if (c.txHash) expect(c.txHash).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("matches the addresses apps/app/.env.example pins for testnet", () => {
    const text = read("apps/app/.env.example");
    const pinned = (v) => getAddress(text.match(new RegExp(`^# ${v}=(0x[0-9a-fA-F]{40})$`, "m"))[1]);
    expect(pinned("NEXT_PUBLIC_AUSD_ADDRESS")).to.equal(at("Stablecoin"));
    expect(pinned("NEXT_PUBLIC_PAYMENTS_ADDRESS")).to.equal(at("PolarisPayments"));
    expect(pinned("NEXT_PUBLIC_CHECKOUT_ADDRESS")).to.equal(at("PolarisCheckout"));
    expect(pinned("NEXT_PUBLIC_SEND_ADDRESS")).to.equal(at("PolarisSend"));
    expect(pinned("NEXT_PUBLIC_LOAN_ENGINE_ADDRESS")).to.equal(at("PolarisLoanEngine"));
  });

  it("matches the dollar, the relayer and the first block apps/business/.env.example names", () => {
    const text = read("apps/business/.env.example");
    const r = record();
    expect(text).to.include(at("Stablecoin"));
    expect(text).to.include(getAddress(r.roles.relayer));
    const first = Math.min(...Object.values(r.contracts).map((c) => c.blockNumber).filter(Number.isInteger));
    expect(text).to.match(new RegExp(`^# POLARIS_SYNC_FROM_BLOCK=${first}\\b`, "m"));
    expect(read("apps/shop/.env.example")).to.include(getAddress(r.demo.merchant));
  });
});
