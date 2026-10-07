#!/usr/bin/env node
/**
 * Generate the indexer's config.yaml and src/deployment.ts from the contract
 * ABIs and a deployment record.
 *
 *   node scripts/generate.mjs                       # from ../contracts/deployments/arc-testnet.json
 *   node scripts/generate.mjs --network mainnet     # from ../contracts/deployments/arc-mainnet.json
 *   node scripts/generate.mjs --deployment <file.json>
 *   node scripts/generate.mjs --check               # exit 1 if the committed files are stale
 *   node scripts/generate.mjs --network local --rpc http://127.0.0.1:8600
 *                                                   # a local chain HyperSync does not serve (scripts/local.sh)
 *
 * The ABIs in packages/contracts/abi are the source of truth for every event
 * signature, so a contract change that is not regenerated here fails
 * `--check` (and the test that runs it). The signatures are written inline
 * in config.yaml because Envio Cloud uploads only this folder.
 *
 * Data source. Envio 3.12.1 serves Arc testnet (5042002, `arc-testnet`) and
 * Arc mainnet (5042, `arc`) from HyperSync, so on those chains the RPC is only
 * a fallback for when real-time indexing stalls. Any other chain (a local
 * Hardhat node) is read over RPC alone (`for: sync`): pass --rpc, or the
 * record's rpcUrl is used.
 *
 * Until packages/contracts/deployments/arc-testnet.json exists (Polaris is
 * not deployed to Arc testnet yet), every Polaris address is a clearly marked
 * placeholder and src/deployment.ts says `placeholder: true`. The addresses
 * Polaris does not deploy are real: Circle's USDC and EURC on Arc. After
 * `pnpm --filter @polarispay/contracts deploy:testnet`, run this again and
 * commit both files.
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
const DEPLOYMENTS = join(CONTRACTS, "deployments");
const DEFAULT_DEPLOYMENT = join(DEPLOYMENTS, "arc-testnet.json");
const CONFIG_OUT = join(ROOT, "config.yaml");
const SETTINGS_OUT = join(ROOT, "src", "deployment.ts");

/**
 * Arc facts that do not depend on a Polaris deployment (packages/contracts/
 * lib/networks.js). `hypersync`: Envio serves the chain from HyperSync.
 */
const ARC = {
  5042002: {
    network: "testnet",
    rpcUrl: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0x89b50855aa3be2f677cd6303cec089b5f319d72a",
    hypersync: true,
  },
  5042: {
    network: "mainnet",
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    eurc: "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1",
    hypersync: true,
  },
};
const ARC_TESTNET_ID = 5042002;

/**
 * Every contract the indexer reads, in deployment order. `abi` is the ABI
 * file; `events` narrows it to what we index; otherwise every event in the
 * ABI is indexed except `EIP712DomainChanged`, which these contracts never emit.
 */
const INDEXED = [
  { name: "ScoreManager", abi: "ScoreManager" },
  { name: "PolarisLoanEngine", abi: "PolarisLoanEngine" },
  { name: "PolarisPayments", abi: "PolarisPayments" },
  { name: "MerchantRegistry", abi: "MerchantRegistry" },
  { name: "CollateralVault", abi: "CollateralVault" },
  { name: "BatchSettlement", abi: "BatchSettlement" },
  { name: "PolarisSend", abi: "PolarisSend" },
  // The same contract on EURC: euro send-by-link (src/handlers/send.ts).
  { name: "PolarisSendEURC", abi: "PolarisSend" },
  { name: "PolarisCheckout", abi: "PolarisCheckout" },
  // The Polaris keeper's two receivers (one keeper EOA calls submitReport).
  { name: "CollectionsReceiver", abi: "CollectionsReceiver" },
  { name: "UnderwritingReceiver", abi: "UnderwritingReceiver" },
  // The credit guard: thresholds, overrides and acknowledged bad debt. It
  // reads the pool live, so whether credit is paused is a view, not an event.
  { name: "CreditGuard", abi: "CreditGuard" },
  // USDC transfers into and out of merchant accounts. No static address: an
  // account is registered at runtime when it registers with the
  // MerchantRegistry (src/handlers/merchantWallet.ts), and the Transfer
  // handler runs in wildcard mode, filtered to those accounts.
  { name: "MerchantWallet", abi: "IUSDC", events: ["Transfer"], dynamic: true },
];

/** The Polaris contracts a deployment record must carry. */
const DEPLOYED = INDEXED.filter((c) => !c.dynamic).map((c) => c.name);
/** The tokens, from the record's `contracts` (Circle's on Arc, MockUSDC locally). */
const TOKENS = ["USDC", "EURC"];

const DEFAULTS = {
  graceSeconds: 3 * 24 * 3600,
  feeBps: 50,
  requireUnderwriting: true,
  // The dunning ladder (services/keeper and the API share it): after a failed
  // collection, retry 6 h, 24 h, 72 h, then weekly, never past the point
  // where the plan becomes liquidatable.
  dunningRetrySeconds: [6 * 3600, 24 * 3600, 72 * 3600, 168 * 3600],
};

