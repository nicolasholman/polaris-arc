/**
 * USYC on the credit pool's idle cash. The pool's owner (its only liquidity
 * provider) keeps what Pay in 4 needs as free cash in PolarisLoanEngine and
 * parks the rest in USYC, Hashnote's tokenized money-market fund on Arc,
 * through its Teller (ERC-4626-style: deposit USDC, receive USYC at the
 * oracle price; redeem USYC for USDC).
 *
 *   POLARIS_USYC=status npx hardhat run scripts/usyc-treasury.js --network arcTestnet
 *   POLARIS_USYC=park   [POLARIS_USYC_KEEP_USDC=<dollars>] …   # withdraw free cash above the floor, subscribe to USYC
 *   POLARIS_USYC=unpark [POLARIS_USYC_SHARES=<all|units>] …    # redeem USYC, fund the pool again
 *
 * USYC is permissioned: the Teller only serves addresses Circle has
 * allowlisted in its Entitlements contract (testnet: a Circle Support ticket,
 * 24-48 h). Without that, `status` says so and `park` refuses before sending
 * anything. The floor kept in the pool defaults to twice CreditGuard's
 * minimum free cash, so parking never pauses Pay in 4.
 * Rehearsed on an Arc testnet fork (scripts/arc-fork.sh + POLARIS_USYC_FORK_ALLOWLIST=1,
 * which grants the role by impersonating the Entitlements owner, fork only).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const tx = require("../lib/tx");
const { networkFor } = require("../lib/networks");

const TELLER_ABI = [
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address account) returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function authority() view returns (address)",
];
const AUTH_ABI = [
  "function canCall(address user, address target, bytes4 functionSig) view returns (bool)",
  "function getRolesWithCapability(address, bytes4) view returns (bytes32)",
  "function owner() view returns (address)",
  "function setUserRole(address user, uint8 role, bool enabled)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)"];
const DEPOSIT_SIG = "0x6e553f65"; // deposit(uint256,address)

const usd = (v, d = 6) => hre.ethers.formatUnits(v, d);

async function main() {
  const network = networkFor();
  if (network.key === "mainnet" && process.env.POLARIS_CONFIRM_MAINNET !== "yes") throw new Error("Set POLARIS_CONFIRM_MAINNET=yes.");
  if (!network.circle?.usycTeller) throw new Error(`USYC isn't on ${network.name}.`);
  const recordPath = process.env.POLARIS_DEPLOYMENT_FILE || path.join(__dirname, "..", "deployments", `arc-${network.key}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const [owner] = await hre.ethers.getSigners();
  const teller = new hre.ethers.Contract(network.circle.usycTeller, TELLER_ABI, owner);
  const usdc = new hre.ethers.Contract(network.circle.usdc, ERC20, owner);
  const usyc = new hre.ethers.Contract(network.circle.usyc, ERC20, owner);
  const engine = await hre.ethers.getContractAt("PolarisLoanEngine", record.contracts.PolarisLoanEngine.address, owner);
  const guard = record.contracts.CreditGuard ? await hre.ethers.getContractAt("CreditGuard", record.contracts.CreditGuard.address, owner) : null;
  const auth = new hre.ethers.Contract(await teller.authority(), AUTH_ABI, owner);
  const mode = process.env.POLARIS_USYC || "status";

  if (process.env.POLARIS_USYC_FORK_ALLOWLIST === "1") {
    // Fork rehearsal only: an anvil fork lets us act as the Entitlements owner. Never on a real network.
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    const isFork = await hre.network.provider.send("anvil_nodeInfo", []).then(() => true, () => false);
    if (!isFork) throw new Error("POLARIS_USYC_FORK_ALLOWLIST works on an anvil fork only.");
    const roles = BigInt(await auth.getRolesWithCapability(network.circle.usycTeller, DEPOSIT_SIG));
    const role = [...Array(256).keys()].reverse().find((r) => (roles >> BigInt(r)) & 1n);
    const authOwner = await auth.owner();
    await hre.network.provider.send("anvil_impersonateAccount", [authOwner]);
    await hre.network.provider.send("anvil_setBalance", [authOwner, "0x56bc75e2d63100000"]);
    // Straight to the fork's RPC: Hardhat's provider only signs for configured keys; anvil signs for an impersonated one.
    const raw = new hre.ethers.JsonRpcProvider(hre.network.config.url);
    const asOwner = auth.connect(await raw.getSigner(authOwner));
    await (await asOwner.setUserRole(owner.address, role, true)).wait();
    await hre.network.provider.send("anvil_stopImpersonatingAccount", [authOwner]);
    console.log(`[fork ${chainId}] allowlisted ${owner.address} for USYC (role ${role}) by impersonating ${authOwner}`);
  }

  const allowed = await auth.canCall(owner.address, network.circle.usycTeller, DEPOSIT_SIG);
  const pool = await engine.poolState();
  const minFree = guard ? (await guard.thresholds()).minFreeCash : 0n;
  const keep = process.env.POLARIS_USYC_KEEP_USDC ? hre.ethers.parseUnits(process.env.POLARIS_USYC_KEEP_USDC, 6) : minFree * 2n;
  const shares = await usyc.balanceOf(owner.address);
  const status = async () => {
    const p = await engine.poolState();
    const s = await usyc.balanceOf(owner.address);
    console.log(`USYC on ${network.name}: 1 USYC = ${usd(await teller.convertToAssets(1_000_000n))} USDC (Teller ${network.circle.usycTeller})`);
    console.log(`  pool free cash ${usd(p.freeCash)} USDC (floor kept: ${usd(keep)}; CreditGuard minimum ${usd(minFree)})`);
    console.log(`  owner ${owner.address}: ${usd(s)} USYC ≈ ${usd(await teller.convertToAssets(s))} USDC, ${usd(await usdc.balanceOf(owner.address))} USDC`);
    console.log(`  allowlisted for USYC: ${allowed ? "yes" : "no (open a Circle Support ticket with this address)"}`);
  };

  if (mode === "status") return status();
  if (!allowed) throw new Error(`${owner.address} isn't allowlisted for USYC on ${network.name}: nothing sent. Ask Circle Support to allowlist it.`);

  if (mode === "park") {
    const excess = pool.freeCash > keep ? pool.freeCash - keep : 0n;
    if (excess < 1_000_000n) return console.log(`Nothing to park: free cash ${usd(pool.freeCash)} is within a dollar of the ${usd(keep)} floor.`), status();
    const r1 = await tx.send(engine, "withdrawLiquidity", [excess, owner.address]);
    const r2 = await tx.send(usdc, "approve", [network.circle.usycTeller, excess]);
    const expected = await teller.previewDeposit(excess);
    const r3 = await tx.send(teller, "deposit", [excess, owner.address]);
    console.log(`Parked ${usd(excess)} USDC in USYC (≈ ${usd(expected)} USYC): withdraw ${r1.hash}, approve ${r2.hash}, deposit ${r3.hash}`);
    return status();
  }
  if (mode === "unpark") {
    const want = process.env.POLARIS_USYC_SHARES && process.env.POLARIS_USYC_SHARES !== "all" ? BigInt(process.env.POLARIS_USYC_SHARES) : shares;
    const max = await teller.maxRedeem(owner.address);
    const amount = want > max ? max : want;
    if (amount === 0n) return console.log("Nothing to redeem."), status();
    const before = await usdc.balanceOf(owner.address);
    const r1 = await tx.send(teller, "redeem", [amount, owner.address, owner.address]);
    const got = (await usdc.balanceOf(owner.address)) - before;
    const r2 = await tx.send(usdc, "approve", [record.contracts.PolarisLoanEngine.address, got]);
    const r3 = await tx.send(engine, "fund", [got]);
    console.log(`Redeemed ${usd(amount)} USYC for ${usd(got)} USDC and funded the pool: redeem ${r1.hash}, approve ${r2.hash}, fund ${r3.hash}`);
    return status();
  }
  throw new Error(`POLARIS_USYC must be status, park or unpark (not ${mode}).`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
