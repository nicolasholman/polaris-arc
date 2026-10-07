/**
 * The recipe is the same code in both runtimes. Driven synchronously, one
 * request at a time, the way a CRE workflow does inside node mode, it must
 * produce exactly the evidence the Node service gets, and stay inside CRE's
 * 15 HTTP calls per execution.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RequestSpec } from "../src/core/providers/common.ts";
import { accountRecipe, all, linkedRecipe, notConfiguredReply, runSync, type Recipe, type Reply } from "../src/core/recipe.ts";
import type { KeyedProvider } from "../src/core/types.ts";
import { underwrite } from "../src/core/underwrite.ts";
import { collectAccount, collectLinked } from "../src/node/collect.ts";
import { fixtureResponse } from "../src/testing/fixtures.ts";
import { ProviderError } from "../src/node/http.ts";
import { ACCOUNT, fixtureProviders, LINKED, NOW } from "./helpers.ts";

/**
 * A CRE-style sender: synchronous, no retries, against the fixtures. A
 * provider in `notConfigured` has no key, so, as the workflow's senders do,
 * its requests get `notConfiguredReply` and are never sent.
 */
function creSender(log: RequestSpec[] = [], notConfigured: readonly KeyedProvider[] = []) {
  return (spec: RequestSpec): Reply => {
    if (spec.provider !== "rpc" && notConfigured.includes(spec.provider)) return notConfiguredReply(spec);
    log.push(spec);
    try {
      const res = fixtureResponse({ method: spec.method, url: spec.url, headers: spec.headers, body: spec.body });
      return { ok: true, status: res.status, body: JSON.parse(res.body) };
    } catch (err) {
      const e = err as ProviderError;
      return { ok: false, code: e.code ?? "error", retryable: e.retryable ?? false, retryAfterMs: null, message: e.message };
    }
  };
}

