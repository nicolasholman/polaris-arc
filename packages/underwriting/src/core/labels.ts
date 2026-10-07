/**
 * Reading Nansen's labels: is a funder an exchange, and is anything tied to
 * the wallet high-risk?
 *
 * Nansen labels a funder like "Coinbase: Hot Wallet 2" or "Binance 14". The
 * exact format for exchanges is UNVERIFIED (data.md §9 item 1), so matching is
 * on the exchange's name as a whole word, case-insensitively, anywhere in the
 * label. The list is versioned with FACTS_VERSION: changing it changes which
 * facts a wallet gets, so it is a new derivation.
 */

/** Exchanges whose withdrawals count as "first topped up from a major exchange". */
export const EXCHANGES: readonly string[] = [
  "Binance",
  "Coinbase",
  "Kraken",
  "OKX",
  "Bybit",
  "Bitget",
  "KuCoin",
  "Gate.io",
  "HTX",
  "Huobi",
  "Crypto.com",
  "Gemini",
  "Bitstamp",
  "Bitfinex",
  "Upbit",
  "Bithumb",
  "MEXC",
  "Robinhood",
];

/**
 * Labels that stop a linked wallet counting as history. A buyer who links a
 * wallet first funded through a mixer or by an exploiter gets no credit for
 * it; their account is underwritten on its own instead. This is an admission
 * rule, not a score: the DON still attests only facts.
 */
// Letter boundaries, not \b: Etherscan-style labels such as "Fake_Phishing1234"
// join words with underscores and digits, which \b treats as part of the word.
const RISK_PATTERN =
  /(?<![a-z])(tornado(?:[ ._]?cash)?|mixer|mixing service|exploit(?:er)?|hack(?:er|ed)?|scam(?:mer)?|phish(?:ing|er)?|sanction(?:ed)?|ofac|drainer|rug ?pull|ransomware|darknet|lazarus)(?![a-z])/i;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXCHANGE_PATTERNS = EXCHANGES.map((name) => ({
  name,
  re: new RegExp(`(^|[^a-z0-9])${escape(name)}([^a-z0-9]|$)`, "i"),
}));

/** The exchange a label names, in its canonical spelling, or null. */
export function exchangeIn(label: string | null | undefined): string | null {
  if (!label) return null;
  for (const { name, re } of EXCHANGE_PATTERNS) if (re.test(label)) return name;
  return null;
}

/** Someone who was scammed or drained is not a risk; the label names what happened to them. */
const VICTIM_PATTERN = /\b(victim|affected|drained by|stolen from)\b/i;

/** The label, when it marks the address as high-risk; else null. */
export function riskIn(label: string | null | undefined): string | null {
  if (!label) return null;
  if (VICTIM_PATTERN.test(label)) return null;
  return RISK_PATTERN.test(label) ? label : null;
}

/** The first high-risk label among several, or null. */
export function firstRisk(labels: ReadonlyArray<string | null | undefined>): string | null {
  for (const l of labels) {
    const r = riskIn(l);
    if (r) return r;
  }
  return null;
}