function parseArgs(argv) {
  const args = { deployment: DEFAULT_DEPLOYMENT, check: false, rpc: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--deployment") args.deployment = resolve(argv[++i] ?? "");
    else if (a === "--network") {
      const n = argv[++i];
      if (!["testnet", "mainnet", "local"].includes(n)) throw new Error(`--network must be testnet, mainnet or local, got ${n}`);
      args.deployment = join(DEPLOYMENTS, `arc-${n}.json`);
    } else if (a === "--rpc") args.rpc = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/generate.mjs [--network testnet|mainnet|local | --deployment <file.json>] [--rpc <url>] [--check]");
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
    if (resolve(file) !== DEFAULT_DEPLOYMENT) throw new Error(`No deployment record at ${file}`);
    const arc = ARC[ARC_TESTNET_ID];
    return {
      placeholder: true,
      source: null,
      chainId: ARC_TESTNET_ID,
      network: arc.network,
      explorer: arc.explorer,
      rpcUrl: arc.rpcUrl,
      startBlock: 0,
      addresses: {
        ...Object.fromEntries(DEPLOYED.map((name, i) => [name, placeholderAddress(i)])),
        USDC: arc.usdc,
        EURC: arc.eurc,
      },
      blocks: {},
      ...DEFAULTS,
    };
  }
  const d = JSON.parse(readFileSync(file, "utf8"));
  const addresses = {};
  const blocks = {};
  for (const name of [...DEPLOYED, ...TOKENS]) {
    const entry = d.contracts?.[name];
    if (!entry || !isAddress(entry.address)) throw new Error(`${file}: contracts.${name}.address is missing`);
    addresses[name] = lower(entry.address);
    if (Number.isInteger(entry.blockNumber)) blocks[name] = entry.blockNumber;
  }
  const deployBlocks = DEPLOYED.map((n) => blocks[n]).filter((b) => Number.isInteger(b));
  if (deployBlocks.length === 0) throw new Error(`${file}: no contract carries a blockNumber`);
  const chainId = Number(d.chainId);
  const arc = ARC[chainId];
  return {
    placeholder: false,
    source: relative(ROOT, file).split("\\").join("/"),
    chainId,
    network: String(d.network ?? arc?.network ?? ""),
    explorer: d.explorerUrl ?? arc?.explorer ?? null,
    rpcUrl: d.rpcUrl ?? arc?.rpcUrl ?? null,
    startBlock: Math.min(...deployBlocks),
    addresses,
    blocks,
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
  const hypersync = Boolean(ARC[dep.chainId]?.hypersync);
  const rpcUrl = rpc ?? dep.rpcUrl;
  if (!hypersync && !rpcUrl) throw new Error(`Chain ${dep.chainId} has no HyperSync: pass --rpc <url>.`);
  const L = [];
  L.push("# yaml-language-server: $schema=./node_modules/envio/evm.schema.json");
  L.push("# GENERATED by scripts/generate.mjs from packages/contracts/abi and");
  L.push(`# ${dep.placeholder ? "NO DEPLOYMENT YET (placeholders)" : dep.source}. Edit the script, not this file.`);
  L.push("name: polaris-indexer");
  L.push("description: Polaris on Arc. Payments, Pay in 4 plans, subscriptions, USDC and EURC sends, payouts, credit, the credit guard and the keeper's collections, for the dashboard, webhooks and the Polaris keeper.");
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
  L.push("    - from # who paid the gas: the relayer or the Polaris keeper; never a user");
  L.push("    - to # a payout is a transfer sent to USDC itself, not a Polaris contract");
  L.push("contracts:");
  for (const c of INDEXED) {
    L.push(`  - name: ${c.name}`);
    L.push("    events:");
    for (const e of eventsFor(c)) L.push(`      - event: ${yamlString(eventSignature(e))}`);
  }
  L.push("chains:");
  L.push(`  - id: ${dep.chainId}`);
  if (hypersync) {
    L.push("    # HyperSync serves this chain; the public RPC is the fallback when");
    L.push("    # real-time indexing stalls.");
    L.push("    rpc:");
    L.push(`      - url: ${yamlString(rpcUrl)}`);
    L.push("        for: fallback");
  } else {
    L.push("    # Not a HyperSync chain: read it over RPC.");
    L.push("    rpc:");
    L.push(`      - url: ${yamlString(rpcUrl)}`);
    L.push("        for: sync");
  }
  L.push("    # The first Polaris deploy block. ENVIO_START_BLOCK overrides it.");
  L.push(`    start_block: \${ENVIO_START_BLOCK:-${dep.startBlock}}`);
  L.push("    # Arc's finality is deterministic and sub-second: a block never reorgs, so");
  L.push("    # nothing waits behind the head. ENVIO_BLOCK_LAG adds a margin if wanted.");
  L.push("    block_lag: ${ENVIO_BLOCK_LAG:-0}");
  L.push("    contracts:");
  for (const c of INDEXED) {
    L.push(`      - name: ${c.name}`);
    if (c.dynamic) {
      L.push("        # registered at runtime: every account that registers with the MerchantRegistry");
      continue;
    }
    const note = dep.placeholder ? " # PLACEHOLDER: not deployed yet" : "";
    L.push(`        address: ${yamlString(dep.addresses[c.name])}${note}`);
  }
  return `${L.join("\n")}\n`;
}

export function renderSettings(dep) {
  const names = [...DEPLOYED, ...TOKENS];
  const addresses = Object.fromEntries(names.map((n) => [n, dep.addresses[n]]));
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
// PLACEHOLDER: Polaris is not deployed to Arc testnet yet. Every Polaris
// address below is fake; USDC and EURC are Circle's. Run
// \`pnpm --filter @polarispay/contracts deploy:testnet\`, then \`pnpm generate\`.` : ""}

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
${names.map((n) => `    readonly ${n}: string;`).join("\n")}
  };
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
