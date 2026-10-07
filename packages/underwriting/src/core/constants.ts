/**
 * Numbers the contracts define, mirrored so the app can show a decision
 * before it lands on chain, plus the network and provider constants the
 * underwriting recipe needs (docs/research/data.md §7.1, plan Appendix A).
 *
 * The contract is the specification. `test/mirror.test.ts` holds these to the
 * JavaScript mirror in packages/contracts, which Hardhat holds to the deployed
 * bytecode, and `packages/contracts/test/metropolis/UnderwritingPackage.test.js`
 * holds this package to the contract directly.
 */

import type { Address, KeyedProvider } from "./types.ts";

/**
 * The environment variable (and CRE secret id) that holds each keyed
 * provider's API key. A provider without its key is not configured: it is
 * never called, and the evidence it would read is absent (facts.ts).
 */
export const PROVIDER_KEYS: Readonly<Record<KeyedProvider, string>> = {
  nansen: "NANSEN_API_KEY",
  zerion: "ZERION_API_KEY",
  etherscan: "ETHERSCAN_API_KEY",
};

/** Bumped whenever the Facts derivation rules change. See facts.ts. */
export const FACTS_VERSION = 1;
/**
 * Bumped whenever the score or decision rules change. See score.ts.
 * 2: thin files are not attested (attest.ts, ATTEST_MINIMUM).
 * 3: the thin-file gate is ScoreManager.isThinFile's, exactly (90 days and 10 transactions).
 */
export const MODEL_VERSION = 3;

/**
 * The thin-file gate (attest.ts): the DON attests facts only when they reach
 * BOTH of these, or decline. They are ScoreManager's own MIN_HISTORY_DAYS and
 * MIN_HISTORY_TXS (`isThinFile`): below either, `ScoreManager.underwrite`
 * refuses the report with ThinFile, so no report is sent and the account
 * stays secured-only.
 */
export const ATTEST_MINIMUM = {
  /** Days since the oldest sign of life across the subjects counted (ScoreManager.MIN_HISTORY_DAYS). */
  walletAgeDays: 90,
  /** Payments and transfers sent across the subjects counted (ScoreManager.MIN_HISTORY_TXS). */
  txCount: 10,
} as const;

/** ScoreManager constants. */
export const SCORE = {
  MIN: 300,
  MAX: 850,
  STARTING: 600,
  UNDERWRITE_FLOOR: 520,
  MAX_UNDERWRITTEN: 739,
  MAX_AGE_POINTS: 60,
  MAX_ACTIVITY_POINTS: 50,
  MAX_BALANCE_POINTS: 50,
  MAX_DEFI_POINTS: 30,
  EXCHANGE_FUNDED_POINTS: 10,
  LIQUIDATION_PENALTY: 75,
  /** Related wallets up to this many cost nothing. */
  CLUSTER_FREE: 3,
  CLUSTER_POINTS_PER_WALLET: 2,
  MAX_CLUSTER_PENALTY: 80,
  DECLINE_AT_LIQUIDATIONS: 2,
  DECLINE_AT_RELATED: 25,
  ON_TIME_BONUS: 12,
  LATE_PENALTY: 40,
  DEFAULT_PENALTY: 150,
  /** Seconds between two on-time bonuses. */
  BONUS_PERIOD: 7 * 86_400,
  /** How old underwriting evidence may be when it lands. */
  MAX_EVIDENCE_AGE: 15 * 60,
} as const;

/** `ScoreManager.baseLimitOf` tiers, highest first, in 6-decimal base units. */
export const TIERS: ReadonlyArray<{ minScore: number; limit: bigint }> = [
  { minScore: 800, limit: 5_000_000_000n },
  { minScore: 740, limit: 2_500_000_000n },
  { minScore: 670, limit: 1_000_000_000n },
  { minScore: 580, limit: 500_000_000n },
  { minScore: 0, limit: 200_000_000n },
];

/** The most an underwritten line opens at: the tier MAX_UNDERWRITTEN reads as. */
export const OPENING_CAP = 1_000_000_000n;

