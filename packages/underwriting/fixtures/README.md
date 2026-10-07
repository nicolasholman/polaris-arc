# Fixtures

**Test doubles, for the tests only.** No product path reads these files: a
provider without its key is "not configured" and nothing answers in its place
(see the package README, "Missing keys"). The transport that serves them is
`@polarispay/underwriting/testing`, and
[`test/no-fixtures-in-product.test.ts`](../test/no-fixtures-in-product.test.ts)
fails if the gateway, the API, the app or the CRE workflow ever reaches them.

**Everything in this directory is synthesized, not recorded.** No Nansen,
Zerion or Etherscan key existed when the underwriting package was built, so
these files were written by
[`scripts/synthesize-fixtures.ts`](../scripts/synthesize-fixtures.ts) from the
personas in [`personas.json`](personas.json). Each body follows its provider's
documented response schema (see [`docs/research/data.md`](../../../docs/research/data.md)
§2.5, §3.3 and §4.3), and each file says so in its `fixture` block:

```json
{
  "fixture": {
    "label": "FIXTURE: synthesized in the provider's documented response shape. Not live data, not a recording.",
    "provider": "nansen",
    "request": "POST /api/v1/profiler/address/first-funder",
    "shape": "ProfilerAddressFirstFunderResponse, Nansen OpenAPI 1.0.0 (docs/research/data.md §2.5.1)",
    "persona": "strong",
    "recorded": false
  },
  "status": 200,
  "headers": { "x-nansen-credits-used": "1" },
  "body": { "pagination": { "...": "..." }, "data": [ "..." ] }
}
```

The addresses are synthetic (long runs of zeros), so no real person's wallet
is described. Answers from here carry `x-polaris-fixture: true`.

## Layout

| Path | Answers |
|---|---|
| `nansen/<endpoint>/<address>.json` | `POST /api/v1/profiler/address/<endpoint>` (`related-wallets` adds `.<chain>`) |
| `zerion/<transactions\|positions>/<address>[.testnet].json` | `GET /v1/wallets/<address>/<kind>/` (`.testnet` when `X-Env: testnet`) |
| `etherscan/logs/<borrower>.<chainId>.json` | V2 `getLogs` for `LiquidationCall` with `topic3` = borrower |
| `etherscan/tokentx/<address>.<chainId>.json` | V2 `tokentx` |
| `rpc/<address>.json` | JSON-RPC results by `<host>:<method>[:<token>]` |

The fixture transport applies the same filters the APIs do (Zerion's
`max_mined_at` probes, chain and operation filters, `page[size]` and cursors;
Nansen's date ranges, `source_type` and `per_page`; Etherscan's `sort` and
`offset`), so a file answers a probe for any "now". A request with no file is
a failure (`not_found`, "no fixture recorded"), never an empty answer.

## Personas

| Persona | Address | What it exercises |
|---|---|---|
| fresh-account | `0xacc0…0001` | Thin file: a three-day-old Polaris account, $37.60; the DON never attests it |
| regular-account | `0xacc0…0002` | 120 transfers, more than a page, so it is dated with probes |
| zerion-blind-account | `0xacc0…0003` | No Zerion record; Etherscan token transfers date it |
| strong | `0xb0b0…0001` | Coinbase-funded 3+ years ago, 900 transactions, $4,200, trading 2 years: score 692, $1,000 |
| modest | `0xb0b0…0002` | Peer-funded, one of seven accounts from that funder: −6 |
| liquidated | `0xb0b0…0003` | Two Aave liquidations plus one spoofed event that must not count: declined |
| sybil | `0xb0b0…0004` | One of 31 accounts from one funder: declined |
| tainted | `0xb0b0…0005` | First funded through Tornado Cash: not counted as history |
| no-funder | `0xb0b0…0006` | No Nansen first funder: Zerion probes date it to over a year |
| infra-funded | `0xb0b0…0007` | Faucet with 100+ wallets: infrastructure, no cluster penalty |
| exchange-wallet | `0xb0b0…0008` | Zerion "not trackable": Nansen's balance is the fallback |

## Replacing them with recordings

With keys, record a wallet whose owner agreed to publish its history:

```bash
NANSEN_API_KEY=… ZERION_API_KEY=… ETHERSCAN_API_KEY=… \
  pnpm --filter @polarispay/underwriting record --linked 0x… --persona me
```

Recorded files carry `"recorded": true`, keep only credit and rate-limit
headers, and never contain a key (Etherscan's `apikey` is redacted from the
saved URL). Re-running the synthesizer overwrites only the synthetic
personas' files.
