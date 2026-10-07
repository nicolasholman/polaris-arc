/**
 * Verifying a deployment on Monadscan when the sources have moved on since.
 *
 * hardhat-verify compiles today's sources and refuses a contract whose
 * executable bytecode no longer matches what is on chain (Etherscan itself
 * ignores only the metadata hash). A contract fixed in code but not
 * redeployed (PolarisCheckout's reauthorize fix, for one) would then never
 * verify. So each contract in a deployment record carries `sourceCommit`,
 * the commit its bytecode was built from, and for one whose code no longer
 * matches today's sources this module:
 *
 *   1. builds the standard-JSON input from that commit: the project's
 *      contracts/ as git has them there, today's compiler version and
 *      settings (hardhat.config.js; the check in 3 catches a change), and
 *      the libraries from node_modules;
 *   2. compiles it with the same solc;
 *   3. checks the result's executable code is the code on chain (immutables
 *      zeroed, metadata left out, as Etherscan compares);
 *   4. and only then hands exactly that input to Etherscan.
 *
 * Around that, for scripts/verify-monad.js: which contracts a record asks to
 * verify (verificationTargets: the ones it lists, and the ones a redeploy
 * replaced), the input cut down to the files a contract is built from
 * (closureInput, verificationInput), and the constructor arguments read back
 * from the creation transaction (argsFromCreation).
 *
 * Used by scripts/verify-monad.js and test/metropolis/Verify.test.js.
 */

"use strict";

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} = require("hardhat/builtin-tasks/task-names");

/** The package's folder in the repository: where `contracts/` lives in git. */
const PACKAGE_DIR = "packages/contracts";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The repository root, from this package. */
function repoRoot(from = path.join(__dirname, "..")) {
  return git(["rev-parse", "--show-toplevel"], from).trim();
}

/** The commit HEAD is at, and whether contracts/ differs from it (uncommitted changes). */
function headSource(root = repoRoot()) {
  const commit = git(["rev-parse", "HEAD"], root).trim();
  const dirty = git(["status", "--porcelain", "--", `${PACKAGE_DIR}/contracts`, `${PACKAGE_DIR}/hardhat.config.js`], root).trim() !== "";
  return { commit, dirty };
}

/** Every project source at `commit`, keyed by its source name ("contracts/X.sol"). */
function projectSourcesAt(commit, root = repoRoot()) {
  const files = git(["ls-tree", "-r", "--name-only", commit, "--", `${PACKAGE_DIR}/contracts`], root)
    .split(/\r?\n/)
    .filter((f) => f.endsWith(".sol"));
  if (files.length === 0) throw new Error(`no contracts at ${commit}`);
  return Object.fromEntries(files.map((f) => [f.slice(PACKAGE_DIR.length + 1), { content: git(["show", `${commit}:${f}`], root) }]));
}

/** Whether contracts/ and hardhat.config.js are the same at `commit` as in the working tree. */
function sourcesUnchangedSince(commit, root = repoRoot()) {
  try {
    git(["diff", "--quiet", commit, "--", `${PACKAGE_DIR}/contracts`, `${PACKAGE_DIR}/hardhat.config.js`], root);
    return true;
  } catch {
    return false;
  }
}

