/**
 * Monadscan through the Etherscan V2 API: one endpoint for every chain, the
 * chain named by `chainid` on every call (Monad testnet is 10143, on the free
 * tier). Used by scripts/verify-monad.js; tested in
 * test/metropolis/Verify.test.js with a stand-in `fetch`.
 *
 * Every request carries `chainid` itself. hardhat-verify drops it when the
 * config gives one key per network (it then treats the explorer as V1 and
 * overwrites the query string that held `chainid=10143`), and V2 answers
 * "Missing chainid parameter".
 */

"use strict";

const ETHERSCAN_V2_API = "https://api.etherscan.io/v2/api";
const MONAD_TESTNET = { chainId: 10143, explorer: "https://testnet.monadscan.com" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The explorer page that shows `address`'s source. */
function codeUrl(explorer, address) {
  return `${explorer.replace(/\/$/, "")}/address/${address}#code`;
}

/**
 * A client for one chain. `fetch` and `pollMs` are for tests; the key is sent
 * in the query (GET) or the form body (POST) and never logged.
 */
function monadscan({ apiKey, chainId = MONAD_TESTNET.chainId, apiUrl = ETHERSCAN_V2_API, fetch: fetchFn = globalThis.fetch, pollMs = 3000, polls = 40 } = {}) {
  if (!apiKey) throw new Error("an Etherscan V2 API key is needed");

  function url(params = {}) {
    const u = new URL(apiUrl);
    u.search = new URLSearchParams({ chainid: String(chainId), ...params }).toString();
    return u;
  }

  async function call(u, init) {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetchFn(u, init);
      if (!res.ok) throw new Error(`Etherscan V2 answered HTTP ${res.status}`);
      const json = await res.json();
      // The free tier allows a few calls a second: wait and ask again.
      if (json.status === "0" && /rate limit/i.test(String(json.result)) && attempt < 5) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return json;
    }
  }

  /** getsourcecode: the explorer's record for `address` ({ verified, name, compilerVersion, ... }). */
  async function sourceOf(address) {
    const json = await call(url({ module: "contract", action: "getsourcecode", address, apikey: apiKey }));
    if (json.status !== "1" || !Array.isArray(json.result)) throw new Error(`getsourcecode ${address}: ${json.message}: ${json.result}`);
    const r = json.result[0] ?? {};
    const verified = typeof r.SourceCode === "string" && r.SourceCode !== "";
    return {
      verified,
      name: r.ContractName || null,
      compilerVersion: r.CompilerVersion || null,
      optimizationUsed: r.OptimizationUsed === "1",
      runs: r.Runs ? Number(r.Runs) : null,
      evmVersion: r.EVMVersion || null,
      constructorArguments: r.ConstructorArguments || null,
      licenseType: r.LicenseType || null,
    };
  }

  /**
   * verifysourcecode with a standard-JSON input; resolves to the GUID to poll.
   * An "already verified" answer resolves to null.
   */
  async function submit({ address, input, contractName, compilerVersion, constructorArguments = "" }) {
    const body = new URLSearchParams({
      apikey: apiKey,
      module: "contract",
      action: "verifysourcecode",
      contractaddress: address,
      sourceCode: typeof input === "string" ? input : JSON.stringify(input),
      codeformat: "solidity-standard-json-input",
      contractname: contractName,
      compilerversion: compilerVersion.startsWith("v") ? compilerVersion : `v${compilerVersion}`,
      // Etherscan's own spelling.
      constructorArguements: constructorArguments.replace(/^0x/, ""),
    });
    const json = await call(url(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (isAlreadyVerified(json.result)) return null;
    if (json.status !== "1") throw new Error(`verifysourcecode ${address}: ${json.result}`);
    return json.result;
  }

  /** checkverifystatus until it leaves the queue: "verified", "already verified", or a thrown failure. */
  async function waitFor(guid) {
    for (let i = 0; i < polls; i++) {
      const json = await call(url({ module: "contract", action: "checkverifystatus", guid, apikey: apiKey }));
      const result = String(json.result);
      if (/^Pass - Verified/i.test(result)) return "verified";
      if (isAlreadyVerified(result)) return "already verified";
      if (/Pending in queue|In progress/i.test(result)) {
        await sleep(pollMs);
        continue;
      }
      throw new Error(result);
    }
    throw new Error(`still pending after ${polls} polls (GUID ${guid})`);
  }

  return { chainId, sourceOf, submit, waitFor };
}

function isAlreadyVerified(result) {
  return /already verified/i.test(String(result));
}

/**
 * deployments/<network>.verification.json: what the explorer says of each
 * contract (getsourcecode), with the sources each was verified from.
 *
 * @param {object} record     the deployment record
 * @param {object[]} entries  per target: { target, fqn, explorer: sourceOf(), local?: { from, solcLongVersion, reduced, exact } }
 */
function verificationRecord({ record, entries, checkedAt }) {
  const explorer = record.explorer ?? MONAD_TESTNET.explorer;
  const contracts = entries.map(({ target, fqn, explorer: seen, local }) => {
    const sourceCommit = local && local.from !== "today" ? local.from : target.commit;
    return {
      name: target.name,
      address: target.address,
      verified: seen.verified,
      explorerUrl: codeUrl(explorer, target.address),
      compilerVersion: seen.compilerVersion ?? (local ? `v${local.solcLongVersion}` : null),
      contract: fqn,
      explorerName: seen.name,
      optimizer: seen.verified ? (seen.optimizationUsed ? `enabled, ${seen.runs} runs` : "disabled") : null,
      evmVersion: seen.evmVersion,
      sources: local ? (local.from === "today" ? "today's (unchanged since deploy)" : `commit ${local.from}`) : null,
      sourceCommit,
      ...(local ? { match: local.exact ? "exact (metadata too)" : "executable code (metadata differs)" } : {}),
      current: target.current,
      ...(target.replacedBy ? { replacedBy: target.replacedBy } : {}),
    };
  });
  return {
    note: "Every Polaris contract on Monad testnet, as Monadscan shows it (Etherscan V2 getsourcecode, chainid " + record.chainId + "). Written by `pnpm --filter @polarispay/contracts verify:monad` (scripts/verify-monad.js).",
    network: record.network,
    chainId: record.chainId,
    explorer,
    api: `${ETHERSCAN_V2_API}?chainid=${record.chainId}`,
    checkedAt,
    verified: contracts.filter((c) => c.verified).length,
    total: contracts.length,
    contracts,
  };
}

module.exports = { ETHERSCAN_V2_API, MONAD_TESTNET, codeUrl, monadscan, isAlreadyVerified, verificationRecord };
