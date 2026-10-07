/**
 * Read a deployment back from the chain and check it is what the record says.
 *
 * Everything here is a view call (eth_getCode, eth_call): it sends nothing and
 * needs no key. Used by scripts/check-deployment.js (`check:deployment:monad`)
 * after deploy:monad, and by test/metropolis/CheckDeployment.test.js against an
 * in-process deployment, broken on purpose to see each check fail.
 *
 * Returns one row per check: { what, ok, detail }. `ok` is false only when the
 * chain disagrees with the record or with how Polaris must be wired; rows that
 * only report state (the pool's cash, whether credit is paused) are always ok.
 */

"use strict";

const { ZeroAddress, getAddress } = require("ethers");

const { GUARDIAN_THRESHOLD_FIELDS } = require("./cre");

const same = (a, b) => typeof a === "string" && typeof b === "string" && getAddress(a) === getAddress(b);

/**
 * @param {import("hardhat").ethers} ethers  hardhat's ethers (getContractAt, provider)
 * @param {object} record  a deployments/*.json record (lib/deploy.js)
 * @returns {Promise<{what: string, ok: boolean, detail: string}[]>}
 */
async function checkDeployment(ethers, record) {
  const rows = [];
  const row = (what, ok, detail = "") => rows.push({ what, ok: Boolean(ok), detail });
  const addr = (name) => record.contracts?.[name]?.address;
  const at = (abiName, name = abiName) => ethers.getContractAt(abiName, addr(name));
  /** A view call that must not throw; a revert is a failed check, not a crash. */
  const read = async (what, fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      row(what, false, `call reverted: ${error.shortMessage ?? error.message}`);
      return { ok: false };
    }
  };

  const { chainId } = await ethers.provider.getNetwork();
  row("chain id matches the record", Number(chainId) === Number(record.chainId), `chain ${chainId}, record ${record.chainId}`);

  // ── code at every address ──────────────────────────────────────────────
  for (const [name, c] of Object.entries(record.contracts ?? {})) {
    const code = await ethers.provider.getCode(c.address);
    row(`${name} has code`, code !== "0x", `${c.address} (${(code.length - 2) / 2} bytes)`);
  }
  const forwarder = record.cre?.forwarder;
  if (forwarder) {
    const code = await ethers.provider.getCode(forwarder);
    row(`CRE ${record.cre.forwarderKind} forwarder has code`, code !== "0x", forwarder);
  }

  const owner = record.roles?.owner ?? record.deployer;
  const owned = [
    "ScoreManager", "PolarisLoanEngine", "PolarisPayments", "MerchantRegistry", "CollateralVault",
    "BatchSettlement", "PolarisCheckout", "CollectionsReceiver", "UnderwritingReceiver", "GuardianReceiver",
  ].filter((n) => addr(n));
  // MerchantRegistry may have moved to the registry admin (a Privy server wallet whose policy only
  // lets it activate and cap merchants: apps/business scripts/transfer-registry-owner.mjs).
  const registryAdmin = record.roles?.registryAdmin ?? null;
  for (const n of owned) {
    const r = await read(`${n} owner`, async () => (await at(n)).owner());
    if (!r.ok) continue;
    if (n === "MerchantRegistry" && registryAdmin) row("MerchantRegistry is owned by the registry admin (Privy)", same(r.value, registryAdmin), r.value);
    else row(`${n} is owned by the deployer`, same(r.value, owner), r.value);
  }

  // ── credit ──────────────────────────────────────────────────────────────
  const scores = await at("ScoreManager");
  const engine = await at("PolarisLoanEngine");
  const checkout = addr("PolarisCheckout");
  row("ScoreManager: the loan engine writes scores", await scores.isWriter(addr("PolarisLoanEngine")));
  row("ScoreManager: UnderwritingReceiver underwrites", await scores.isUnderwriter(addr("UnderwritingReceiver")));
  row("ScoreManager: the deployer does not underwrite", !(await scores.isUnderwriter(owner)));
  row("ScoreManager: no unsecured line without a DON report (requireUnderwriting)", await scores.requireUnderwriting());
  row("ScoreManager: collateral vault", same(await scores.collateralVault(), addr("CollateralVault")), await scores.collateralVault());
  row("LoanEngine: PolarisCheckout originates", await engine.isOriginator(checkout));
  row("LoanEngine: the deployer does not originate", !(await engine.isOriginator(owner)));
  row("LoanEngine: collateral vault", same(await engine.collateralVault(), addr("CollateralVault")));
  row("LoanEngine: merchant registry", same(await engine.merchantRegistry(), addr("MerchantRegistry")));
  const vault = await at("CollateralVault");
  row("CollateralVault: loan engine", same(await vault.loanEngine(), addr("PolarisLoanEngine")));
  row("CollateralVault: the loan engine seizes", await vault.isSeizer(addr("PolarisLoanEngine")));
  row("PolarisPayments: checkout", same(await (await at("PolarisPayments")).checkout(), checkout));

  // ── the guardian and the checkout's credit guard ──────────────────────────
  const guardianAddr = addr("GuardianReceiver");
  const co = await at("PolarisCheckout");
  row("PolarisCheckout: credit guardian is GuardianReceiver", same(await co.creditGuardian(), guardianAddr), await co.creditGuardian());
  if (guardianAddr) {
    const g = await at("GuardianReceiver");
    row("GuardianReceiver: pool is the loan engine", same(await g.pool(), addr("PolarisLoanEngine")));
    const t = await g.thresholds();
    const want = record.config?.guardian;
    if (want) {
      // Every field the record names, in GuardianReceiver.Thresholds' order, as decimal strings.
      const fields = GUARDIAN_THRESHOLD_FIELDS.filter((f) => want[f] !== undefined);
      const got = Object.fromEntries(fields.map((f) => [f, String(t[f])]));
      const wantT = Object.fromEntries(fields.map((f) => [f, String(want[f])]));
      row("GuardianReceiver: thresholds match the record", fields.length > 0 && JSON.stringify(got) === JSON.stringify(wantT), JSON.stringify(got));
      const age = Number(await g.maxAttestationAge());
      row("GuardianReceiver: attestation goes stale after the recorded age", age === Number(want.maxAttestationAge), `${age} s`);
    }
    row("GuardianReceiver: feed-shaped view", (await g.description()).length > 0, `"${await g.description()}", ${await g.decimals()} decimals`);
    const [state] = await g.currentInputs();
    row("pool state (info)", true, `free cash ${ethers.formatUnits(state.freeCash, 6)}, owed ${ethers.formatUnits(state.totalOwed, 6)}, bad debt ${ethers.formatUnits(state.badDebt, 6)}, originated ${ethers.formatUnits(state.totalOriginated, 6)}`);
    const round = Number(await g.latestRound());
    const [paused, reasons] = await co.creditPaused();
    const status = await g.creditStatus();
    row(
      "guardian status (info)",
      true,
      `${round === 0 ? "no attestation yet" : `round ${round}`}; Pay in 4 ${paused ? `paused (reasons ${reasons})` : "open"}; ` +
        `pool reasons now ${status.poolReasons}, price reasons ${status.stale ? "stale (fail open)" : status.priceReasons}`
    );
  }

  // ── the CRE receivers ──────────────────────────────────────────────────
  const transmitter = record.cre?.simulationTransmitter ?? ZeroAddress;
  for (const n of ["CollectionsReceiver", "UnderwritingReceiver", "GuardianReceiver"].filter((x) => addr(x))) {
    const r = await at(n);
    row(`${n}: forwarder`, same(await r.getForwarderAddress(), forwarder), await r.getForwarderAddress());
    const t = await r.simulationTransmitter();
    row(`${n}: simulation transmitter matches the record`, same(t, transmitter), t);
    if (record.cre?.forwarderKind === "simulation") {
      // Behind Chainlink's public simulation forwarder the origin check is the only guard.
      row(`${n}: simulation transmitter is set and is not the deployer`, !same(t, ZeroAddress) && !same(t, owner), t);
    }
    const author = await r.getExpectedAuthor();
    const name = await r.getExpectedWorkflowName();
    const id = await r.getExpectedWorkflowId();
    row(`${n}: workflow lock (info)`, true, same(author, ZeroAddress) && /^0x0+$/.test(name) && /^0x0+$/.test(id) ? "not locked (simulation)" : `author ${author}, name ${name}, id ${id}`);
  }
  const loanRcv = await at("CollectionsReceiver");
  row("CollectionsReceiver: loan engine and payments", same(await loanRcv.loanEngine(), addr("PolarisLoanEngine")) && same(await loanRcv.payments(), addr("PolarisPayments")));
  row("UnderwritingReceiver: score manager", same(await (await at("UnderwritingReceiver")).scoreManager(), addr("ScoreManager")));

  // ── the relayer ────────────────────────────────────────────────────────
  const relayer = record.roles?.relayer;
  if (relayer) {
    row("relayer: PolarisPayments operator", await (await at("PolarisPayments")).isOperator(relayer), relayer);
    row("relayer: MerchantRegistry operator", await (await at("MerchantRegistry")).isOperator(relayer));
    row("relayer: BatchSettlement settler", await (await at("BatchSettlement")).isSettler(relayer));
    row("relayer: does not originate loans", !(await engine.isOriginator(relayer)));
  }

  // ── split the bill (absent from a deployment that predates it) ─────────
  if (addr("PolarisSplit")) {
    const split = await at("PolarisSplit");
    row("PolarisSplit: pays in the record's stablecoin", same(await split.stablecoin(), addr("Stablecoin")), await split.stablecoin());
    const d = await split.eip712Domain();
    row("PolarisSplit: EIP-712 domain \"PolarisSplit\" v1", d.name === "PolarisSplit" && d.version === "1", `${d.name} v${d.version}`);
  }

  // ── the dollar and the demo merchant ───────────────────────────────────
  const token = await ethers.getContractAt("MockAUSD", addr("Stablecoin"));
  const kind = record.contracts.Stablecoin?.kind;
  const name = await token.name();
  const domain = await token.eip712Domain();
  row("Stablecoin: 6 decimals, EIP-712 domain \"Agora Dollar\" v1", Number(await token.decimals()) === 6 && domain.name === "Agora Dollar" && domain.version === "1", `${name} (${await token.symbol()}), ${kind}`);
  if (kind === "MockAUSD") row("Stablecoin: the mock says it is one (ERC-20 name \"Mock AUSD\")", name === "Mock AUSD", name);
  row("credit pool (info)", true, `${ethers.formatUnits(await token.balanceOf(addr("PolarisLoanEngine")), 6)} held by the loan engine`);
  const merchant = record.demo?.merchant;
  if (merchant) {
    const m = await (await at("MerchantRegistry")).merchantOf(merchant);
    row("demo merchant registered and active", m.active && m.payoutAddress !== ZeroAddress, `${m.name}, cap ${ethers.formatUnits(m.maxOrderValue, 6)}`);
  }
  return rows;
}

module.exports = { checkDeployment };