const strip0x = (hex) => (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();

/** Runtime code without its CBOR metadata (the last two bytes give its length). */
function withoutMetadata(hex) {
  const h = strip0x(hex);
  if (h.length < 4) return h;
  const len = parseInt(h.slice(-4), 16);
  const cut = (len + 2) * 2;
  return cut <= h.length ? h.slice(0, h.length - cut) : h;
}

/** `hex` with every immutable reference (solc's { id: [{ start, length }] }) set to zero. */
function zeroImmutables(hex, immutableReferences = {}) {
  const chars = strip0x(hex).split("");
  for (const refs of Object.values(immutableReferences)) {
    for (const { start, length } of refs) chars.fill("0", start * 2, (start + length) * 2);
  }
  return chars.join("");
}

/**
 * Whether code on chain is the compiled runtime code: the same executable
 * section once immutables are zeroed in both and the metadata dropped.
 */
function sameExecutable(onChain, compiled, immutableReferences) {
  if (!onChain || onChain === "0x") return false;
  return withoutMetadata(zeroImmutables(onChain, immutableReferences)) === withoutMetadata(zeroImmutables(compiled, immutableReferences));
}

/** The source name and contract name of "contracts/X.sol:X". */
function splitFqn(fqn) {
  const i = fqn.lastIndexOf(":");
  return { sourceName: fqn.slice(0, i), contractName: fqn.slice(i + 1) };
}

/**
 * The standard-JSON input `fqn` was compiled from at `commit`: that commit's
 * project sources, and today's compiler version, settings and libraries.
 */
async function standardInputAt(hre, fqn, commit, root = repoRoot()) {
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  if (!buildInfo) throw new Error(`no build info for ${fqn}: run \`hardhat compile\` first`);
  const sources = {};
  for (const [name, s] of Object.entries(buildInfo.input.sources)) if (!name.startsWith("contracts/")) sources[name] = s;
  Object.assign(sources, projectSourcesAt(commit, root));
  return {
    input: { language: "Solidity", sources, settings: buildInfo.input.settings },
    solcVersion: buildInfo.solcVersion,
    solcLongVersion: buildInfo.solcLongVersion,
  };
}

/** A library source as node_modules has it, for an import today's build didn't need. */
function librarySource(name, from = path.join(__dirname, "..")) {
  return { content: readFileSync(require.resolve(name, { paths: [from] }), "utf8") };
}

/**
 * Compile `input` with solc `solcVersion` for `fqn` alone, adding any
 * library the older sources import that today's don't. Returns its runtime
 * creation and runtime code, immutable references and ABI, and the input as
 * finally compiled.
 */
async function compileFor(hre, input, solcVersion, fqn) {
  const { sourceName, contractName } = splitFqn(fqn);
  const build = await hre.run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion });
  const full = { ...input, sources: { ...input.sources } };
  for (let attempt = 0; attempt < 10; attempt++) {
    const job = {
      ...full,
      settings: {
        ...full.settings,
        outputSelection: {
          [sourceName]: { [contractName]: ["abi", "metadata", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] },
        },
      },
    };
    const output = build.isSolcJs
      ? await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, { input: job, solcJsPath: build.compilerPath })
      : await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, { input: job, solcPath: build.compilerPath, solcVersion });
    const errors = (output.errors ?? []).filter((e) => e.severity === "error");
    const missing = errors
      .map((e) => /Source "([^"]+)" not found/.exec(e.message ?? e.formattedMessage ?? "")?.[1])
      .filter((n) => n && !n.startsWith("contracts/") && !full.sources[n]);
    if (missing.length > 0) {
      for (const n of missing) full.sources[n] = librarySource(n);
      continue;
    }
    if (errors.length > 0) throw new Error(`${fqn} doesn't compile at that commit: ${errors.map((e) => e.formattedMessage ?? e.message).join("\n")}`);
    const out = output.contracts?.[sourceName]?.[contractName];
    if (!out) throw new Error(`${fqn} is not in that commit's sources`);
    return {
      bytecode: `0x${out.evm.bytecode.object}`,
      deployedBytecode: `0x${out.evm.deployedBytecode.object}`,
      immutableReferences: out.evm.deployedBytecode.immutableReferences ?? {},
      abi: out.abi,
      metadata: out.metadata,
      input: full,
    };
  }
  throw new Error(`${fqn}: imports still missing after 10 passes`);
}

/**
 * The input to verify `fqn` at `address` with: today's sources when the code
 * on chain is theirs ({ from: "today" }), else those of `commit` once they
 * are shown to reproduce it ({ from: commit, input, solcLongVersion, abi }).
 * Throws when neither does.
 *
 * When today's sources run the same code but their metadata differs (only a
 * comment changed since the deploy: CollectionsReceiver's NatSpec, for one)
 * and `commit`'s reproduce the code byte for byte, metadata included, the
 * commit's win: the explorer then shows the very text that was deployed, as
 * an exact match. If they don't, today's are used, as before.
 */
async function sourcesFor(hre, { fqn, address, commit, root = repoRoot() }) {
  const onChain = await hre.ethers.provider.getCode(address);
  const artifact = await hre.artifacts.readArtifact(fqn);
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  const { sourceName, contractName } = splitFqn(fqn);
  const today = buildInfo?.output?.contracts?.[sourceName]?.[contractName]?.evm?.deployedBytecode;
  if (sameExecutable(onChain, artifact.deployedBytecode, today?.immutableReferences)) {
    if (!commit || sameBytes(onChain, artifact.deployedBytecode, today?.immutableReferences)) return { from: "today" };
    try {
      const atCommit = await buildAt(hre, fqn, commit, root);
      if (sameBytes(onChain, atCommit.compiled.deployedBytecode, atCommit.compiled.immutableReferences)) return atCommit;
    } catch {
      // The commit's sources don't build or aren't there: today's run the same code, so they still verify.
    }
    return { from: "today" };
  }
  if (!commit) throw new Error(`${fqn} at ${address}: the code on chain is not today's, and the record names no sourceCommit`);
  const atCommit = await buildAt(hre, fqn, commit, root);
  if (!sameExecutable(onChain, atCommit.compiled.deployedBytecode, atCommit.compiled.immutableReferences)) {
    throw new Error(`${fqn} at ${address}: the code on chain is neither today's nor ${commit.slice(0, 10)}'s`);
  }
  return atCommit;
}

/** `fqn` built from `commit`'s sources, in sourcesFor's shape. */
async function buildAt(hre, fqn, commit, root) {
  const { input, solcVersion, solcLongVersion } = await standardInputAt(hre, fqn, commit, root);
  const compiled = await compileFor(hre, input, solcVersion, fqn);
  return { from: commit, input: compiled.input, solcVersion, solcLongVersion, abi: compiled.abi, compiled };
}

/**
 * What to verify in a deployment record: every contract it lists (a real
 * stablecoin is not ours to verify, the mock is), and every contract a
 * redeploy replaced, which is still on chain under its old address. Each
 * with the artifact that built it and the commit its sources are at.
 */
