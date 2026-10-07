/**
 * Which Chainlink Data Feed gives each local currency, and on which chain.
 *
 * Pure data (no viem, no network), so the browser can import it too
 * (`@polaris/fx/feeds`), for example to list the currencies that have a rate.
 *
 * Every address below was read on chain on 2026-09-27 at 22:37 UTC with public RPCs:
 * `description()` returned the pair shown, `decimals()` the decimals shown,
 * and `latestRoundData()` a positive answer updated within its heartbeat.
 * `pnpm --filter @polaris/fx check:live` repeats that check against today's
 * chain. Addresses come from Chainlink's feed directory, the JSON that
 * docs.chain.link's feed tables load:
 *
 * | Chain           | Directory file                                                              |
 * |-----------------|-----------------------------------------------------------------------------|
 * | Monad mainnet   | https://reference-data-directory.vercel.app/feeds-monad-mainnet.json        |
 * | Ethereum        | https://reference-data-directory.vercel.app/feeds-mainnet.json              |
 * | Polygon PoS     | https://reference-data-directory.vercel.app/feeds-matic-mainnet.json        |
 * | Base            | https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json |
 *
 * Order within a currency is the order the service tries them: Monad mainnet
 * first where Monad has the pair (EUR, GBP, JPY, CHF, CAD: 240 s heartbeat),
 * otherwise the feed that updates most often, then one fallback on another
 * chain carrying the same Chainlink product (same pair, same reference rate),
 * used only when the first is unreachable or stale.
 *
 * Nothing here is ever used to price or settle anything: Polaris charges and
 * pays in dollars, and these rates only print an indicative local amount.
 */

export type ChainKey = "monad" | "ethereum" | "polygon" | "base";

export interface ChainInfo {
  /** EVM chain id; the service checks the RPC answers with it before trusting a read. */
  readonly id: number;
  readonly name: string;
  /** Public, keyless JSON-RPC endpoints, tried in order. Override with `envVar` (comma-separated). */
  readonly rpcUrls: readonly string[];
  readonly envVar: string;
  /** Chainlink's feed directory for this chain (the source of the addresses). */
  readonly directory: string;
}

export const CHAINS: Readonly<Record<ChainKey, ChainInfo>> = {
  monad: {
    id: 143,
    name: "Monad mainnet",
    rpcUrls: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz"],
    envVar: "FX_RPC_MONAD",
    directory: "https://reference-data-directory.vercel.app/feeds-monad-mainnet.json",
  },
  ethereum: {
    id: 1,
    name: "Ethereum",
    rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com"],
    envVar: "FX_RPC_ETHEREUM",
    directory: "https://reference-data-directory.vercel.app/feeds-mainnet.json",
  },
  polygon: {
    id: 137,
    name: "Polygon PoS",
    rpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://1rpc.io/matic"],
    envVar: "FX_RPC_POLYGON",
    directory: "https://reference-data-directory.vercel.app/feeds-matic-mainnet.json",
  },
  base: {
    id: 8453,
    name: "Base",
    rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    envVar: "FX_RPC_BASE",
    directory: "https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json",
  },
};

export interface FeedSource {
  readonly chain: ChainKey;
  /** The feed's proxy (EACAggregatorProxy), checksummed. */
  readonly address: `0x${string}`;
  /**
   * Exactly what the feed's `description()` returns. "EUR / USD" is dollars
   * per euro (inverted to euros per dollar); "USD / ARS" is pesos per dollar.
   */
  readonly pair: string;
  /** `decimals()` when verified; the service still reads it on every refresh. */
  readonly decimals: number;
  /** How long the feed may go without an update, per the directory. */
  readonly heartbeatSeconds: number;
  /** The price move that forces an update, in percent, per the directory. */
  readonly deviationPercent: number;
}

export interface CurrencyFeeds {
  /** ISO 4217 code. */
  readonly currency: string;
  readonly name: string;
  /** Tried in order; see the header. */
  readonly sources: readonly FeedSource[];
  /** Anything a reader of the table should know about this currency's feeds. */
  readonly note?: string;
}

