#!/usr/bin/env node
/**
 * Generate the indexer's config.yaml and src/deployment.ts from the contract
 * ABIs and a deployment record.
 *
 *   node scripts/generate.mjs                  # from ../contracts/deployments/monad-testnet.json
 *   node scripts/generate.mjs --deployment <file.json>
 *   node scripts/generate.mjs --check          # exit 1 if the committed files are stale
 *   node scripts/generate.mjs --deployment ../contracts/deployments/monad-local.json --rpc http://127.0.0.1:3541
 *                                              # a local chain HyperSync does not serve (scripts/live.sh)
 *
 * The ABIs in packages/contracts/abi are the source of truth for every event
 * signature, so a contract change that is not regenerated here fails
 * `--check` (and the test that runs it). The signatures are written inline
 * in config.yaml because Envio Cloud uploads only this folder.
 *
 * Until packages/contracts/deployments/monad-testnet.json exists (the
 * deployer is not funded yet), every Polaris address is a clearly marked
 * placeholder and src/deployment.ts says `placeholder: true`. The addresses
 * Polaris does not deploy are real: AUSD, and Chainlink's two CRE forwarders
 * on Monad testnet. After `pnpm --filter @polarispay/contracts deploy:monad`,
 * run this again and commit both files.
 *
 * Node 22+, no dependencies: it runs on Windows as well as in WSL.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CONTRACTS = resolve(ROOT, "../contracts");
const ABI_DIR = join(CONTRACTS, "abi");
const DEFAULT_DEPLOYMENT = join(CONTRACTS, "deployments", "monad-testnet.json");
const CONFIG_OUT = join(ROOT, "config.yaml");
const SETTINGS_OUT = join(ROOT, "src", "deployment.ts");

/** Monad testnet facts that do not depend on a Polaris deployment. */
const MONAD_TESTNET = {
  chainId: 10143,
  network: "monadTestnet",
  explorer: "https://testnet.monadscan.com",
  ausd: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
  creForwarders: [
    "0xb9f79d863261869b234c481d1f9a7af84aead192", // MockKeystoneForwarder: `cre workflow simulate --broadcast`
    "0xf8344cfd5c43616a4366c34e3eee75af79a74482", // KeystoneForwarder: deployed workflows
  ],
};

/**
 * Every contract the indexer reads, in deployment order. `events` narrows an
 * ABI to what we index; otherwise every event in the ABI is indexed except
 * `EIP712DomainChanged`, which these contracts never emit.
 */
const INDEXED = [
  { name: "ScoreManager", abi: "ScoreManager" },
  { name: "PolarisLoanEngine", abi: "PolarisLoanEngine" },
  { name: "PolarisPayments", abi: "PolarisPayments" },
  { name: "MerchantRegistry", abi: "MerchantRegistry" },
  { name: "CollateralVault", abi: "CollateralVault" },
  { name: "BatchSettlement", abi: "BatchSettlement" },
  { name: "PolarisSend", abi: "PolarisSend" },
  { name: "PolarisCheckout", abi: "PolarisCheckout" },
  { name: "CollectionsReceiver", abi: "CollectionsReceiver" },
  { name: "UnderwritingReceiver", abi: "UnderwritingReceiver" },
  // Chainlink's forwarder (shared, not ours): only its ReportProcessed for our
  // two receivers, filtered in src/handlers/cre.ts.
  { name: "CreForwarder", abi: "MockKeystoneForwarder", events: ["ReportProcessed"] },
  // Stablecoin transfers into and out of merchant accounts. No static address:
  // an account is registered at runtime when it registers with the
  // MerchantRegistry (src/handlers/merchantWallet.ts), and the Transfer
  // handler runs in wildcard mode, filtered to those accounts.
  { name: "MerchantWallet", abi: "IAUSD", events: ["Transfer"], dynamic: true },
];

/** The Polaris contracts a deployment record must carry. */
const DEPLOYED = INDEXED.filter((c) => !c.dynamic && c.name !== "CreForwarder").map((c) => c.name);

