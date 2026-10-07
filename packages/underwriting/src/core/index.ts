/**
 * `@polarispay/underwriting/core`: the dependency-free, deterministic half.
 *
 * Safe to bundle into the Chainlink CRE workflow (compiled to WASM): no Node
 * APIs, no DOM, no clock, no randomness, no Intl. `tsconfig.core.json`
 * typechecks this directory with no `node` or `dom` types, so any such use
 * fails the build.
 */

export * from "./types.ts";
export * from "./constants.ts";
export { scoreBreakdown, scoreFromFacts, tierFor, limitFor, nextTierFor, type ScoreBreakdown } from "./score.ts";
export {
  FACTS_ABI_TUPLE,
  UNDERWRITING_ITEM_ABI_TUPLE,
  UNDERWRITING_REPORT_ABI,
  encodeFacts,
  encodeUnderwritingReport,
  decodeFacts,
  decodeUnderwritingReport,
  validateFacts,
  type UnderwritingItem,
} from "./abi.ts";
export { attestGaps, isAttestable } from "./attest.ts";
export { deriveFacts, type Attribution, type Derivation, type DeriveOptions, type FactField } from "./facts.ts";
export { explainFacts, declineReasonFor, merchantVoice, poweredBy, PROVIDER_NAMES, type ExplainContext, type ProviderCredit } from "./reasons.ts";
export { decide, quotePlan, planInterest, maxPrincipal, collateralFor, type DecideInput } from "./decision.ts";
export { underwrite, explainOnChainFacts, type UnderwriteInput, type UnderwriteOutcome } from "./underwrite.ts";
export { evidence, accountRules, unknownSubject, toJsonSafe } from "./evidence.ts";
export {
  accountRecipe,
  linkedRecipe,
  runSync,
  runAsync,
  all,
  NOT_CONFIGURED,
  notConfiguredReply,
  notConfiguredProviders,
  type Recipe,
  type RecipeOptions,
  type Reply,
  type Issue,
  type Collected,
} from "./recipe.ts";
export { linkMessage, linkProofStaleness, LINK_PROOF_MAX_AGE, type LinkProof } from "./link.ts";
export { exchangeIn, riskIn, firstRisk, EXCHANGES } from "./labels.ts";
export { formatDollars, formatDuration, formatCount, formatPoints, parseDollars } from "./format.ts";
export {
  ParseError,
  parseTimestamp,
  isoMinute,
  queryString,
  base64Ascii,
  largestHit,
  largestHitAsync,
  type RequestSpec,
} from "./providers/common.ts";
export * as nansen from "./providers/nansen.ts";
export * as zerion from "./providers/zerion.ts";
export * as etherscan from "./providers/etherscan.ts";
export * as rpc from "./providers/rpc.ts";
