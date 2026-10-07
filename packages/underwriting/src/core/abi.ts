/**
 * The bytes the DON signs, without a dependency.
 *
 * `Facts` is a static tuple of eight value types, so its ABI encoding is eight
 * 32-byte words, each left-padded big-endian, in declaration order:
 *
 *   word 0  uint32 walletAgeDays
 *   word 1  uint32 txCount
 *   word 2  uint64 stableBalance      (6 decimals)
 *   word 3  uint32 defiTenureDays
 *   word 4  uint16 priorLiquidations
 *   word 5  uint16 relatedWallets
 *   word 6  bool   exchangeFunded     (0 or 1)
 *   word 7  uint64 observedAt         (unix seconds)
 *
 * The underwriting report is what the deployed `UnderwritingReceiver`
 * (packages/contracts/contracts/cre/UnderwritingReceiver.sol) decodes:
 *
 *   abi.encode(uint8 kind, Underwriting[] items)      kind == 2
 *   Underwriting = (address user, address linkedWallet, Facts facts)
 *
 * `linkedWallet` is the history wallet the buyer proved they own, or zero for
 * an account scored alone; the receiver records it so one wallet can back
 * only one account. The array is dynamic, so the head is two words (the kind,
 * then the offset of the array, 0x40) and the tail is the length followed by
 * each item's ten words inline: 96 + 320·n bytes. `test/abi.test.ts` checks
 * this against viem's `encodeAbiParameters` with the receiver's types, and the
 * Hardhat suite decodes it with ethers and feeds each item to ScoreManager.
 *
 * The package once exported `encodeUnderwriteReport(user, facts)`, the
 * single-item `(uint8, address, Facts)` of the research sketch
 * (docs/research/cre.md §7.7). No deployed receiver decodes that layout and
 * it carried no linked wallet, so it is gone rather than deprecated: a report
 * in that shape would revert on chain.
 */

import { REPORT_KIND_UNDERWRITE, U16_MAX, U32_MAX, U64_MAX } from "./constants.ts";
import type { Address, Facts, Hex } from "./types.ts";

/** The Solidity tuple, for `parseAbiParameters` or `abi.decode`. */
export const FACTS_ABI_TUPLE =
  "(uint32 walletAgeDays, uint32 txCount, uint64 stableBalance, uint32 defiTenureDays, uint16 priorLiquidations, uint16 relatedWallets, bool exchangeFunded, uint64 observedAt)";

/** One report item, `UnderwritingReceiver.Underwriting`, as a Solidity tuple. */
export const UNDERWRITING_ITEM_ABI_TUPLE = `(address user, address linkedWallet, ${FACTS_ABI_TUPLE} facts)`;

/** The report's parameters, for viem's `parseAbiParameters` or ethers' `AbiCoder`. */
export const UNDERWRITING_REPORT_ABI = `uint8 kind, ${UNDERWRITING_ITEM_ABI_TUPLE}[] items`;

/** One underwriting in a report. */
export interface UnderwritingItem {
  /** The buyer's Polaris account, the address ScoreManager scores. Never zero. */
  user: Address;
  /** The history wallet the buyer proved they own, or null for the account alone. */
  linkedWallet: Address | null;
  facts: Facts;
}

/** Field order and widths, the one place both directions read from. */
const FIELDS = [
  ["walletAgeDays", "uint", 32],
  ["txCount", "uint", 32],
  ["stableBalance", "uint", 64],
  ["defiTenureDays", "uint", 32],
  ["priorLiquidations", "uint", 16],
  ["relatedWallets", "uint", 16],
  ["exchangeFunded", "bool", 8],
  ["observedAt", "uint", 64],
] as const;

const WORD = 64; // hex chars per 32-byte word

function word(value: bigint): string {
  return value.toString(16).padStart(WORD, "0");
}

function maxFor(bits: number): bigint {
  return bits === 64 ? U64_MAX : bits === 32 ? BigInt(U32_MAX) : bits === 16 ? BigInt(U16_MAX) : 0xffn;
}

/** Throws a RangeError naming the field when a value does not fit its width. */
export function validateFacts(f: Facts): void {
  for (const [name, type, bits] of FIELDS) {
    const v = f[name];
    if (type === "bool") {
      if (typeof v !== "boolean") throw new TypeError(`${name} must be a boolean`);
      continue;
    }
    if (typeof v !== "number" && typeof v !== "bigint") throw new TypeError(`${name} must be an integer`);
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new RangeError(`${name} must be a safe integer`);
    const b = BigInt(v);
    if (b < 0n || b > maxFor(bits)) throw new RangeError(`${name} does not fit uint${bits}`);
  }
}

/** `abi.encode(facts)`: 256 bytes. */
export function encodeFacts(f: Facts): Hex {
  validateFacts(f);
  let out = "0x";
  for (const [name, type] of FIELDS) {
    const v = f[name];
    out += type === "bool" ? word(v ? 1n : 0n) : word(BigInt(v as number | bigint));
  }
  return out as Hex;
}

