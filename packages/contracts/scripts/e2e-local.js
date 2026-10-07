/**
 * One command for the whole local run:
 *
 *   pnpm --filter @polarispay/contracts e2e:local
 *
 * Starts a Hardhat node on 127.0.0.1:8600 (POLARIS_LOCAL_NODE_PORT to change
 * it), deploys everything with scripts/deploy-monad.js exactly as on testnet
 * (MockAUSD and a local MockKeystoneForwarder in place of AUSD and
 * Chainlink's), runs scripts/e2e-monad-local.js, and stops the node. The
 * node's own log goes to a temp file, printed on failure.
 */

"use strict";

const { spawn } = require("node:child_process");
const { createWriteStream, readFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");

const PORT = Number(process.env.POLARIS_LOCAL_NODE_PORT || 8600);
const ROOT = join(__dirname, "..");
const HARDHAT = join(dirname(require.resolve("hardhat/package.json")), "internal", "cli", "bootstrap.js");
const NODE_LOG = join(tmpdir(), `polaris-hardhat-node-${PORT}.log`);

async function rpcReady() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function hardhat(args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARDHAT, ...args], {
      cwd: ROOT,
      stdio: quiet ? "ignore" : "inherit",
      env: { ...process.env, POLARIS_LOCAL_NODE_PORT: String(PORT) },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`hardhat ${args[0]} ${args[1] ?? ""} exited ${code}`))));
  });
}

async function main() {
  if (await rpcReady()) {
    throw new Error(`Something already answers on port ${PORT}. Stop it, or set POLARIS_LOCAL_NODE_PORT (8600-8609).`);
  }
  const log = createWriteStream(NODE_LOG);
  const node = spawn(process.execPath, [HARDHAT, "node", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  node.stdout.pipe(log);
  node.stderr.pipe(log);

  let ok = false;
  try {
    const started = Date.now();
    while (!(await rpcReady())) {
      if (node.exitCode !== null) throw new Error(`hardhat node exited ${node.exitCode}`);
      if (Date.now() - started > 120_000) throw new Error("hardhat node did not start within 2 minutes");
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`Hardhat node on 127.0.0.1:${PORT} (log: ${NODE_LOG})\n`);
    await hardhat(["compile", "--quiet"], { quiet: true });
    await hardhat(["run", "scripts/deploy-monad.js", "--network", "monadLocal"]);
    console.log("");
    await hardhat(["run", "scripts/e2e-monad-local.js", "--network", "monadLocal"]);
    ok = true;
  } finally {
    node.kill();
    if (!ok) {
      try {
        const tail = readFileSync(NODE_LOG, "utf8").split("\n").slice(-40).join("\n");
        console.error(`\nLast lines of the node log:\n${tail}`);
      } catch {
        // no log
      }
    }
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