describe("one recipe, two runtimes", () => {
  for (const [name, address] of Object.entries(LINKED)) {
    it(`linked wallet "${name}": the CRE drive and the Node drive agree, within 15 calls`, async () => {
      const log: RequestSpec[] = [];
      const cre = runSync(linkedRecipe(address, { now: NOW }), creSender(log));
      const node = await collectLinked(address, fixtureProviders(), { now: NOW });
      assert.deepEqual(cre.evidence, node.evidence);
      assert.deepEqual(cre.issues, node.issues);
      assert.ok(log.length <= 15, `${log.length} HTTP calls`);
    });
  }

  for (const [name, address] of Object.entries(ACCOUNT)) {
    it(`account "${name}": the CRE drive and the Node drive agree`, async () => {
      const cre = runSync(accountRecipe(address, { now: NOW }), creSender());
      const node = await collectAccount(address, fixtureProviders(), { now: NOW });
      assert.deepEqual(cre.evidence, node.evidence);
    });
  }

  const missingKeys: KeyedProvider[][] = [["nansen"], ["zerion"], ["etherscan"], ["nansen", "zerion"], ["nansen", "zerion", "etherscan"]];
  for (const keys of missingKeys) {
    it(`without ${keys.join(" and ")}: both drives agree, send nothing to them, and nothing reads as zero`, async () => {
      for (const address of [...Object.values(LINKED), ...Object.values(ACCOUNT)]) {
        const log: RequestSpec[] = [];
        const isAccount = (Object.values(ACCOUNT) as string[]).includes(address);
        const recipe = isAccount ? accountRecipe(address, { now: NOW }) : linkedRecipe(address, { now: NOW });
        const cre = runSync(recipe, creSender(log, keys));
        const p = fixtureProviders(undefined, { notConfigured: keys });
        const node = await (isAccount ? collectAccount : collectLinked)(address, p, { now: NOW });
        assert.deepEqual(cre.evidence, node.evidence, address);
        assert.deepEqual(cre.issues, node.issues, address);
        assert.equal(log.filter((s) => (keys as string[]).includes(s.provider)).length, 0, `${address}: a provider without a key is never called`);
        for (const [field, ev] of Object.entries(cre.evidence)) {
          if (field === "address" || field === "role") continue;
          const e = ev as { status: string; source: string; detail?: string };
          if (e.status === "not_configured") assert.match(e.detail ?? "", / not configured$/, `${address}.${field}`);
        }
        assert.ok(
          cre.issues.filter((i) => i.code === "not_configured").every((i) => !i.retryable && / is not configured \(\w+_API_KEY is not set\)$/.test(i.message)),
          address,
        );
      }
    });
  }

  it("without Nansen, a linked wallet's risk checks are not configured (never missing, never zero) and Zerion still answers what it can", () => {
    const linked = runSync(linkedRecipe(LINKED.strong, { now: NOW }), creSender([], ["nansen"]));
    const e = linked.evidence;
    assert.equal(e.funder.status, "not_configured");
    assert.equal(e.relatedWallets.status, "not_configured");
    assert.equal(e.riskLabel.status, "not_configured");
    assert.equal(e.stableBalance.status, "ok", "Zerion reads the balance");
    assert.equal(e.firstSeenAt.status, "fallback", "Zerion's probes date it");
    assert.equal(e.liquidations.status, "ok", "Etherscan reads the liquidations");
    const out = underwrite({ user: ACCOUNT.fresh, observedAt: NOW, account: runSync(accountRecipe(ACCOUNT.fresh, { now: NOW }), creSender()).evidence, linked: e, linkVerified: true });
    assert.equal(out.final, false);
    assert.equal(out.unavailable, true);
    assert.equal(out.report, null);
  });

  it("a source that fails for real beside one that isn't configured is missing: asking again may help", () => {
    const send = creSender([], ["zerion"]);
    const down = (spec: RequestSpec): Reply =>
      spec.provider === "nansen" ? { ok: false, code: "network_error", retryable: true, retryAfterMs: null, message: "down" } : send(spec);
    const e = runSync(linkedRecipe(LINKED.strong, { now: NOW }), down).evidence;
    assert.equal(e.stableBalance.status, "missing", "zerion not configured, nansen down: missing, not not_configured");
    assert.equal(e.funder.status, "missing");
  });

  it("with balances read as EVM reads, the account costs one HTTP call, and a whole run fits CRE's quota", () => {
    const log: RequestSpec[] = [];
    const send = creSender(log);
    const account = runSync(accountRecipe(ACCOUNT.fresh, { now: NOW, accountBalance: 37_600_000 }), send);
    const accountCalls = log.length;
    const linked = runSync(linkedRecipe(LINKED.modest, { now: NOW }), send);
    assert.equal(accountCalls, 1);
    assert.ok(log.length <= 15, `${log.length} HTTP calls`);
    const out = underwrite({ user: ACCOUNT.fresh, observedAt: NOW, account: account.evidence, linked: linked.evidence, linkVerified: true });
    assert.equal(out.final, true);
    assert.equal(out.facts.relatedWallets, 6);
  });

  it("sends independent requests together: the first round of a linked run is one batch", () => {
    const recipe = linkedRecipe(LINKED.strong, { now: NOW });
    const first = recipe.next([]);
    assert.equal(first.done, false);
    const endpoints = (first.value as RequestSpec[]).map((s) => `${s.provider}.${s.endpoint}`).sort();
    assert.deepEqual(endpoints, [
      "etherscan.logs",
      "etherscan.logs",
      "etherscan.logs",
      "nansen.first-funder",
      "rpc.nonce",
      "rpc.nonce",
      "rpc.nonce",
      "zerion.positions",
      "zerion.transactions",
    ]);
  });

  it("all() hands each recipe its own replies, in order", () => {
    const spec = (n: string): RequestSpec => ({ provider: "rpc", endpoint: n, method: "POST", url: n, headers: {} });
    function* two(): Recipe<string[]> {
      const a = yield [spec("a1"), spec("a2")];
      const b = yield [spec("a3")];
      return [...a, ...b].map((r) => (r.ok ? String(r.body) : "x"));
    }
    function* one(): Recipe<string> {
      const [r] = yield [spec("b1")];
      return r?.ok ? String(r.body) : "x";
    }
    function* none(): Recipe<number> {
      return 7;
    }
    const rounds: string[][] = [];
    const out = runSync(all<[string[], string, number]>([two(), one(), none()]), (s) => {
      rounds.push([s.url]);
      return { ok: true, status: 200, body: s.url.toUpperCase() };
    });
    assert.deepEqual(out, [["A1", "A2", "A3"], "B1", 7]);
    assert.deepEqual(rounds.flat(), ["a1", "a2", "b1", "a3"]);
  });

  it("a driver that drops a reply yields a missing fact, not a crash or a zero", () => {
    const out = runSync(linkedRecipe(LINKED.strong, { now: NOW }), (s) =>
      s.provider === "etherscan" ? (undefined as unknown as Reply) : creSender()(s),
    );
    assert.equal(out.evidence.liquidations.status, "missing");
    assert.ok(out.issues.some((i) => i.code === "no_reply"));
  });
});