function isAddress(a: string): a is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

function addressWord(a: string, name: string): string {
  if (!isAddress(a)) throw new TypeError(`${name} must be a 20-byte hex address`);
  return word(BigInt(a));
}

/**
 * `abi.encode(uint8(2), items)`: the report UnderwritingReceiver decodes.
 * Throws on an empty batch (the DON would sign a report that does nothing),
 * a zero or malformed user, and any Facts value that does not fit its field.
 */
export function encodeUnderwritingReport(items: readonly UnderwritingItem[]): Hex {
  if (!Array.isArray(items) || items.length === 0) throw new RangeError("a report needs at least one underwriting");
  let out = `0x${word(BigInt(REPORT_KIND_UNDERWRITE))}${word(64n)}${word(BigInt(items.length))}`;
  items.forEach((item, i) => {
    const user = addressWord(item.user, `items[${i}].user`);
    if (BigInt(item.user) === 0n) throw new TypeError(`items[${i}].user must not be the zero address`);
    const linked = addressWord(item.linkedWallet ?? ZERO_ADDRESS, `items[${i}].linkedWallet`);
    out += user + linked + encodeFacts(item.facts).slice(2);
  });
  return out as Hex;
}

function words(hex: string, count: number): bigint[] {
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) throw new TypeError("not hex");
  const body = hex.slice(2);
  if (body.length !== count * WORD) throw new RangeError(`expected ${count * 32} bytes, got ${body.length / 2}`);
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) out.push(BigInt(`0x${body.slice(i * WORD, (i + 1) * WORD)}`));
  return out;
}

function factsFromWords(w: bigint[]): Facts {
  const f: Record<string, unknown> = {};
  FIELDS.forEach(([name, type, bits], i) => {
    const v = w[i]!;
    if (type === "bool") {
      if (v > 1n) throw new RangeError(`${name} is not a bool`);
      f[name] = v === 1n;
    } else {
      if (v > maxFor(bits)) throw new RangeError(`${name} does not fit uint${bits}`);
      f[name] = bits === 64 ? v : Number(v);
    }
  });
  return f as unknown as Facts;
}

/** The inverse of `encodeFacts`, with the same width checks `abi.decode` makes. */
export function decodeFacts(hex: Hex): Facts {
  return factsFromWords(words(hex, FIELDS.length));
}

const ITEM_WORDS = FIELDS.length + 2;

function addressFrom(w: bigint, name: string): Address {
  if (w >> 160n !== 0n) throw new RangeError(`${name} is not an address`);
  return `0x${w.toString(16).padStart(40, "0")}` as Address;
}

/**
 * The inverse of `encodeUnderwritingReport`, accepting what the receiver's
 * `abi.decode(report, (uint8, Underwriting[]))` accepts and refusing what it
 * refuses: a kind or field wider than its type, an array that runs past the
 * data, and (like `UnknownReportKind`) any kind but 2. Trailing bytes after
 * the array are ignored, as abi.decode ignores them. Addresses come back
 * lowercase; a zero `linkedWallet` comes back null.
 */
export function decodeUnderwritingReport(hex: Hex): { kind: number; items: UnderwritingItem[] } {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new TypeError("not hex");
  const body = hex.slice(2);
  const size = BigInt(body.length / 2);
  const at = (byte: bigint): bigint => {
    if (byte + 32n > size) throw new RangeError(`report is truncated: needs ${byte + 32n} bytes, has ${size}`);
    const i = Number(byte) * 2;
    return BigInt(`0x${body.slice(i, i + WORD)}`);
  };

  const kindWord = at(0n);
  if (kindWord > 0xffn) throw new RangeError("kind does not fit uint8");
  const kind = Number(kindWord);
  if (kind !== REPORT_KIND_UNDERWRITE) throw new RangeError(`unknown report kind ${kind}`);

  const offset = at(32n);
  const length = at(offset);
  const first = offset + 32n;
  const itemBytes = BigInt(ITEM_WORDS * 32);
  if (first + length * itemBytes > size) throw new RangeError(`report is truncated: ${length} items need ${first + length * itemBytes} bytes, has ${size}`);

  const items: UnderwritingItem[] = [];
  for (let n = 0n; n < length; n++) {
    const base = first + n * itemBytes;
    const w: bigint[] = [];
    for (let k = 0; k < ITEM_WORDS; k++) w.push(at(base + BigInt(k * 32)));
    const linked = addressFrom(w[1]!, `items[${n}].linkedWallet`);
    items.push({
      user: addressFrom(w[0]!, `items[${n}].user`),
      linkedWallet: w[1] === 0n ? null : linked,
      facts: factsFromWords(w.slice(2)),
    });
  }
  return { kind, items };
}
