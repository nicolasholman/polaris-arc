/**
 * Writes fixtures/ from the personas below.
 *
 *   pnpm --filter @polarispay/underwriting fixtures:synthesize
 *
 * No Nansen, Zerion or Etherscan key existed when this package was built, so
 * these fixtures are SYNTHESIZED, not recorded: every body follows the
 * provider's documented response schema (docs/research/data.md §2.5, §3.3,
 * §4.3; Arc's Blockscout API as checked against explorer.testnet.arc.io), and
 * every file says so in its `fixture` block. The addresses are
 * synthetic (runs of zeros) so no real person's wallet is described. Once
 * keys exist, `pnpm --filter @polarispay/underwriting record <address>` saves
 * real responses in the same format, marked `recorded: true`.
 *
 * Deterministic: the same script writes the same bytes.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../fixtures/", import.meta.url));
/** Every persona's history is dated back from here. Tests pin "now" to this day, at noon. */
const REF = Date.UTC(2026, 8, 26, 0, 0, 0) / 1000;
const DAY = 86_400;
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");
const ago = (days: number, extraSeconds = 0) => REF - Math.round(days * DAY) + extraSeconds;
const hash = (seed: string) => `0x${createHash("sha256").update(seed).digest("hex")}`;
const addr = (prefix: string, n: number) => `0x${prefix}${n.toString(16).padStart(40 - prefix.length, "0")}`;

const LABEL = "FIXTURE: synthesized in the provider's documented response shape. Not live data, not a recording.";

function write(rel: string, file: unknown) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

function meta(provider: string, request: string, shape: string, persona: string, notes?: string) {
  return { label: LABEL, provider, request, shape, persona, recorded: false, synthesizedFor: iso(REF), ...(notes ? { notes } : {}) };
}

// ------------------------------------------------------------------ tokens

