import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { Abi, AbiFunction, AbiParameter } from "viem";

import { ausdAbi, sendAbi, vaultAbi } from "../src/lib/data/reads.ts";

/**
 * The views the app reads from the chain itself (src/lib/data/reads.ts) are
 * the contracts' own: same name, same argument and return types as the ABIs
 * packages/contracts exports. A renamed or retyped view fails here, not as a
 * silent zero on a screen.
 */

const here = dirname(fileURLToPath(import.meta.url));
const abiOf = (name: string): Abi => JSON.parse(readFileSync(join(here, "..", "..", "..", "packages", "contracts", "abi", `${name}.json`), "utf8"));

const shape = (p: readonly AbiParameter[]): string[] =>
  p.map((x) => ("components" in x && x.components ? `(${shape(x.components).join(",")})` : x.type));

function assertMatches(app: Abi, contract: string) {
  const theirs = abiOf(contract).filter((x): x is AbiFunction => x.type === "function");
  for (const fn of app.filter((x): x is AbiFunction => x.type === "function")) {
    const match = theirs.find((x) => x.name === fn.name && shape(x.inputs).join() === shape(fn.inputs).join());
    assert.ok(match, `${contract} has no ${fn.name}(${shape(fn.inputs).join(",")})`);
    assert.deepEqual(shape(match.outputs), shape(fn.outputs), `${contract}.${fn.name} returns what the app decodes`);
    assert.ok(match.stateMutability === "view" || match.stateMutability === "pure", `${contract}.${fn.name} is a view`);
  }
}

describe("the app's chain reads match the contracts", () => {
  it("the dollar's balanceOf", () => assertMatches(ausdAbi, "MockAUSD"));
  it("PolarisSend's linkOf and keyUsed", () => assertMatches(sendAbi, "PolarisSend"));
  it("CollateralVault's lockedOf, creditMultiplierBps, withdrawable and nonces (Boost)", () => assertMatches(vaultAbi, "CollateralVault"));
});