const DEFAULTS = {
  graceSeconds: 3600,
  feeBps: 50,
  requireUnderwriting: true,
  // The dunning ladder (packages/keeperhub/src/dunning.ts, plan 3.3): after a
  // failed collection, retry 6 h, 24 h, 72 h, then weekly, never past the
  // point where the plan becomes liquidatable.
  dunningRetrySeconds: [6 * 3600, 24 * 3600, 72 * 3600, 168 * 3600],
};

function parseArgs(argv) {
  const args = { deployment: DEFAULT_DEPLOYMENT, check: false, rpc: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--deployment") args.deployment = resolve(argv[++i] ?? "");
    else if (a === "--rpc") args.rpc = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/generate.mjs [--deployment <file.json>] [--rpc <url>] [--check]");
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function readAbi(name) {
  const raw = JSON.parse(readFileSync(join(ABI_DIR, `${name}.json`), "utf8"));
  return Array.isArray(raw) ? raw : raw.abi;
}

function formatType(input) {
  if (!input.type.startsWith("tuple")) return input.type;
  return `(${input.components.map(formatType).join(",")})${input.type.slice("tuple".length)}`;
}

/** `Name(type indexed name, type name)`, the human-readable form Envio takes. */
export function eventSignature(event) {
  const params = event.inputs.map((i) => `${formatType(i)}${i.indexed ? " indexed" : ""} ${i.name}`);
  return `${event.name}(${params.join(", ")})`;
}

export function eventsFor(contract) {
  const all = readAbi(contract.abi).filter((e) => e.type === "event" && e.name !== "EIP712DomainChanged");
  const picked = contract.events ? all.filter((e) => contract.events.includes(e.name)) : all;
  if (contract.events && picked.length !== contract.events.length) {
    throw new Error(`${contract.abi}.json lacks one of ${contract.events.join(", ")}`);
  }
  return picked.sort((a, b) => a.name.localeCompare(b.name));
}

const lower = (a) => String(a).toLowerCase();
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));

/** Distinct, obviously fake addresses, one per contract, until a deployment exists. */
function placeholderAddress(index) {
  return `0x00000000000000000000000000000000cafe${String(index + 1).padStart(4, "0")}`;
}

export function loadDeployment(file) {
  if (!existsSync(file)) {
    return {
      placeholder: true,
      source: null,
      chainId: MONAD_TESTNET.chainId,
      network: MONAD_TESTNET.network,
      explorer: MONAD_TESTNET.explorer,
      startBlock: 0,
      addresses: {
        ...Object.fromEntries(DEPLOYED.map((name, i) => [name, placeholderAddress(i)])),
        Stablecoin: MONAD_TESTNET.ausd,
      },
      blocks: {},
      creForwarders: MONAD_TESTNET.creForwarders,
      ...DEFAULTS,
    };
  }
  const d = JSON.parse(readFileSync(file, "utf8"));
  const addresses = {};
  const blocks = {};
  for (const name of [...DEPLOYED, "Stablecoin"]) {
    const entry = d.contracts?.[name];
    if (!entry || !isAddress(entry.address)) throw new Error(`${file}: contracts.${name}.address is missing`);
    addresses[name] = lower(entry.address);
    if (Number.isInteger(entry.blockNumber)) blocks[name] = entry.blockNumber;
  }
  const deployBlocks = DEPLOYED.map((n) => blocks[n]).filter((b) => Number.isInteger(b));
  if (deployBlocks.length === 0) throw new Error(`${file}: no contract carries a blockNumber`);
  const forwarders = new Set(d.chainId === MONAD_TESTNET.chainId ? MONAD_TESTNET.creForwarders : []);
  if (isAddress(d.cre?.forwarder)) forwarders.add(lower(d.cre.forwarder));
  if (isAddress(d.contracts?.MockKeystoneForwarder?.address)) forwarders.add(lower(d.contracts.MockKeystoneForwarder.address));
  return {
    placeholder: false,
    source: relative(ROOT, file).split("\\").join("/"),
    chainId: Number(d.chainId),
    network: String(d.network ?? ""),
    explorer: d.explorer ?? (d.chainId === MONAD_TESTNET.chainId ? MONAD_TESTNET.explorer : null),
    startBlock: Math.min(...deployBlocks),
    addresses,
    blocks,
    creForwarders: [...forwarders],
    graceSeconds: Number(d.config?.graceSeconds ?? DEFAULTS.graceSeconds),
    feeBps: Number(d.config?.feeBps ?? DEFAULTS.feeBps),
    requireUnderwriting: Boolean(d.config?.requireUnderwriting ?? DEFAULTS.requireUnderwriting),
    dunningRetrySeconds: DEFAULTS.dunningRetrySeconds,
  };
}