/** PolarisLoanEngine constants. */
export const LOAN = {
  INTEREST_RATE_BPS: 1000,
  YEAR_SECONDS: 365 * 86_400,
  MAX_INSTALLMENTS: 24,
  /** Pay in 4: four weekly instalments. */
  PAY_IN_4_INSTALLMENTS: 4,
  PAY_IN_4_INTERVAL: 7 * 86_400,
} as const;

/** CollateralVault default: 150% of what is locked, as extra limit. */
export const COLLATERAL_MULTIPLIER_BPS = 15_000;

/** The contract's uint widths, for saturating and for validating Facts. */
export const U16_MAX = 0xffff;
export const U32_MAX = 0xffff_ffff;
export const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** The report kind UnderwritingReceiver accepts (`REPORT_KIND`); see abi.ts. */
export const REPORT_KIND_UNDERWRITE = 2;

/** Monad networks and the dollars on them (plan Appendix A; 6 decimals, verified). */
export const MONAD_TESTNET = {
  chainId: 10143,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  zerionChainId: "monad-test-v2",
  ausd: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" as Address,
  usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address,
} as const;

export const MONAD_MAINNET = {
  chainId: 143,
  rpcUrl: "https://rpc.monad.xyz",
  zerionChainId: "monad",
  ausd: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address,
  usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address,
} as const;

/**
 * Where a linked wallet's sent-transaction count is read (data.md §6.2): one
 * `eth_getTransactionCount` per chain. Only Monad's RPC is verified; the others
 * are public endpoints and belong in config for production.
 */
export const HISTORY_CHAINS: ReadonlyArray<{ name: string; chainId: number; rpcUrl: string }> = [
  { name: "ethereum", chainId: 1, rpcUrl: "https://ethereum-rpc.publicnode.com" },
  { name: "base", chainId: 8453, rpcUrl: "https://mainnet.base.org" },
  { name: "monad", chainId: 143, rpcUrl: "https://rpc.monad.xyz" },
];

/**
 * Aave V3 `LiquidationCall(address,address,address,uint256,uint256,address,bool)`.
 * Anyone can emit this event, so only logs from these pools count (data.md §4.3).
 */
export const LIQUIDATION_CALL_TOPIC =
  "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286";

/** Aave V3 pools by chain (@bgd-labs/aave-address-book@4.44.22), on Etherscan V2's free tier. */
export const LIQUIDATION_POOLS: Readonly<Record<number, readonly Address[]>> = {
  1: ["0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"],
  42161: ["0x794a61358D6845594F94dc1DB02A252b5b4814aD"],
  137: ["0x794a61358D6845594F94dc1DB02A252b5b4814aD"],
};

/**
 * Chains Nansen's related-wallets endpoint accepts (one per call, no "all").
 * Only the values data.md §2.2 confirms; a funder first seen on any other
 * chain skips the cluster check rather than sending a value Nansen may reject.
 */
export const NANSEN_RELATED_CHAINS: ReadonlySet<string> = new Set([
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "bnb",
  "monad",
]);

/** Dollar-pegged symbols that count toward the balance. */
export const STABLE_SYMBOLS: ReadonlySet<string> = new Set([
  "AUSD",
  "USDC",
  "USDC.E",
  "USDT",
  "USDT0",
  "USD₮0",
  "DAI",
  "USDS",
  "PYUSD",
  "FDUSD",
]);

/**
 * Above this many related wallets a funder is infrastructure (a faucet, an
 * exchange's withdrawal address, a bridge), not someone running a cluster. The
 * rule is carried over from the EVM-era signals.ts, where a live test declined
 * a faucet-funded buyer for their faucet's other users.
 */
export const INFRASTRUCTURE_OUTDEGREE = 60;

/**
 * Ages the Zerion probes can prove ("some activity at least N days ago"), in
 * days. The binary search over these costs at most 3 calls whatever the
 * history length (data.md §3.3). The top edge is where the age cap bites
 * (60 points at 900 days), so probing further would earn nothing.
 */
export const PROBE_EDGES_DAYS: readonly number[] = [30, 90, 180, 365, 730, 900];

export const DAY_SECONDS = 86_400;
