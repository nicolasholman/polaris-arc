// A line-for-line JavaScript mirror of ScoreManager.scoreFromFacts and
// ScoreManager.isThinFile.
//
// The underwriting workflow on CRE, the app's "why is my limit this" screen,
// and anyone re-deriving a decision all need the opening score without a chain
// call. Each of them copies this function, and Underwrite.test.js holds it to
// the contract across a table of facts, so a change on either side that the
// other does not make fails the suite instead of shipping a limit the app
// cannot explain.
//
// BigInt throughout, with the same integer division and the same order of
// operations as the Solidity: (walletAgeDays / 30) * 2 rounds down to whole
// months before doubling, and a mirror that doubled first would disagree on
// every odd month.

const UNDERWRITE_FLOOR = 520n;
const MIN_SCORE = 300n;
const MAX_UNDERWRITTEN_SCORE = 739n;

// The cap on each signal. The contract exposes the same numbers as public
// constants, and the suite checks the two agree.
const MAX_AGE_POINTS = 60n;
const MAX_ACTIVITY_POINTS = 50n;
const MAX_BALANCE_POINTS = 50n;
const MAX_DEFI_POINTS = 30n;
const EXCHANGE_FUNDED_POINTS = 10n;

// The least history a report must show before it opens anything
// (ScoreManager.isThinFile).
const MIN_HISTORY_DAYS = 90n;
const MIN_HISTORY_TXS = 10n;

const USD = 1_000_000n; // AUSD has 6 decimals

const min = (a, b) => (a < b ? a : b);

/**
 * @param {{
 *   walletAgeDays: number|bigint,
 *   txCount: number|bigint,
 *   stableBalance: number|bigint,   // 6-decimal base units
 *   defiTenureDays: number|bigint,
 *   priorLiquidations: number|bigint,
 *   relatedWallets: number|bigint,
 *   exchangeFunded: boolean,
 * }} f
 * @returns {{ score: number, declined: boolean }}
 */
function scoreFromFacts(f) {
  const age = min((BigInt(f.walletAgeDays) / 30n) * 2n, MAX_AGE_POINTS);
  const activity = min(BigInt(f.txCount) / 25n, MAX_ACTIVITY_POINTS);
  const balance = min(BigInt(f.stableBalance) / (100n * USD), MAX_BALANCE_POINTS);
  const defi = min(BigInt(f.defiTenureDays) / 30n, MAX_DEFI_POINTS);
  const funding = f.exchangeFunded ? EXCHANGE_FUNDED_POINTS : 0n;

  const related = BigInt(f.relatedWallets);
  const cluster = related > 3n ? min((related - 3n) * 2n, 80n) : 0n;
  const liquidations = BigInt(f.priorLiquidations);
  const penalty = liquidations * 75n + cluster;

  let raw = UNDERWRITE_FLOOR + age + activity + balance + defi + funding - penalty;
  if (raw < MIN_SCORE) raw = MIN_SCORE;
  if (raw > MAX_UNDERWRITTEN_SCORE) raw = MAX_UNDERWRITTEN_SCORE;

  return {
    score: Number(raw),
    declined: liquidations >= 2n || related >= 25n,
  };
}

/**
 * ScoreManager.isThinFile: too little history to open an unsecured line.
 * `underwrite` refuses such a report (`ThinFile`) unless the facts decline
 * the wallet outright, so the decision is "no line yet; bring a history
 * wallet or lock collateral", never the floor score.
 */
function isThinFile(f) {
  return BigInt(f.walletAgeDays) < MIN_HISTORY_DAYS || BigInt(f.txCount) < MIN_HISTORY_TXS;
}

module.exports = {
  MIN_HISTORY_DAYS,
  MIN_HISTORY_TXS,
  isThinFile,
  UNDERWRITE_FLOOR,
  MIN_SCORE,
  MAX_UNDERWRITTEN_SCORE,
  MAX_AGE_POINTS,
  MAX_ACTIVITY_POINTS,
  MAX_BALANCE_POINTS,
  MAX_DEFI_POINTS,
  EXCHANGE_FUNDED_POINTS,
  scoreFromFacts,
};