function yamlString(s) {
  return JSON.stringify(s);
}

export function renderConfig(dep, rpc) {
  const L = [];
  L.push("# yaml-language-server: $schema=./node_modules/envio/evm.schema.json");
  L.push("# GENERATED by scripts/generate.mjs from packages/contracts/abi and");
  L.push(`# ${dep.placeholder ? "NO DEPLOYMENT YET (placeholders)" : dep.source}. Edit the script, not this file.`);
  L.push("name: polaris-indexer");
  L.push("description: Polaris on Monad. Payments, Pay in 4 plans, subscriptions, sends, payouts, credit and CRE collections, for the dashboard, webhooks and the CRE collections workflow.");
  L.push("schema: ./schema.graphql");
  L.push("handlers: ./src/handlers");
  L.push("# Every address the indexer surfaces is lowercase, so GraphQL `_eq` filters");
  L.push("# work on addresses as clients hold them after `.toLowerCase()`.");
  L.push("address_format: lowercase");
  L.push("# Rows are per chain, keyed (id, chainId): mainnet can join later.");
  L.push("disable_default_cross_chain: true");
  L.push("field_selection:");
  L.push("  transaction_fields:");
  L.push("    - hash");
  L.push("    - from # who paid the gas: the Privy relayer, the CRE transmitter; never a user");
  L.push("    - to # a payout is a transfer sent to the stablecoin itself, not a Polaris contract");
  L.push("contracts:");
  for (const c of INDEXED) {
    L.push(`  - name: ${c.name}`);
    L.push("    events:");
    for (const e of eventsFor(c)) L.push(`      - event: ${yamlString(eventSignature(e))}`);
  }
  L.push("chains:");
  L.push(`  - id: ${dep.chainId}`);
  if (rpc) {
    L.push("    # Not a HyperSync chain: read it over RPC.");
    L.push("    rpc:");
    L.push(`      - url: ${yamlString(rpc)}`);
    L.push("        for: sync");
  }
  L.push("    # The first Polaris deploy block. ENVIO_START_BLOCK overrides it.");
  L.push(`    start_block: \${ENVIO_START_BLOCK:-${dep.startBlock}}`);
  L.push("    # Two blocks (800 ms) is Monad finality, so a webhook never fires for a");
  L.push("    # block that later reorgs. ENVIO_BLOCK_LAG=0 for the lowest latency.");
  L.push("    block_lag: ${ENVIO_BLOCK_LAG:-2}");
  L.push("    contracts:");
  for (const c of INDEXED) {
    L.push(`      - name: ${c.name}`);
    if (c.dynamic) {
      L.push("        # registered at runtime: every account that registers with the MerchantRegistry");
      continue;
    }
    if (c.name === "CreForwarder") {
      L.push("        address:");
      for (const a of dep.creForwarders) L.push(`          - ${yamlString(a)}`);
      continue;
    }
    const note = dep.placeholder ? " # PLACEHOLDER: not deployed yet" : "";
    L.push(`        address: ${yamlString(dep.addresses[c.name])}${note}`);
  }
  return `${L.join("\n")}\n`;
}

