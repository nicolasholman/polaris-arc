/**
 * The Polaris keeper: `pnpm --filter @polaris/keeper start` (or `once` for a
 * single collections run). See README.md.
 */

import { formatUnits } from "viem";

import { clientsFor } from "./chain.ts";
import { reauthorizedSince, retryBuyer, runCollections } from "./collections.ts";
import { loadConfig } from "./config.ts";
import { type KeeperState, startServer } from "./server.ts";
import { Reviewer } from "./underwriting.ts";

const config = loadConfig();
const c = clientsFor(config);
const once = process.argv.includes("--once");
const state: KeeperState = { startedAt: new Date().toISOString(), lastRun: null, reviews: [], queued: 0, address: c.account?.address ?? null };

console.log(`[keeper] ${config.deployment.chainName ?? `chain ${config.chainId}`} via ${config.rpcUrl}`);
console.log(`[keeper] record ${config.deploymentPath}`);
if (c.account) {
  const balance = await c.public.getBalance({ address: c.account.address });
  console.log(`[keeper] keeper ${c.account.address}: ${formatUnits(balance, 18)} USDC for gas`);
  const expected = config.deployment.roles?.keeper;
  if (expected && expected.toLowerCase() !== c.account.address.toLowerCase()) {
    console.warn(`[keeper] WARNING: the receivers trust ${expected}, not this key: every report will revert with NotKeeper`);
  }
} else {
  console.log("[keeper] read-only: set POLARIS_KEEPER_PRIVATE_KEY to send reports");
}
console.log(`[keeper] callbacks: ${config.callback ? config.callback.url : "off (POLARIS_API_URL / POLARIS_KEEPER_CALLBACK_SECRET unset)"}`);

let tick = 0n;
const log = (s: Awaited<ReturnType<typeof runCollections>>) => {
  state.lastRun = { at: new Date().toISOString(), ...s };
  const what = s.tasks.length ? `${s.tasks.length} task(s): ${s.executed} executed, ${s.skipped} skipped${s.txHash ? ` ${s.txHash}` : ""}` : "nothing due";
  console.log(`[keeper] ${s.trigger} run: checked ${s.checked}, ${what}${s.heldBack ? `, ${s.heldBack} held back` : ""}${s.error ? `; error: ${s.error}` : ""}`);
  for (const k of s.skips) console.log(`[keeper]   skipped ${k.action} #${k.id}: ${k.reason}`);
};

if (once) {
  log(await runCollections(c, config, tick));
  process.exit(0);
}

startServer(config, new Reviewer(c, config), state);
console.log(`[keeper] reviews: POST http://${config.http.host}:${config.http.port}/underwrite`);

let lastBlock = await c.public.getBlockNumber();
let running = false;
const loop = async () => {
  if (running) return;
  running = true;
  try {
    tick++;
    log(await runCollections(c, config, tick));
    const { buyers, toBlock } = await reauthorizedSince(c, config, lastBlock + 1n);
    lastBlock = toBlock;
    for (const buyer of buyers) log(await retryBuyer(c, config, buyer));
  } catch (e) {
    console.error(`[keeper] loop: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    running = false;
  }
};
await loop();
setInterval(loop, config.collections.intervalSeconds * 1000);
// The instant retry polls for re-signs more often than the timed run.
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    const { buyers, toBlock } = await reauthorizedSince(c, config, lastBlock + 1n);
    lastBlock = toBlock;
    for (const buyer of buyers) log(await retryBuyer(c, config, buyer));
  } catch {
    // the next timed run catches up
  } finally {
    running = false;
  }
}, 5_000);
