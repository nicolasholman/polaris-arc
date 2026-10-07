/**
 * Formatting for the buyer's screen, without `Intl` or `toLocaleString`:
 * the CRE runtime (QuickJS under Javy) may not ship locale data, and output
 * must be identical everywhere.
 */

function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** 1234 → "1,234". */
export function formatCount(n: number | bigint): string {
  const s = BigInt(n).toString();
  return s.startsWith("-") ? `-${groupThousands(s.slice(1))}` : groupThousands(s);
}

/**
 * 6-decimal base units to dollars. Whole dollars drop the cents:
 * 1_240_000_000n → "$1,240"; 50_383_562n → "$50.38". Rounds down.
 */
export function formatDollars(micros: bigint | number, opts: { cents?: boolean } = {}): string {
  const m = BigInt(micros);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / 1_000_000n;
  const cents = (abs % 1_000_000n) / 10_000n;
  const showCents = opts.cents ?? cents !== 0n;
  const body = `$${groupThousands(whole.toString())}${showCents ? `.${cents.toString().padStart(2, "0")}` : ""}`;
  return neg ? `-${body}` : body;
}

/** 730 → "2 years", 95 → "3 months", 12 → "12 days". Rounds down. */
export function formatDuration(days: number): string {
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return years === 1 ? "a year" : `${years} years`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return months === 1 ? "a month" : `${months} months`;
  }
  const d = Math.max(0, Math.floor(days));
  return d === 1 ? "a day" : `${d} days`;
}

/** "+48", "-75", "+0". */
export function formatPoints(points: number): string {
  return points < 0 ? `−${-points}` : `+${points}`;
}

/** Dollars in the buyer's words to base units: "200", "200.5", "$1,200.00". */
export function parseDollars(input: string): bigint {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new RangeError(`not a dollar amount: ${input}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}