/** The date every address and figure in `FX_FEEDS` was read on chain. */
export const FEEDS_VERIFIED_ON = "2026-09-27T22:37Z";

export const FX_FEEDS: readonly CurrencyFeeds[] = [
  /* ── On Monad mainnet (240 s heartbeat, 0.15 % deviation, 18 decimals) ── */
  {
    currency: "EUR",
    name: "Euro",
    sources: [
      { chain: "monad", address: "0x00D7E359c8CE46168eFDD4D65b708fFb16c4b99a", pair: "EUR / USD", decimals: 18, heartbeatSeconds: 240, deviationPercent: 0.15 },
      { chain: "polygon", address: "0x73366Fe0AA0Ded304479862808e02506FE556a98", pair: "EUR / USD", decimals: 8, heartbeatSeconds: 27, deviationPercent: 0.01 },
    ],
  },
  {
    currency: "GBP",
    name: "Pound sterling",
    sources: [
      { chain: "monad", address: "0x1ffC8B75a16FFfbd7879F042B580F7607Dcf5C30", pair: "GBP / USD", decimals: 18, heartbeatSeconds: 240, deviationPercent: 0.15 },
      { chain: "polygon", address: "0x099a2540848573e94fb1Ca0Fa420b00acbBc845a", pair: "GBP / USD", decimals: 8, heartbeatSeconds: 27, deviationPercent: 0.01 },
    ],
  },
  {
    currency: "JPY",
    name: "Japanese yen",
    sources: [
      { chain: "monad", address: "0xF64664Ea54cE47eCC7a1816C49d1Bc6deF828927", pair: "JPY / USD", decimals: 18, heartbeatSeconds: 240, deviationPercent: 0.15 },
      { chain: "ethereum", address: "0xBcE206caE7f0ec07b545EddE332A47C2F75bbeb3", pair: "JPY / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.15 },
    ],
  },
  {
    currency: "CHF",
    name: "Swiss franc",
    sources: [
      { chain: "monad", address: "0x6DBa7f3A7B5B7c1079337104caD14D19150F6B8d", pair: "CHF / USD", decimals: 18, heartbeatSeconds: 240, deviationPercent: 0.15 },
      { chain: "polygon", address: "0xc76f762CedF0F78a439727861628E0fdfE1e70c2", pair: "CHF / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.1 },
    ],
  },
  {
    currency: "CAD",
    name: "Canadian dollar",
    sources: [
      { chain: "monad", address: "0x3293eA5650E9f8c4091642b7EB1C46CFEe5197cA", pair: "CAD / USD", decimals: 18, heartbeatSeconds: 240, deviationPercent: 0.15 },
      { chain: "polygon", address: "0xACA44ABb8B04D07D883202F99FA5E3c53ed57Fb5", pair: "CAD / USD", decimals: 8, heartbeatSeconds: 27, deviationPercent: 0.01 },
    ],
  },

  /* ── Not on Monad: Ethereum, Polygon and Base ── */
  {
    currency: "ARS",
    name: "Argentine peso",
    sources: [
      { chain: "ethereum", address: "0xBb65fa58BDb7d33e4a3D1A40a7A9BD99E746367b", pair: "USD / ARS", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.5 },
      { chain: "base", address: "0x9eb8a54d0590798880C665C7A6d51B95f4078Ad7", pair: "USD / ARS", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.5 },
    ],
    note:
      "Chainlink runs two different ARS rates. USD / ARS (used here, on Ethereum and Base) moves during the day: 1,612.41 on 2026-09-27. " +
      "ARS / USD on Ethereum (0xE41cD2DcC63EB63A9D9e62f2a3D9b49e6d0C0A1d) updates once a day around 04:50 UTC and read 1,524.58 pesos per dollar " +
      "(5.4% fewer) the same day. The two are never mixed, so a fallback can't jump between them.",
  },
  {
    currency: "BRL",
    name: "Brazilian real",
    sources: [
      { chain: "base", address: "0x0b0E64c05083FdF9ED7C5D3d8262c4216eFc9394", pair: "BRL / USD", decimals: 8, heartbeatSeconds: 3600, deviationPercent: 0.1 },
      { chain: "polygon", address: "0xB90DA3ff54C3ED09115abf6FbA0Ff4645586af2c", pair: "BRL / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 },
    ],
  },
  {
    currency: "MXN",
    name: "Mexican peso",
    sources: [
      { chain: "base", address: "0x9e8Ee77c76d4fa41306056D1C3196AF5da1600bd", pair: "MXN / USD", decimals: 8, heartbeatSeconds: 3600, deviationPercent: 0.1 },
      { chain: "polygon", address: "0x171b16562EA3476F5C61d1b8dad031DbA0768545", pair: "MXN / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 },
    ],
  },
  {
    currency: "COP",
    name: "Colombian peso",
    sources: [{ chain: "polygon", address: "0xfAA9147190c2C2cc5B8387B4f49016bDB3380572", pair: "COP / USD", decimals: 8, heartbeatSeconds: 3600, deviationPercent: 0.3 }],
  },
  {
    currency: "SEK",
    name: "Swedish krona",
    sources: [{ chain: "polygon", address: "0xbd92B4919ae82be8473859295dEF0e778A626302", pair: "SEK / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 }],
  },
  {
    currency: "PLN",
    name: "Polish złoty",
    sources: [{ chain: "polygon", address: "0xB34BCE11040702f71c11529D00179B2959BcE6C0", pair: "PLN / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 }],
  },
  {
    currency: "TRY",
    name: "Turkish lira",
    sources: [
      { chain: "polygon", address: "0xd78325DcA0F90F0FFe53cCeA1B02Bb12E1bf8FdB", pair: "TRY / USD", decimals: 8, heartbeatSeconds: 60, deviationPercent: 0.3 },
      { chain: "base", address: "0x29413773e7CD4Dfd6Ad89a50887877b88a6C592C", pair: "TRY / USD", decimals: 8, heartbeatSeconds: 3600, deviationPercent: 0.1 },
    ],
  },
  {
    currency: "PHP",
    name: "Philippine peso",
    sources: [
      { chain: "polygon", address: "0x218231089Bebb2A31970c3b77E96eCfb3BA006D1", pair: "PHP / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.1 },
      { chain: "ethereum", address: "0x3C7dB4D25deAb7c89660512C5494Dc9A3FC40f78", pair: "PHP / USD", decimals: 18, heartbeatSeconds: 86400, deviationPercent: 0.3 },
    ],
  },
  {
    currency: "INR",
    name: "Indian rupee",
    sources: [{ chain: "polygon", address: "0xDA0F8Df6F5dB15b346f4B8D1156722027E194E60", pair: "INR / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 1 }],
  },
  {
    currency: "IDR",
    name: "Indonesian rupiah",
    sources: [
      { chain: "base", address: "0x05A6cF213EcC5501A11a08EBefA4A8a60313ef97", pair: "IDR / USD", decimals: 8, heartbeatSeconds: 3600, deviationPercent: 0.3 },
      { chain: "ethereum", address: "0x91b99C9b75aF469a71eE1AB528e8da994A5D7030", pair: "IDR / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.5 },
    ],
    note: "IDR / USD has 8 decimals and reads about 5,580, so each step of the feed is about 0.02%: fine for an indicative amount.",
  },
  {
    currency: "THB",
    name: "Thai baht",
    sources: [{ chain: "polygon", address: "0x5164Ad28fb12a5e55946090Ec3eE1B748AFb3785", pair: "THB / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 1 }],
  },
  {
    currency: "SGD",
    name: "Singapore dollar",
    sources: [
      { chain: "polygon", address: "0x8CE3cAc0E6635ce04783709ca3CC4F5fc5304299", pair: "SGD / USD", decimals: 8, heartbeatSeconds: 60, deviationPercent: 0.1 },
      { chain: "ethereum", address: "0xe25277fF4bbF9081C75Ab0EB13B4A13a721f3E13", pair: "SGD / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.15 },
    ],
  },
  {
    currency: "KRW",
    name: "South Korean won",
    sources: [
      { chain: "ethereum", address: "0x01435677FB11763550905594A16B645847C1d0F3", pair: "KRW / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.15 },
      { chain: "polygon", address: "0x24B820870F726dA9B0D83B0B28a93885061dbF50", pair: "KRW / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 },
    ],
  },
  {
    currency: "CNY",
    name: "Chinese yuan",
    sources: [
      { chain: "ethereum", address: "0xeF8A4aF35cd47424672E3C590aBD37FBB7A7759a", pair: "CNY / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 },
      { chain: "polygon", address: "0x04bB437Aa63E098236FA47365f0268547f6EAB32", pair: "CNY / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 },
    ],
  },
  {
    currency: "NGN",
    name: "Nigerian naira",
    sources: [{ chain: "base", address: "0xdfbb5Cbc88E382de007bfe6CE99C388176ED80aD", pair: "NGN / USD", decimals: 8, heartbeatSeconds: 3600, deviationPercent: 0.5 }],
  },
  {
    currency: "ZAR",
    name: "South African rand",
    sources: [
      { chain: "base", address: "0x2ecc8A8B370fC6a217166b2782a35339bEBEe98B", pair: "ZAR / USD", decimals: 8, heartbeatSeconds: 3600, deviationPercent: 0.1 },
      { chain: "polygon", address: "0xd4a120c26d57B910C56c910CdD13EeBFA3135502", pair: "ZAR / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 3 },
    ],
  },
  {
    currency: "AUD",
    name: "Australian dollar",
    sources: [
      { chain: "polygon", address: "0x062Df9C4efd2030e243ffCc398b652e8b8F95C6f", pair: "AUD / USD", decimals: 8, heartbeatSeconds: 27, deviationPercent: 0.05 },
      { chain: "ethereum", address: "0x77F9710E7d0A19669A13c055F62cd80d313dF022", pair: "AUD / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.15 },
    ],
  },
  {
    currency: "NZD",
    name: "New Zealand dollar",
    sources: [
      { chain: "ethereum", address: "0x3977CFc9e4f29C184D4675f4EB8e0013236e5f3e", pair: "NZD / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 },
      { chain: "polygon", address: "0xa302a0B8a499fD0f00449df0a490DedE21105955", pair: "NZD / USD", decimals: 8, heartbeatSeconds: 86400, deviationPercent: 0.3 },
    ],
  },
];

/**
 * Currencies the app offers with no Chainlink feed on Monad, Ethereum,
 * Polygon or Base (checked 2026-09-27). The app shows no local amount for
 * them rather than a made-up one. AED is pegged at 3.6725, but a peg we type
 * in is not a Chainlink rate, so it is hidden too.
 */
export const NO_FEED: readonly string[] = ["CLP", "PEN", "NOK", "PKR", "VND", "MYR", "KES", "GHS", "EGP", "AED"];

/** The currencies with at least one feed, in table order. */
export const FX_CURRENCIES: readonly string[] = FX_FEEDS.map((f) => f.currency);

const BY_CURRENCY: ReadonlyMap<string, CurrencyFeeds> = new Map(FX_FEEDS.map((f) => [f.currency, f]));

/** The feeds for a currency, or undefined when there is none. */
export function feedsFor(currency: string): CurrencyFeeds | undefined {
  return BY_CURRENCY.get(currency.toUpperCase());
}

/** True when Chainlink publishes a rate for this currency (USD itself needs none). */
export function hasFxFeed(currency: string): boolean {
  return BY_CURRENCY.has(currency.toUpperCase());
}

/**
 * "EUR / USD" → the local currency is the base, so local-per-dollar is the
 * inverse of the answer. "USD / ARS" → the answer already is local per dollar.
 */
export function quotesLocalPerUsd(pair: string): boolean {
  return pair.startsWith("USD / ");
}
