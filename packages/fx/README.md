# @polaris/fx

Chainlink FX rates for the local-currency line under a dollar amount:
"≈ ARS 161,241 · Chainlink rate, 3 min ago · indicative".

Polaris charges, pays and settles in dollars only. These rates never price
anything; they print an indicative local amount for a buyer in Buenos Aires,
Manila or Lagos. They replace the hand-typed `MOCK_FX` table the customer app
used before (its ARS figure, 1,182 pesos per dollar, was 27% below Chainlink's 1,612).

| Import | Where it runs | What it is |
|---|---|---|
| `@polaris/fx` | server | Everything below, plus `createFxService()` (reads feeds with viem) and `handleFxRequest()` (the `/api/fx` route) |
| `@polaris/fx/feeds` | anywhere | The verified feed table, `hasFxFeed()`, `NO_FEED` |
| `@polaris/fx/display` | anywhere | `formatLocalAmount()`, `rateAgeText()`, `isFreshRate()`, `parseFxLookup()` |

The package ships TypeScript source (erasable syntax only): Next.js
transpiles it (`transpilePackages`), and Node runs its scripts directly.

```bash
pnpm --filter @polaris/fx test         # feed table, service (recorded answers), display
pnpm --filter @polaris/fx typecheck
pnpm --filter @polaris/fx check:live   # read every feed from today's chains
pnpm --filter @polaris/fx record       # the same, and rewrite test/fixtures/recorded-feeds.json
```

## The service

```ts
import { createFxService } from "@polaris/fx";

const fx = createFxService();           // one per server process
const r = await fx.lookup("ARS");
// { currency: "ARS", status: "ok", rate: {
//     currency: "ARS", perUsd: 1612.4065, updatedAt: 1790543663,
//     source: { chain: "ethereum", chainId: 1, address: "0xBb65…367b",
//               pair: "USD / ARS", decimals: 8, roundId: "18446744073709551862" } } }
// or { currency, status: "no-feed" | "stale" | "unavailable", rate: null }
```

For each lookup the service:

1. Finds the currency's feeds in the table. None (or USD) is `no-feed`, with
   no network call.
2. Reads the first feed: `latestRoundData()` and `decimals()`. The first time
   it uses a chain it checks `eth_chainId`; the first time it uses a feed it
   checks `description()` equals the pair in the table. A wrong chain, a wrong
   pair, a non-positive answer, `updatedAt` 0 or in the future all count as a
   failed read.
3. Normalises: `formatUnits(answer, decimals)`, inverted for "EUR / USD"
   style pairs, so `perUsd` is always local units per dollar.
4. Treats a rate older than its own feed's limit as missing (twice the
   feed's heartbeat, or its heartbeat plus 10 minutes, whichever is longer,
   and never more than **26 hours**: 14 min for Monad's 240 s feeds, 26 h for
   Ethereum's 24 h ones) and tries the next feed, a different chain carrying the
   same pair. If every feed answered but all were too old, the result is
   `stale`; if none could be read, `unavailable`.
5. Caches the result for **5 minutes** (`unavailable` for 30 s), shares one
   read between concurrent lookups, and re-checks the rate's own limit when
   it serves from cache (the rate carries it, `maxAgeSeconds`, and the app
   hides a rate that ages past it on screen).
6. Answers within **10 s** whatever the RPCs do (5 s per request): past
   the deadline the caller gets `unavailable` while the read finishes and
   fills the cache for the next one.

An app exposes it as `GET /api/fx?currency=ARS` with `handleFxRequest(service,
request)`: 400 for anything but a three-letter code, otherwise the lookup as
JSON (200 even with no rate), `Cache-Control: public, max-age=60` for a rate.
The customer app's route is `apps/app/src/app/api/fx/route.ts`.

Options (all optional): `rpcUrls`, `env` (for `FX_RPC_MONAD`,
`FX_RPC_ETHEREUM`, `FX_RPC_POLYGON`, `FX_RPC_BASE`, each a comma-separated
list of URLs), `transport` (tests replay recorded answers through it), `now`,
`cacheMs`, `errorCacheMs`, `maxAgeSeconds`, `timeoutMs`, `deadlineMs`, `feeds`,
`onSourceError` (the customer app logs every feed it had to skip).

## The feeds

Read on chain on 27 Sep 2026, 22:37 UTC, through this service
(`check:live`): every `description()` matched, every `decimals()` matched,
every feed had a fresh answer. Addresses come from Chainlink's feed directory
(the JSON that docs.chain.link's tables load; URLs in `src/feeds.ts`).
Per USD is what the feed said then.

| Currency | First feed | Fallback | Per USD |
|---|---|---|---|
| EUR | Monad mainnet `0x00D7E359c8CE46168eFDD4D65b708fFb16c4b99a` EUR / USD | Polygon `0x73366Fe0AA0Ded304479862808e02506FE556a98` | 0.8787 |
| GBP | Monad mainnet `0x1ffC8B75a16FFfbd7879F042B580F7607Dcf5C30` GBP / USD | Polygon `0x099a2540848573e94fb1Ca0Fa420b00acbBc845a` | 0.7559 |
| JPY | Monad mainnet `0xF64664Ea54cE47eCC7a1816C49d1Bc6deF828927` JPY / USD | Ethereum `0xBcE206caE7f0ec07b545EddE332A47C2F75bbeb3` | 157.67 |
| CHF | Monad mainnet `0x6DBa7f3A7B5B7c1079337104caD14D19150F6B8d` CHF / USD | Polygon `0xc76f762CedF0F78a439727861628E0fdfE1e70c2` | 0.8296 |
| CAD | Monad mainnet `0x3293eA5650E9f8c4091642b7EB1C46CFEe5197cA` CAD / USD | Polygon `0xACA44ABb8B04D07D883202F99FA5E3c53ed57Fb5` | 1.4152 |
| ARS | Ethereum `0xBb65fa58BDb7d33e4a3D1A40a7A9BD99E746367b` USD / ARS | Base `0x9eb8a54d0590798880C665C7A6d51B95f4078Ad7` | 1,612.41 |
| BRL | Base `0x0b0E64c05083FdF9ED7C5D3d8262c4216eFc9394` BRL / USD | Polygon `0xB90DA3ff54C3ED09115abf6FbA0Ff4645586af2c` | 5.1863 |
| MXN | Base `0x9e8Ee77c76d4fa41306056D1C3196AF5da1600bd` MXN / USD | Polygon `0x171b16562EA3476F5C61d1b8dad031DbA0768545` | 17.722 |
| COP | Polygon `0xfAA9147190c2C2cc5B8387B4f49016bDB3380572` COP / USD | none | 3,308.08 |
| SEK | Polygon `0xbd92B4919ae82be8473859295dEF0e778A626302` SEK / USD | none | 9.9185 |
| PLN | Polygon `0xB34BCE11040702f71c11529D00179B2959BcE6C0` PLN / USD | none | 3.8378 |
| TRY | Polygon `0xd78325DcA0F90F0FFe53cCeA1B02Bb12E1bf8FdB` TRY / USD | Base `0x29413773e7CD4Dfd6Ad89a50887877b88a6C592C` | 48.976 |
| PHP | Polygon `0x218231089Bebb2A31970c3b77E96eCfb3BA006D1` PHP / USD | Ethereum `0x3C7dB4D25deAb7c89660512C5494Dc9A3FC40f78` (18 decimals) | 62.414 |
| INR | Polygon `0xDA0F8Df6F5dB15b346f4B8D1156722027E194E60` INR / USD | none | 95.813 |
| IDR | Base `0x05A6cF213EcC5501A11a08EBefA4A8a60313ef97` IDR / USD | Ethereum `0x91b99C9b75aF469a71eE1AB528e8da994A5D7030` | 17,921 |
| THB | Polygon `0x5164Ad28fb12a5e55946090Ec3eE1B748AFb3785` THB / USD | none | 33.407 |
| SGD | Polygon `0x8CE3cAc0E6635ce04783709ca3CC4F5fc5304299` SGD / USD | Ethereum `0xe25277fF4bbF9081C75Ab0EB13B4A13a721f3E13` | 1.2785 |
| KRW | Ethereum `0x01435677FB11763550905594A16B645847C1d0F3` KRW / USD | Polygon `0x24B820870F726dA9B0D83B0B28a93885061dbF50` | 1,355.49 |
| CNY | Ethereum `0xeF8A4aF35cd47424672E3C590aBD37FBB7A7759a` CNY / USD | Polygon `0x04bB437Aa63E098236FA47365f0268547f6EAB32` | 6.7132 |
| NGN | Base `0xdfbb5Cbc88E382de007bfe6CE99C388176ED80aD` NGN / USD | none | 1,327.55 |
| ZAR | Base `0x2ecc8A8B370fC6a217166b2782a35339bEBEe98B` ZAR / USD | Polygon `0xd4a120c26d57B910C56c910CdD13EeBFA3135502` | 16.320 |
| AUD | Polygon `0x062Df9C4efd2030e243ffCc398b652e8b8F95C6f` AUD / USD | Ethereum `0x77F9710E7d0A19669A13c055F62cd80d313dF022` | 1.4260 |
| NZD | Ethereum `0x3977CFc9e4f29C184D4675f4EB8e0013236e5f3e` NZD / USD | Polygon `0xa302a0B8a499fD0f00449df0a490DedE21105955` | 1.7657 |

**No feed anywhere we looked** (Monad, Ethereum, Polygon, Base): CLP, PEN,
NOK, PKR, VND, MYR, KES, GHS, EGP and AED. The app shows no local amount for
them. AED is pegged at 3.6725, but a number we type in is not a Chainlink
rate, so it gets no line either.

## Honest limits

- **Only five currencies come from Monad.** Monad mainnet carries EUR, GBP,
  JPY, CHF and CAD against USD (240 s heartbeat). Monad testnet has no FX
  feeds at all. Everything else is read from Ethereum, Polygon or Base, which
  Polaris doesn't otherwise touch; the reads are free `eth_call`s.
- **Two different ARS rates.** Chainlink publishes USD / ARS (moves during
  the day, 1,612.41 on 27 Sep) and ARS / USD on Ethereum
  (`0xE41cD2DcC63EB63A9D9e62f2a3D9b49e6d0C0A1d`, updated once a day around
  04:50 UTC, 1,524.58 pesos per dollar the same day, 5.4% fewer). We use
  USD / ARS and never mix the two, so a fallback can't jump between them.
  Which rate a person in Argentina actually gets depends on how they sell
  their dollars; the line says "indicative" for that reason.
- **Some feeds update once a day** (24 h heartbeat, 0.3–1% deviation), so
  the line always shows the rate's age, and hides past 26 h.
- **Indicative only.** Rates come from public RPCs with no quorum of our own:
  we trust the RPC to return the chain's state, check the chain id and the
  pair, and never use the number for money.
- **Server-side, not CRE.** Nothing on chain consumes these rates, so a CRE
  workflow would add a report nobody reads (decision 16). CRE reads a feed
  where a contract acts on it: the planned guardian workflow's AUSD/USD check.