export function renderSettings(dep) {
  const addresses = Object.fromEntries(
    [...DEPLOYED, "Stablecoin"].map((n) => [n, dep.addresses[n]]),
  );
  const settings = {
    chainId: dep.chainId,
    network: dep.network,
    placeholder: dep.placeholder,
    source: dep.source,
    startBlock: dep.startBlock,
    explorer: dep.explorer,
    graceSeconds: dep.graceSeconds,
    feeBps: dep.feeBps,
    requireUnderwriting: dep.requireUnderwriting,
    dunningRetrySeconds: dep.dunningRetrySeconds,
    addresses,
    creForwarders: dep.creForwarders,
  };
  // Arrays of numbers on one line; everything else as JSON.stringify lays it out.
  const body = JSON.stringify(settings, null, 2).replace(
    /\[\s*(\d+(?:,\s*\d+)*)\s*\]/g,
    (_, nums) => `[${nums.split(/,\s*/).join(", ")}]`,
  );
  return `// GENERATED by scripts/generate.mjs. Edit the script, not this file.
//
// The per-chain settings the handlers need that no event carries: the loan
// engine's grace period (for liquidatableAt), the dunning ladder, and the
// addresses that tell a payout from an internal transfer.${dep.placeholder ? `
//
// PLACEHOLDER: Polaris is not deployed to Monad testnet yet. Every Polaris
// address below is fake; AUSD and the CRE forwarders are real. Run
// \`pnpm --filter @polarispay/contracts deploy:monad\`, then \`pnpm generate\`.` : ""}

export type ChainSettings = {
  readonly chainId: number;
  readonly network: string;
  /** True until a real deployment record exists: the Polaris addresses are fake. */
  readonly placeholder: boolean;
  /** The deployment record this was generated from, relative to the indexer. */
  readonly source: string | null;
  readonly startBlock: number;
  readonly explorer: string | null;
  /** PolarisLoanEngine.gracePeriod: a plan is liquidatable once an instalment is this late. */
  readonly graceSeconds: number;
  /** PolarisPayments.feeBps at deploy; FeeChanged events update the Protocol row. */
  readonly feeBps: number;
  /** ScoreManager.requireUnderwriting at deploy; RequireUnderwritingSet updates it. */
  readonly requireUnderwriting: boolean;
  /** Wait after the nth failed collection before the next attempt (the last repeats). */
  readonly dunningRetrySeconds: readonly number[];
  readonly addresses: {
${[...DEPLOYED, "Stablecoin"].map((n) => `    readonly ${n}: string;`).join("\n")}
  };
  /** Chainlink forwarders whose ReportProcessed for our receivers is indexed. */
  readonly creForwarders: readonly string[];
};

export const DEPLOYMENTS: Readonly<Record<number, ChainSettings>> = {
  ${dep.chainId}: ${body.split("\n").join("\n  ")},
};

/** The settings for a chain the indexer is configured for. */
export function settingsFor(chainId: number): ChainSettings {
  const s = DEPLOYMENTS[chainId];
  if (!s) throw new Error(\`No Polaris deployment settings for chain \${chainId}\`);
  return s;
}
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dep = loadDeployment(args.deployment);
  const outputs = [
    [CONFIG_OUT, renderConfig(dep, args.rpc)],
    [SETTINGS_OUT, renderSettings(dep)],
  ];
  if (args.check) {
    const stale = outputs.filter(([file, text]) => !existsSync(file) || readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== text);
    if (stale.length > 0) {
      console.error(`Stale: ${stale.map(([f]) => relative(ROOT, f)).join(", ")}. Run \`node scripts/generate.mjs\`${args.deployment === DEFAULT_DEPLOYMENT ? "" : ` --deployment ${args.deployment}`}.`);
      process.exit(1);
    }
    console.log(`config.yaml and src/deployment.ts are current (${dep.placeholder ? "placeholders" : dep.source}).`);
    return;
  }
  for (const [file, text] of outputs) writeFileSync(file, text);
  console.log(
    dep.placeholder
      ? `Wrote config.yaml and src/deployment.ts with PLACEHOLDER Polaris addresses (no ${relative(ROOT, args.deployment)} yet).`
      : `Wrote config.yaml and src/deployment.ts from ${dep.source} (chain ${dep.chainId}, start block ${dep.startBlock}).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