function verificationTargets(record) {
  const targets = [];
  for (const [name, c] of Object.entries(record.contracts ?? {})) {
    if (name === "Stablecoin" && c.kind !== "MockAUSD") continue;
    targets.push({
      name,
      artifact: name === "Stablecoin" ? "MockAUSD" : name,
      address: c.address,
      txHash: c.txHash ?? null,
      args: Array.isArray(c.args) ? c.args : null,
      commit: c.sourceCommit ?? record.sourceCommit ?? null,
      current: true,
    });
  }
  for (const r of record.redeploys ?? []) {
    if (!r.replaced?.address) continue;
    targets.push({
      name: `${r.contract} (replaced)`,
      artifact: r.contract,
      address: r.replaced.address,
      txHash: r.replaced.txHash ?? null,
      args: null,
      commit: r.replaced.sourceCommit ?? record.sourceCommit ?? null,
      current: false,
      replacedBy: r.address,
    });
  }
  return targets;
}

/**
 * The ABI-encoded constructor arguments a creation transaction carried: its
 * input past the contract's creation code. The code must be the same as
 * `creationBytecode` (its metadata aside), else this is not the transaction
 * that deployed it.
 */
function argsFromCreation(txData, creationBytecode) {
  const data = strip0x(txData);
  const code = strip0x(creationBytecode);
  if (data.length < code.length) throw new Error("the creation transaction is shorter than the contract's creation code");
  const head = data.slice(0, code.length);
  if (head !== code && withoutMetadata(head) !== withoutMetadata(code)) {
    throw new Error("the creation transaction does not carry this contract's creation code");
  }
  return `0x${data.slice(code.length)}`;
}

/**
 * `input` cut down to the sources `fqn`'s metadata names: the files it is
 * built from, which is what the explorer shows (the rest of the project is
 * not part of it).
 */
function closureInput(input, metadata) {
  const used = Object.keys(JSON.parse(metadata).sources);
  const sources = {};
  for (const name of used) {
    if (!input.sources[name]) throw new Error(`${name} is in the metadata but not in the input`);
    sources[name] = input.sources[name];
  }
  return { language: input.language ?? "Solidity", sources, settings: input.settings };
}

/** Whether code on chain is the compiled code byte for byte, metadata included (immutables zeroed). */
function sameBytes(onChain, compiled, immutableReferences) {
  if (!onChain || onChain === "0x") return false;
  return zeroImmutables(onChain, immutableReferences) === zeroImmutables(compiled, immutableReferences);
}

/**
 * Everything to submit for `fqn` at `address`: the sources that reproduce
 * its code (sourcesFor), cut down to the files it is built from when those
 * alone still reproduce it, the compiler, the ABI and the creation code (to
 * read its constructor arguments back from the creation transaction).
 * `exact` is whether the metadata matches too (Etherscan's "exact match").
 */
async function verificationInput(hre, { fqn, address, commit, root = repoRoot() }) {
  const onChain = await hre.ethers.provider.getCode(address);
  const found = await sourcesFor(hre, { fqn, address, commit, root });
  let full;
  if (found.from === "today") {
    const buildInfo = await hre.artifacts.getBuildInfo(fqn);
    const { sourceName, contractName } = splitFqn(fqn);
    const out = buildInfo.output.contracts[sourceName][contractName];
    full = {
      input: buildInfo.input,
      solcVersion: buildInfo.solcVersion,
      solcLongVersion: buildInfo.solcLongVersion,
      compiled: {
        bytecode: `0x${out.evm.bytecode.object}`,
        deployedBytecode: `0x${out.evm.deployedBytecode.object}`,
        immutableReferences: out.evm.deployedBytecode.immutableReferences ?? {},
        abi: out.abi,
        metadata: out.metadata,
        input: buildInfo.input,
      },
    };
  } else {
    full = { input: found.input, solcVersion: found.solcVersion, solcLongVersion: found.solcLongVersion, compiled: found.compiled };
  }

  let chosen = full.compiled;
  let reduced = false;
  if (full.compiled.metadata) {
    const small = await compileFor(hre, closureInput(full.compiled.input, full.compiled.metadata), full.solcVersion, fqn);
    if (sameExecutable(onChain, small.deployedBytecode, small.immutableReferences)) {
      chosen = small;
      reduced = true;
    }
  }
  return {
    from: found.from,
    input: chosen.input,
    reduced,
    solcLongVersion: full.solcLongVersion,
    abi: chosen.abi,
    bytecode: chosen.bytecode,
    exact: sameBytes(onChain, chosen.deployedBytecode, chosen.immutableReferences),
  };
}

module.exports = {
  PACKAGE_DIR,
  repoRoot,
  headSource,
  projectSourcesAt,
  sourcesUnchangedSince,
  withoutMetadata,
  zeroImmutables,
  sameExecutable,
  sameBytes,
  standardInputAt,
  compileFor,
  sourcesFor,
  verificationTargets,
  argsFromCreation,
  closureInput,
  verificationInput,
};