type Fungible = { name: string; symbol: string; decimals: number; chain: string; address: string | null; verified: boolean; price: number };
const T = {
  usdcEth: { name: "USD Coin", symbol: "USDC", decimals: 6, chain: "ethereum", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", verified: true, price: 1 },
  usdcBase: { name: "USD Coin", symbol: "USDC", decimals: 6, chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", verified: true, price: 1 },
  daiEth: { name: "Dai Stablecoin", symbol: "DAI", decimals: 18, chain: "ethereum", address: "0x6b175474e89094c44da98b954eedeac495271d0f", verified: true, price: 1 },
  eth: { name: "Ethereum", symbol: "ETH", decimals: 18, chain: "ethereum", address: null, verified: true, price: 3120.4 },
  fakeUsdc: { name: "USDC Airdrop (visit claim site)", symbol: "USDC", decimals: 6, chain: "ethereum", address: "0x00000000000000000000000000000000000f4ce0", verified: false, price: 0.0001 },
} satisfies Record<string, Fungible>;

function fungibleInfo(t: Fungible) {
  return {
    name: t.name,
    symbol: t.symbol,
    icon: null,
    flags: { verified: t.verified },
    implementations: [{ chain_id: t.chain, address: t.address, decimals: t.decimals }],
  };
}

function quantity(amount: string, decimals: number) {
  const [whole, frac = ""] = amount.split(".");
  const int = (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
  return { int, decimals, float: Number(amount), numeric: amount };
}

// ------------------------------------------------------------------ Zerion

type Op = "receive" | "send" | "trade" | "deposit" | "withdraw" | "execute" | "approve";
type Tx = { days: number; op: Op; token: Fungible; amount: string; chain: string; dapp?: string; trash?: boolean; direction?: "in" | "out" };

function zerionTx(owner: string, tx: Tx, i: number, persona: string) {
  const h = hash(`${persona}:${owner}:${i}`);
  const counterparty = addr("c0", i + 1);
  const direction = tx.direction ?? (tx.op === "receive" || tx.op === "withdraw" ? "in" : "out");
  const mined = ago(tx.days, (i * 3_607) % DAY);
  return {
    type: "transactions",
    id: `${h}-0`,
    attributes: {
      operation_type: tx.op,
      hash: h,
      mined_at_block: 18_000_000 + i * 1_337,
      mined_at: iso(mined),
      sent_from: direction === "in" ? counterparty : owner,
      sent_to: direction === "in" ? owner : counterparty,
      status: "confirmed",
      nonce: direction === "out" ? i : 0,
      fee: direction === "out"
        ? { fungible_info: fungibleInfo(tx.chain === "base" ? { ...T.eth, chain: "base" } : T.eth), quantity: quantity("0.000412", 18), price: 3120.4, value: 1.29 }
        : null,
      transfers: [
        {
          fungible_info: fungibleInfo(tx.token),
          direction,
          quantity: quantity(tx.amount, tx.token.decimals),
          value: Number(tx.amount) * tx.token.price,
          price: tx.token.price,
          sender: direction === "in" ? counterparty : owner,
          recipient: direction === "in" ? owner : counterparty,
        },
      ],
      approvals: [],
      application_metadata: tx.dapp ? { name: tx.dapp, contract_address: addr("da", i + 1), method: { id: "0x3593564c", name: "execute" } } : null,
      flags: { is_trash: tx.trash ?? false },
      acts: [{ id: `${h}-act-0`, type: tx.op, application_metadata: null }],
    },
    relationships: {
      chain: { links: { related: `https://api.zerion.io/v1/chains/${tx.chain}` }, data: { type: "chains", id: tx.chain } },
      ...(tx.dapp ? { dapp: { data: { type: "dapps", id: tx.dapp.toLowerCase().replace(/\s+/g, "-") } } } : {}),
    },
  };
}

function zerionTransactions(owner: string, txs: Tx[], persona: string, testnet: boolean) {
  const data = txs.map((t, i) => zerionTx(owner, t, i, persona)).sort((a, b) => (a.attributes.mined_at < b.attributes.mined_at ? 1 : -1));
  write(`zerion/transactions/${owner}${testnet ? ".testnet" : ""}.json`, {
    fixture: meta(
      "zerion",
      `GET /v1/wallets/${owner}/transactions/${testnet ? " (X-Env: testnet)" : ""}`,
      "Wallet transactions response, Zerion OpenAPI (docs/research/data.md §3.3)",
      persona,
      "The full history. The fixture transport applies filter[chain_ids], filter[operation_types], filter[min_mined_at], filter[max_mined_at], filter[trash] and page[size] to these rows, newest first, as the API does.",
    ),
    status: 200,
    headers: { "ratelimit-org-second-limit": "3", "ratelimit-org-day-limit": "2000" },
    body: { links: { self: `https://api.zerion.io/v1/wallets/${owner}/transactions/` }, data },
  });
}

type Pos = { token: Fungible; amount: string; trash?: boolean; type?: "wallet" | "deposit" };
function zerionPositions(owner: string, positions: Pos[], persona: string, testnet = false) {
  const data = positions.map((p, i) => ({
    type: "positions",
    id: `${p.token.address ?? "base"}-${p.token.chain}-asset-asset-${i}`,
    attributes: {
      parent: null,
      protocol: null,
      name: "Asset",
      position_type: p.type ?? "wallet",
      quantity: quantity(p.amount, p.token.decimals),
      value: Math.round(Number(p.amount) * p.token.price * 100) / 100,
      price: p.token.price,
      changes: { absolute_1d: 0, percent_1d: 0 },
      fungible_info: fungibleInfo(p.token),
      flags: { displayable: !p.trash, is_trash: p.trash ?? false },
      application_metadata: null,
      updated_at: iso(REF - 3_600),
      updated_at_block: 21_000_000,
    },
    relationships: {
      chain: { links: { related: `https://api.zerion.io/v1/chains/${p.token.chain}` }, data: { type: "chains", id: p.token.chain } },
      fungible: { links: { related: `https://api.zerion.io/v1/fungibles/${p.token.symbol.toLowerCase()}` }, data: { type: "fungibles", id: p.token.symbol.toLowerCase() } },
    },
  }));
  write(`zerion/positions/${owner}${testnet ? ".testnet" : ""}.json`, {
    fixture: meta("zerion", `GET /v1/wallets/${owner}/positions/?filter[positions]=only_simple&filter[trash]=only_non_trash`, "Wallet fungible positions response, Zerion OpenAPI (docs/research/data.md §3.3)", persona, "Not paginated, like the API. filter[chain_ids] is applied by the fixture transport. The trash row shows the API's own filter would drop it; the parser drops it too."),
    status: 200,
    headers: {},
    body: { links: { self: `https://api.zerion.io/v1/wallets/${owner}/positions/` }, data },
  });
}

function zerionNotTrackable(owner: string, kind: "transactions" | "positions", persona: string) {
  write(`zerion/${kind}/${owner}.json`, {
    fixture: meta("zerion", `GET /v1/wallets/${owner}/${kind}/`, "Zerion error response for an untrackable address (developers.zerion.io/error-handling)", persona),
    status: 400,
    headers: {},
    body: { errors: [{ title: "Parameter error", detail: `address ${owner} is not trackable` }] },
  });
}

// ------------------------------------------------------------------ Nansen

const PAGE = (perPage: number, last = true) => ({ page: 1, per_page: perPage, is_last_page: last });
const CREDITS = (n: number) => ({ "x-nansen-credits-cost": String(n), "x-nansen-credits-used": String(n), "x-nansen-credits-remaining": "96" });

function nansenFirstFunder(owner: string, row: { funder: string; name: string | null; chain: string; days: number } | null, persona: string) {
  write(`nansen/first-funder/${owner}.json`, {
    fixture: meta("nansen", "POST /api/v1/profiler/address/first-funder", "ProfilerAddressFirstFunderResponse, Nansen OpenAPI 1.0.0 (docs/research/data.md §2.5.1)", persona, row ? undefined : "Empty data: Nansen has no first-funder attribution, e.g. an exchange or bridge paid the gas."),
    status: 200,
    headers: CREDITS(1),
    body: {
      pagination: PAGE(10),
      data: row
        ? [
            {
              wallet_address: owner,
              first_funder_address: row.funder,
              ...(row.name ? { first_funder_name: row.name } : {}),
              transaction_hash: hash(`${persona}:funding`),
              block_timestamp: iso(ago(row.days, 34_567)),
              chain: row.chain,
            },
          ]
        : [],
    },
  });
}

function nansenRelated(funder: string, chain: string, related: string[], persona: string, last = true) {
  write(`nansen/related-wallets/${funder}.${chain}.json`, {
    fixture: meta("nansen", "POST /api/v1/profiler/address/related-wallets", "ProfilerRelatedWallet rows, Nansen OpenAPI 1.0.0 (docs/research/data.md §2.5.2)", persona, "The relation vocabulary is UNVERIFIED (data.md §9 item 2); the collector counts every relation."),
    status: 200,
    headers: CREDITS(1),
    body: {
      pagination: PAGE(100, last),
      data: related.map((a, i) => ({
        address: a,
        relation: i === 0 ? "First Funder" : "Funded",
        transaction_hash: hash(`${persona}:related:${i}`),
        block_timestamp: iso(ago(40 + i, i * 97)),
        order: i + 1,
        chain,
      })),
    },
  });
}

function nansenCurrentBalance(owner: string, rows: Array<{ token: Fungible; amount: number }>, persona: string) {
  write(`nansen/current-balance/${owner}.json`, {
    fixture: meta("nansen", "POST /api/v1/profiler/address/current-balance", "Current balance rows, Nansen OpenAPI 1.0.0 (docs/research/data.md §2.5.6)", persona, "token_amount is a float, as documented; the collector prefers Zerion's exact integers and uses this only as the fallback."),
    status: 200,
    headers: CREDITS(1),
    body: {
      pagination: PAGE(100),
      data: rows.map((r) => ({
        chain: r.token.chain,
        address: owner,
        token_address: r.token.address ?? "0x0000000000000000000000000000000000000000",
        token_symbol: r.token.symbol,
        token_name: r.token.name,
        token_amount: r.amount,
        price_usd: r.token.price,
        value_usd: Math.round(r.amount * r.token.price * 100) / 100,
      })),
    },
  });
}

function nansenTransactions(owner: string, rows: Array<{ days: number; sourceType: string; token: Fungible; amount: number }>, persona: string) {
  write(`nansen/transactions/${owner}.json`, {
    fixture: meta("nansen", "POST /api/v1/profiler/address/transactions", "ProfilerTransaction rows, Nansen OpenAPI 1.0.0 (docs/research/data.md §2.5.4)", persona, "The fixture transport applies date, filters.source_type, order_by and per_page. The source_type vocabulary beyond dex/transfer is UNVERIFIED."),
    status: 200,
    headers: CREDITS(1),
    body: {
      pagination: PAGE(100),
      data: rows.map((r, i) => ({
        chain: r.token.chain,
        method: r.sourceType === "dex" ? "swap" : "received",
        volume_usd: r.amount * r.token.price,
        block_timestamp: iso(ago(r.days, i * 61)),
        transaction_hash: hash(`${persona}:ntx:${i}`),
        source_type: r.sourceType,
        tokens_sent: [
          { token_symbol: r.token.symbol, token_amount: r.amount, price_usd: r.token.price, value_usd: r.amount * r.token.price, token_address: r.token.address ?? "", chain: r.token.chain, from_address: owner, to_address: addr("da", i + 1), from_address_label: null, to_address_label: r.sourceType === "dex" ? "Uniswap V3: Router" : null },
        ],
        tokens_received: [],
      })),
    },
  });
}

function nansenLabels(owner: string, labels: Array<{ label: string; category: string }>, persona: string) {
  write(`nansen/labels/${owner}.json`, {
    fixture: meta("nansen", "POST /api/v1/profiler/address/labels", "Labels response, Nansen OpenAPI 1.0.0 (docs/research/data.md §2.5.7)", persona, "100 credits, API key only. Off unless NANSEN_LABELS=1."),
    status: 200,
    headers: CREDITS(100),
    body: { pagination: PAGE(100), data: labels.map((l) => ({ ...l, kind: [] })) },
  });
}

function nansenPnl(owner: string, persona: string) {
  write(`nansen/pnl-summary/${owner}.json`, {
    fixture: meta("nansen", "POST /api/v1/profiler/address/pnl-summary", "PnL summary response, Nansen OpenAPI 1.0.0 (docs/research/data.md §2.5.5)", persona, "Context only; not a Facts field."),
    status: 200,
    headers: CREDITS(1),
    body: {
      pagination: PAGE(10),
      top5_tokens: [
        { realized_pnl: 812.4, realized_roi: 0.21, token_address: T.eth.address ?? "0x0000000000000000000000000000000000000000", token_symbol: "ETH", chain: "ethereum" },
        { realized_pnl: 96.1, realized_roi: 0.08, token_address: "0x514910771af9ca656af840dff83e8264ecf986ca", token_symbol: "LINK", chain: "ethereum" },
      ],
      traded_token_count: 14,
      traded_times: 61,
      realized_pnl_usd: 1043.77,
      realized_pnl_percent: 0.17,
      win_rate: 0.62,
    },
  });
}

function nansenCounterparties(owner: string, persona: string) {
  write(`nansen/counterparties/${owner}.json`, {
    fixture: meta("nansen", "POST /api/v1/profiler/address/counterparties", "ProfilerCounterparty rows, Nansen OpenAPI 1.0.0 (docs/research/data.md §2.5.3)", persona, "5 credits. Not on the default recipe."),
    status: 200,
    headers: CREDITS(5),
    body: {
      pagination: PAGE(10),
      data: [
        {
          counterparty_address: addr("c0ba5e", 2),
          counterparty_address_label: ["Coinbase: Hot Wallet 2", "Exchange"],
          interaction_count: 9,
          total_volume_usd: 6410.5,
          volume_in_usd: 5210.5,
          volume_out_usd: 1200,
          tokens_info: [{ token_address: T.usdcEth.address, token_symbol: "USDC", token_name: "USD Coin", num_transfer: 9, total_token_amount: 6410.5, token_in_amount: 5210.5, token_out_amount: 1200 }],
        },
      ],
    },
  });
}

// ------------------------------------------------------------------ Etherscan

const POOLS: Record<number, string> = {
  1: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
  42161: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
  137: "0x794a61358d6845594f94dc1db02a252b5b4814ad",
};
const TOPIC0 = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";

function etherscanLogs(owner: string, chainId: number, logs: Array<{ emitter: string; days: number }>, persona: string) {
  const topic3 = `0x${owner.slice(2).padStart(64, "0")}`;
  const body = logs.length
    ? {
        status: "1",
        message: "OK",
        result: logs.map((l, i) => ({
          address: l.emitter,
          topics: [TOPIC0, `0x${"a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".padStart(64, "0")}`, `0x${"c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2".padStart(64, "0")}`, topic3],
          data: `0x${"0".repeat(56)}3b9aca00${"0".repeat(56)}0de0b6b3${"0".repeat(24)}${addr("11", i + 1).slice(2)}${"0".repeat(64)}`,
          blockNumber: `0x${(19_000_000 + i * 50_000).toString(16)}`,
          timeStamp: `0x${ago(l.days).toString(16)}`,
          gasPrice: "0x3b9aca00",
          gasUsed: "0x5208",
          logIndex: "0x1",
          transactionHash: hash(`${persona}:liq:${chainId}:${i}`),
          transactionIndex: "0x2",
        })),
      }
    : { status: "0", message: "No records found", result: [] };
  write(`etherscan/logs/${owner}.${chainId}.json`, {
    fixture: meta("etherscan", `GET /v2/api?chainid=${chainId}&module=logs&action=getLogs&topic0=LiquidationCall&topic3=<borrower>`, "Etherscan V2 getLogs response (docs.etherscan.io/api-reference/endpoint/getlogs-topics)", persona),
    status: 200,
    headers: {},
    body,
  });
}

// ------------------------------------------------------------------ Blockscout (Arc's explorer)

const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const ARC_TESTNET_EURC = "0x89b50855aa3be2f677cd6303cec089b5f319d72a";
const EXPLORER = "explorer.testnet.arc.io";

type Move = { days: number; incoming: boolean; amount: string };

function blockscoutTxList(owner: string, rows: Move[], persona: string) {
  write(`blockscout/txlist/${owner}.json`, {
    fixture: meta("blockscout", `GET https://${EXPLORER}/api?module=account&action=txlist&address=${owner}`, "Blockscout Etherscan-style txlist response (checked against explorer.testnet.arc.io/api)", persona, "The fixture transport applies sort and offset."),
    status: 200,
    headers: {},
    body: {
      message: rows.length ? "OK" : "No transactions found",
      result: rows.map((r, i) => ({
        blockHash: hash(`${persona}:txblock:${i}`),
        blockNumber: String(8_000_000 + i * 1_000),
        confirmations: "1200",
        contractAddress: "",
        cumulativeGasUsed: "21000",
        from: r.incoming ? addr("5e", i + 1) : owner,
        gas: "21000",
        gasPrice: "20000000000",
        gasUsed: "21000",
        hash: hash(`${persona}:tx:${i}`),
        input: "0x",
        isError: "0",
        methodId: "0x",
        nonce: String(i),
        timeStamp: String(ago(r.days)),
        to: r.incoming ? owner : addr("5e", i + 1),
        transactionIndex: "0",
        txreceipt_status: "1",
        value: quantity(r.amount, 18).int,
      })),
      status: rows.length ? "1" : "0",
    },
  });
}

function blockscoutTokenTx(owner: string, rows: Move[], persona: string) {
  write(`blockscout/tokentx/${owner}.json`, {
    fixture: meta("blockscout", `GET https://${EXPLORER}/api?module=account&action=tokentx&address=${owner}`, "Blockscout Etherscan-style tokentx response (checked against explorer.testnet.arc.io/api)", persona, "The fixture transport applies sort and offset."),
    status: 200,
    headers: {},
    body: {
      message: rows.length ? "OK" : "No token transfers found",
      result: rows.map((r, i) => ({
        value: quantity(r.amount, 6).int,
        blockHash: hash(`${persona}:block:${i}`),
        blockNumber: String(8_000_000 + i * 1_000),
        confirmations: "1200",
        contractAddress: ARC_TESTNET_USDC,
        cumulativeGasUsed: "61234",
        from: r.incoming ? addr("5e", i + 1) : owner,
        functionName: "",
        gas: "120000",
        gasPrice: "20000000000",
        gasUsed: "61234",
        hash: hash(`${persona}:tokentx:${i}`),
        input: "0x",
        methodId: "",
        nonce: "0",
        timeStamp: String(ago(r.days, i * 17)),
        to: r.incoming ? owner : addr("5e", i + 1),
        tokenDecimal: "6",
        tokenName: "USDC",
        tokenSymbol: "USDC",
        transactionIndex: "0",
      })),
      status: rows.length ? "1" : "0",
    },
  });
}

// ------------------------------------------------------------------ RPC

const HOSTS = { eth: "ethereum-rpc.publicnode.com", base: "mainnet.base.org", arc: "rpc.mainnet.arc.io", arcTestnet: "rpc.testnet.arc.io" };
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

function rpcNonces(owner: string, nonces: { eth: number; base: number; arc: number }, persona: string) {
  write(`rpc/${owner}.json`, {
    fixture: meta("rpc", "eth_getTransactionCount on Ethereum, Base and Arc", "JSON-RPC results; the transport wraps each in {jsonrpc, id, result}", persona),
    calls: {
      [`${HOSTS.eth}:eth_getTransactionCount`]: hex(nonces.eth),
      [`${HOSTS.base}:eth_getTransactionCount`]: hex(nonces.base),
      [`${HOSTS.arc}:eth_getTransactionCount`]: hex(nonces.arc),
    },
  });
}

/** A Polaris account on Arc testnet: its USDC and EURC balances (6 decimals) and its nonce. */
function rpcAccount(owner: string, usdc: bigint, eurc: bigint, nonce: number, persona: string) {
  write(`rpc/${owner}.json`, {
    fixture: meta("rpc", "eth_call balanceOf on Arc testnet USDC and EURC; eth_getTransactionCount on Arc testnet", "JSON-RPC results; the transport wraps each in {jsonrpc, id, result}", persona),
    calls: {
      [`${HOSTS.arcTestnet}:balanceOf:${ARC_TESTNET_USDC}`]: word(usdc),
      [`${HOSTS.arcTestnet}:balanceOf:${ARC_TESTNET_EURC}`]: word(eurc),
      [`${HOSTS.arcTestnet}:eth_getTransactionCount`]: hex(nonce),
    },
  });
}

// ------------------------------------------------------------------ personas

const A = { fresh: addr("acc", 1), regular: addr("acc", 2), selfPaying: addr("acc", 3) };
const L = { strong: addr("b0b", 1), modest: addr("b0b", 2), liquidated: addr("b0b", 3), sybil: addr("b0b", 4), tainted: addr("b0b", 5), noFunder: addr("b0b", 6), infra: addr("b0b", 7), exchangeWallet: addr("b0b", 8) };
const F = { coinbase: addr("c0ba5e", 2), binance: addr("b1a4ce", 14), peer: addr("feed", 2), sybil: addr("feed", 4), tornado: addr("7c", 1), faucet: addr("feed", 7) };

// Files are overwritten, never deleted: a real recording (record.ts) of another address survives a re-run.

// Polaris accounts on Arc testnet ---------------------------------------------

// Fresh: opened three days ago with a $50 claim link. Polaris relays what it
// signs, so it has sent no transaction itself: only token transfers.
blockscoutTxList(A.fresh, [], "fresh-account");
blockscoutTokenTx(A.fresh, [
  { days: 3, incoming: true, amount: "50" },
  { days: 1, incoming: false, amount: "12.40" },
], "fresh-account");
rpcAccount(A.fresh, 37_600_000n, 0n, 0, "fresh-account");

// Regular: four months of use, 120 transfers (more than the 100-row page the
// sent count reads), and a few transactions it paid for itself.
blockscoutTokenTx(A.regular, Array.from({ length: 120 }, (_, i): Move => ({
  days: 130 - i * 1.07,
  incoming: i % 3 === 0,
  amount: i % 3 === 0 ? "120" : "18.75",
})), "regular-account");
blockscoutTxList(A.regular, [
  { days: 100, incoming: false, amount: "0" },
  { days: 60, incoming: false, amount: "0" },
  { days: 30, incoming: false, amount: "0" },
  { days: 5, incoming: false, amount: "0" },
], "regular-account");
rpcAccount(A.regular, 420_000_000n, 35_000_000n, 4, "regular-account");

// Self-paying: sends its own transactions (gas in USDC); its nonce outnumbers the transfers it signed.
blockscoutTxList(A.selfPaying, [
  { days: 45, incoming: true, amount: "25" },
  { days: 30, incoming: false, amount: "0" },
  { days: 20, incoming: false, amount: "10" },
  { days: 10, incoming: false, amount: "0" },
], "self-paying-account");
blockscoutTokenTx(A.selfPaying, [
  { days: 45, incoming: true, amount: "25" },
  { days: 20, incoming: false, amount: "10" },
  { days: 2, incoming: true, amount: "5" },
], "self-paying-account");
rpcAccount(A.selfPaying, 15_000_000n, 0n, 3, "self-paying-account");

// Linked history wallets (mainnet) --------------------------------------------

// Strong: exchange-funded 3+ years ago, active, holds dollars, trades, never liquidated.
nansenFirstFunder(L.strong, { funder: F.coinbase, name: "Coinbase: Hot Wallet 2", chain: "ethereum", days: 1210 }, "strong");
rpcNonces(L.strong, { eth: 540, base: 290, arc: 70 }, "strong");
zerionPositions(L.strong, [
  { token: T.usdcEth, amount: "3100.25" },
  { token: T.usdcBase, amount: "850" },
  { token: T.daiEth, amount: "250.000000000000000001" },
  { token: T.eth, amount: "1.84" },
  { token: T.fakeUsdc, amount: "25000", trash: true },
], "strong");
zerionTransactions(L.strong, [
  { days: 1210, op: "receive", token: T.eth, amount: "0.5", chain: "ethereum" },
  { days: 1100, op: "send", token: T.eth, amount: "0.1", chain: "ethereum" },
  { days: 800, op: "trade", token: T.usdcEth, amount: "400", chain: "ethereum", dapp: "Uniswap V3" },
  { days: 620, op: "deposit", token: T.usdcEth, amount: "1000", chain: "ethereum", dapp: "Aave V3" },
  { days: 400, op: "withdraw", token: T.usdcEth, amount: "1020", chain: "ethereum", dapp: "Aave V3" },
  { days: 210, op: "trade", token: T.usdcBase, amount: "150", chain: "base", dapp: "Aerodrome" },
  { days: 95, op: "receive", token: T.usdcBase, amount: "900", chain: "base" },
  { days: 40, op: "trade", token: T.usdcEth, amount: "75", chain: "ethereum", dapp: "Uniswap V3" },
  { days: 12, op: "send", token: T.usdcEth, amount: "60", chain: "ethereum" },
  { days: 6, op: "receive", token: T.fakeUsdc, amount: "25000", chain: "ethereum", trash: true },
], "strong", false);
nansenCurrentBalance(L.strong, [
  { token: T.usdcEth, amount: 3100.25 },
  { token: T.usdcBase, amount: 850 },
  { token: T.daiEth, amount: 250 },
  { token: T.eth, amount: 1.84 },
], "strong");
nansenTransactions(L.strong, [
  { days: 340, sourceType: "dex", token: T.usdcEth, amount: 150 },
  { days: 210, sourceType: "dex", token: T.usdcBase, amount: 150 },
  { days: 95, sourceType: "transfer", token: T.usdcBase, amount: 900 },
  { days: 40, sourceType: "dex", token: T.usdcEth, amount: 75 },
], "strong");
nansenLabels(L.strong, [{ label: "Smart Trader", category: "smart_money" }, { label: "Aave V3 User", category: "defi" }], "strong");
nansenPnl(L.strong, "strong");
nansenCounterparties(L.strong, "strong");
for (const id of [1, 42161, 137]) etherscanLogs(L.strong, id, [], "strong");

// Modest: peer-funded seven months ago on Base, a small circle of six accounts.
nansenFirstFunder(L.modest, { funder: F.peer, name: null, chain: "base", days: 200 }, "modest");
nansenRelated(F.peer, "base", [L.modest, ...Array.from({ length: 6 }, (_, i) => addr("5b", i + 1))], "modest");
rpcNonces(L.modest, { eth: 0, base: 64, arc: 11 }, "modest");
zerionPositions(L.modest, [{ token: T.usdcBase, amount: "640" }], "modest");
zerionTransactions(L.modest, [
  { days: 200, op: "receive", token: { ...T.eth, chain: "base" }, amount: "0.02", chain: "base" },
  { days: 100, op: "trade", token: T.usdcBase, amount: "80", chain: "base", dapp: "Aerodrome" },
  { days: 30, op: "send", token: T.usdcBase, amount: "20", chain: "base" },
], "modest", false);
nansenCurrentBalance(L.modest, [{ token: T.usdcBase, amount: 640 }], "modest");
for (const id of [1, 42161, 137]) etherscanLogs(L.modest, id, [], "modest");

// Liquidated twice by Aave, plus one spoofed event from a contract that is not a pool.
nansenFirstFunder(L.liquidated, { funder: F.binance, name: "Binance 14", chain: "ethereum", days: 1100 }, "liquidated");
rpcNonces(L.liquidated, { eth: 310, base: 12, arc: 0 }, "liquidated");
zerionPositions(L.liquidated, [{ token: T.usdcEth, amount: "95" }], "liquidated");
zerionTransactions(L.liquidated, [
  { days: 1100, op: "receive", token: T.eth, amount: "2", chain: "ethereum" },
  { days: 700, op: "deposit", token: T.eth, amount: "1.5", chain: "ethereum", dapp: "Aave V3" },
  { days: 300, op: "trade", token: T.usdcEth, amount: "500", chain: "ethereum", dapp: "Uniswap V3" },
], "liquidated", false);
etherscanLogs(L.liquidated, 1, [{ emitter: POOLS[1]!, days: 520 }, { emitter: addr("bad", 1), days: 30 }], "liquidated");
etherscanLogs(L.liquidated, 42161, [{ emitter: POOLS[42161]!, days: 210 }], "liquidated");
etherscanLogs(L.liquidated, 137, [], "liquidated");

// Sybil: one funder, thirty sibling accounts, funded forty days ago.
nansenFirstFunder(L.sybil, { funder: F.sybil, name: null, chain: "ethereum", days: 40 }, "sybil");
nansenRelated(F.sybil, "ethereum", [L.sybil, ...Array.from({ length: 30 }, (_, i) => addr("51b", i + 1))], "sybil");
rpcNonces(L.sybil, { eth: 3, base: 0, arc: 0 }, "sybil");
zerionPositions(L.sybil, [{ token: T.usdcEth, amount: "20" }], "sybil");
zerionTransactions(L.sybil, [{ days: 40, op: "receive", token: T.eth, amount: "0.01", chain: "ethereum" }], "sybil", false);
for (const id of [1, 42161, 137]) etherscanLogs(L.sybil, id, [], "sybil");

// Tainted: first funded through a mixer.
nansenFirstFunder(L.tainted, { funder: F.tornado, name: "Tornado Cash: Router", chain: "ethereum", days: 900 }, "tainted");
rpcNonces(L.tainted, { eth: 800, base: 0, arc: 0 }, "tainted");
zerionPositions(L.tainted, [{ token: T.usdcEth, amount: "9000" }], "tainted");
zerionTransactions(L.tainted, [{ days: 900, op: "receive", token: T.eth, amount: "10", chain: "ethereum" }, { days: 850, op: "trade", token: T.usdcEth, amount: "9000", chain: "ethereum", dapp: "Uniswap V3" }], "tainted", false);
for (const id of [1, 42161, 137]) etherscanLogs(L.tainted, id, [], "tainted");

// No first funder on record: Zerion probes date it instead.
nansenFirstFunder(L.noFunder, null, "no-funder");
rpcNonces(L.noFunder, { eth: 120, base: 30, arc: 0 }, "no-funder");
zerionPositions(L.noFunder, [{ token: T.usdcEth, amount: "310" }], "no-funder");
zerionTransactions(L.noFunder, [
  { days: 400, op: "receive", token: T.usdcEth, amount: "500", chain: "ethereum" },
  { days: 150, op: "trade", token: T.usdcEth, amount: "100", chain: "ethereum", dapp: "Uniswap V3" },
  { days: 10, op: "send", token: T.usdcEth, amount: "90", chain: "ethereum" },
], "no-funder", false);
for (const id of [1, 42161, 137]) etherscanLogs(L.noFunder, id, [], "no-funder");

// Funded by a faucet that has funded more than a page of wallets: infrastructure, not a cluster.
nansenFirstFunder(L.infra, { funder: F.faucet, name: "Community Faucet", chain: "ethereum", days: 260 }, "infra-funded");
nansenRelated(F.faucet, "ethereum", Array.from({ length: 100 }, (_, i) => addr("fa0", i + 1)), "infra-funded", false);
rpcNonces(L.infra, { eth: 90, base: 5, arc: 0 }, "infra-funded");
zerionPositions(L.infra, [{ token: T.usdcEth, amount: "180" }], "infra-funded");
zerionTransactions(L.infra, [{ days: 260, op: "receive", token: T.eth, amount: "0.05", chain: "ethereum" }, { days: 120, op: "trade", token: T.usdcEth, amount: "60", chain: "ethereum", dapp: "Uniswap V3" }], "infra-funded", false);
for (const id of [1, 42161, 137]) etherscanLogs(L.infra, id, [], "infra-funded");

// An exchange deposit address someone linked: Zerion cannot track it; Nansen still answers.
nansenFirstFunder(L.exchangeWallet, { funder: F.coinbase, name: "Coinbase: Hot Wallet 2", chain: "ethereum", days: 500 }, "exchange-wallet");
rpcNonces(L.exchangeWallet, { eth: 2, base: 0, arc: 0 }, "exchange-wallet");
zerionNotTrackable(L.exchangeWallet, "positions", "exchange-wallet");
zerionNotTrackable(L.exchangeWallet, "transactions", "exchange-wallet");
nansenCurrentBalance(L.exchangeWallet, [{ token: T.usdcEth, amount: 1250.5 }], "exchange-wallet");
nansenTransactions(L.exchangeWallet, [], "exchange-wallet");
for (const id of [1, 42161, 137]) etherscanLogs(L.exchangeWallet, id, [], "exchange-wallet");

// Manifest ---------------------------------------------------------------------

write("personas.json", {
  fixture: { label: LABEL, recorded: false, synthesizedFor: iso(REF), notes: "Addresses are synthetic. Ages are measured from each fixture's timestamps, so they grow with the real date; tests pin now to 2026-09-26T12:00:00Z." },
  accounts: [
    { persona: "fresh-account", address: A.fresh, about: "A Polaris account on Arc opened three days ago with a $50 claim link; $37.60 on hand; it has sent no transaction itself." },
    { persona: "regular-account", address: A.regular, about: "A Polaris account used for four months: 120 transfers (more than the 100-row page), 4 transactions of its own, $420 USDC and 35 EURC on hand." },
    { persona: "self-paying-account", address: A.selfPaying, about: "Pays its own gas in USDC: its nonce (3) outnumbers the transfers it signed (1)." },
  ],
  linked: [
    { persona: "strong", address: L.strong, about: "Funded from Coinbase 3+ years ago; 900 transactions; $4,200 in dollars; trading for 2 years; never liquidated." },
    { persona: "modest", address: L.modest, about: "Funded by a friend 7 months ago on Base; one of 7 accounts that friend set up; $640." },
    { persona: "liquidated", address: L.liquidated, about: "Two Aave liquidations (Ethereum, Arbitrum) and one spoofed event that must not count. Declined." },
    { persona: "sybil", address: L.sybil, about: "One of 31 accounts funded by the same address 40 days ago. Declined." },
    { persona: "tainted", address: L.tainted, about: "First funded through Tornado Cash. Not counted as history." },
    { persona: "no-funder", address: L.noFunder, about: "Nansen has no first funder; Zerion probes date it to over a year." },
    { persona: "infra-funded", address: L.infra, about: "Funded by a faucet with 100+ wallets: infrastructure, no cluster penalty." },
    { persona: "exchange-wallet", address: L.exchangeWallet, about: "Zerion says 'not trackable'; Nansen's balance is the fallback." },
  ],
});

console.log(`fixtures written to ${ROOT}`);
