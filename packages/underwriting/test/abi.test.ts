import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeAbiParameters, encodeAbiParameters, getAddress, parseAbiParameters } from "viem";
import {
  decodeFacts,
  decodeUnderwritingReport,
  encodeFacts,
  encodeUnderwritingReport,
  FACTS_ABI_TUPLE,
  UNDERWRITING_REPORT_ABI,
  type UnderwritingItem,
} from "../src/core/abi.ts";
import * as core from "../src/core/index.ts";
import { U16_MAX, U32_MAX, U64_MAX } from "../src/core/constants.ts";
import type { Address, Facts } from "../src/core/types.ts";

const USER = "0xacc0000000000000000000000000000000000001" as Address;
const WALLET = "0xb0b0000000000000000000000000000000000001" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The types UnderwritingReceiver._processReport decodes, written out exactly as
 * in the Solidity (`abi.decode(report, (uint8, Underwriting[]))`), not built
 * from the package's own strings, so a drift in those strings fails here.
 */
const RECEIVER_PARAMS = parseAbiParameters(
  "uint8 kind, (address user, address linkedWallet, (uint32 walletAgeDays, uint32 txCount, uint64 stableBalance, uint32 defiTenureDays, uint16 priorLiquidations, uint16 relatedWallets, bool exchangeFunded, uint64 observedAt) facts)[] items",
);

/** viem insists on a valid checksum for mixed case; ours takes any case, as the chain does. */
const viemItems = (items: UnderwritingItem[]) =>
  items.map((i) => ({ user: getAddress(i.user.toLowerCase()), linkedWallet: getAddress((i.linkedWallet ?? ZERO).toLowerCase()), facts: i.facts }));
const facts: Facts = {
  walletAgeDays: 1210,
  txCount: 902,
  stableBalance: 4_237_850_000n,
  defiTenureDays: 730,
  priorLiquidations: 0,
  relatedWallets: 0,
  exchangeFunded: true,
  observedAt: 1_790_424_000n,
};

const extremes: Facts = {
  walletAgeDays: U32_MAX,
  txCount: 0,
  stableBalance: U64_MAX,
  defiTenureDays: 1,
  priorLiquidations: U16_MAX,
  relatedWallets: U16_MAX,
  exchangeFunded: false,
  observedAt: U64_MAX,
};

describe("the report's bytes", () => {
  for (const [name, f] of [["a typical report", facts], ["every width at its limit", extremes]] as const) {
    it(`Facts encode exactly as viem encodes the Solidity tuple: ${name}`, () => {
      const viem = encodeAbiParameters(parseAbiParameters(FACTS_ABI_TUPLE), [f]);
      assert.equal(encodeFacts(f), viem);
      assert.equal((encodeFacts(f).length - 2) / 2, 256);
    });

    it(`the report is the receiver's abi.encode(uint8 2, Underwriting[]): ${name}`, () => {
      const items: UnderwritingItem[] = [{ user: USER, linkedWallet: WALLET, facts: f }];
      const viem = encodeAbiParameters(RECEIVER_PARAMS, [2, viemItems(items)]);
      const ours = encodeUnderwritingReport(items);
      assert.equal(ours, viem.toLowerCase());
      assert.equal((ours.length - 2) / 2, 96 + 320);
      const [kind, decoded] = decodeAbiParameters(RECEIVER_PARAMS, ours);
      assert.equal(kind, 2);
      assert.equal(decoded.length, 1);
      assert.equal(decoded[0]!.user.toLowerCase(), USER.toLowerCase());
      assert.equal(decoded[0]!.linkedWallet.toLowerCase(), WALLET.toLowerCase());
      assert.deepEqual({ ...decoded[0]!.facts }, f);
    });
  }

  it("the package's ABI strings are the receiver's types", () => {
    assert.deepEqual(parseAbiParameters(UNDERWRITING_REPORT_ABI), RECEIVER_PARAMS);
  });

  it("a batch, and an account scored alone (linkedWallet zero), encode as viem encodes them", () => {
    const items: UnderwritingItem[] = [
      { user: USER, linkedWallet: null, facts },
      { user: "0xacc0000000000000000000000000000000000002", linkedWallet: WALLET, facts: extremes },
      { user: "0xACC0000000000000000000000000000000000003", linkedWallet: "0xB0B0000000000000000000000000000000000002", facts },
    ];
    const ours = encodeUnderwritingReport(items);
    assert.equal(ours, encodeAbiParameters(RECEIVER_PARAMS, [2, viemItems(items)]).toLowerCase());
    assert.equal((ours.length - 2) / 2, 96 + 3 * 320);
  });

  it("round-trips through our own decoder", () => {
    assert.deepEqual(decodeFacts(encodeFacts(facts)), facts);
    const r = decodeUnderwritingReport(
      encodeUnderwritingReport([
        { user: USER, linkedWallet: WALLET, facts },
        { user: WALLET, linkedWallet: null, facts: extremes },
      ]),
    );
    assert.equal(r.kind, 2);
    assert.deepEqual(r.items, [
      { user: USER.toLowerCase(), linkedWallet: WALLET.toLowerCase(), facts },
      { user: WALLET.toLowerCase(), linkedWallet: null, facts: extremes },
    ]);
  });

  it("decodes what viem encodes, including a non-canonical offset and trailing bytes abi.decode ignores", () => {
    const items: UnderwritingItem[] = [{ user: USER, linkedWallet: WALLET, facts }];
    const viem = encodeAbiParameters(RECEIVER_PARAMS, [2, viemItems(items)]);
    assert.deepEqual(decodeUnderwritingReport(viem).items[0]!.facts, facts);
    // Offset 0x60 with a padding word before the array: still a valid encoding.
    const body = viem.slice(2);
    const shifted = `0x${body.slice(0, 64)}${(0x60).toString(16).padStart(64, "0")}${"00".repeat(32)}${body.slice(128)}${"ff".repeat(7)}` as `0x${string}`;
    assert.equal(decodeAbiParameters(RECEIVER_PARAMS, shifted)[1][0]!.facts.txCount, facts.txCount);
    assert.deepEqual(decodeUnderwritingReport(shifted).items, decodeUnderwritingReport(viem).items);
  });

  it("an empty batch decodes (the receiver accepts it) but is never encoded", () => {
    const empty = encodeAbiParameters(RECEIVER_PARAMS, [2, []]);
    assert.deepEqual(decodeUnderwritingReport(empty), { kind: 2, items: [] });
    assert.throws(() => encodeUnderwritingReport([]), /at least one/);
  });

  it("the core exports only the receiver's format: the single-item research layout is gone", () => {
    const names = Object.keys(core);
    assert.ok(names.includes("encodeUnderwritingReport") && names.includes("decodeUnderwritingReport"));
    for (const gone of ["encodeUnderwriteReport", "decodeUnderwriteReport", "UNDERWRITE_REPORT_ABI"]) {
      assert.ok(!names.includes(gone), `${gone} still exported`);
    }
    // The old 320-byte layout does not decode as a report: it would revert on chain.
    const old = encodeAbiParameters(parseAbiParameters(`uint8 kind, address user, ${FACTS_ABI_TUPLE} facts`), [2, USER, facts]);
    assert.throws(() => decodeAbiParameters(RECEIVER_PARAMS, old));
    assert.throws(() => decodeUnderwritingReport(old));
  });

  it("refuses a value that does not fit its field, instead of truncating it", () => {
    assert.throws(() => encodeFacts({ ...facts, txCount: U32_MAX + 1 }), /txCount does not fit uint32/);
    assert.throws(() => encodeFacts({ ...facts, relatedWallets: -1 }), /relatedWallets does not fit uint16/);
    assert.throws(() => encodeFacts({ ...facts, stableBalance: U64_MAX + 1n }), /stableBalance does not fit uint64/);
    assert.throws(() => encodeFacts({ ...facts, walletAgeDays: 1.5 }), /safe integer/);
    assert.throws(() => encodeUnderwritingReport([{ user: "0x1234" as Address, linkedWallet: null, facts }]), /items\[0\]\.user must be a 20-byte/);
    assert.throws(() => encodeUnderwritingReport([{ user: USER, linkedWallet: "0xnope" as Address, facts }]), /linkedWallet must be a 20-byte/);
    assert.throws(() => encodeUnderwritingReport([{ user: ZERO, linkedWallet: null, facts }]), /zero address/);
    assert.throws(
      () => encodeUnderwritingReport([{ user: USER, linkedWallet: null, facts: { ...facts, priorLiquidations: U16_MAX + 1 } }]),
      /priorLiquidations does not fit uint16/,
    );
  });

  it("decoding refuses what abi.decode would refuse", () => {
    const bad = `0x${"00".repeat(32 * 6)}${"00".repeat(31)}02${"00".repeat(32)}`;
    assert.throws(() => decodeFacts(bad as `0x${string}`), /not a bool/);
    assert.throws(() => decodeFacts("0x00" as `0x${string}`), /expected 256 bytes/);

    // Words of a one-item report: 0 kind, 1 offset, 2 length, 3 user, 4 linkedWallet, 5..12 facts.
    const good = encodeUnderwritingReport([{ user: USER, linkedWallet: WALLET, facts }]);
    const put = (i: number, value: string) =>
      `${good.slice(0, 2 + i * 64)}${value.padStart(64, "0")}${good.slice(2 + (i + 1) * 64)}` as `0x${string}`;
    assert.throws(() => decodeUnderwritingReport(put(0, "3")), /unknown report kind 3/);
    assert.throws(() => decodeUnderwritingReport(put(0, "102")), /kind does not fit uint8/);
    assert.throws(() => decodeUnderwritingReport(put(2, "2")), /truncated/);
    assert.throws(() => decodeUnderwritingReport(put(1, "ffff")), /truncated/);
    assert.throws(() => decodeUnderwritingReport(put(3, `1${"0".repeat(40)}`)), /user is not an address/);
    assert.throws(() => decodeUnderwritingReport(put(4, `1${"0".repeat(40)}`)), /linkedWallet is not an address/);
    assert.throws(() => decodeUnderwritingReport(put(11, "2")), /exchangeFunded is not a bool/);
    assert.throws(() => decodeUnderwritingReport(good.slice(0, -2) as `0x${string}`), /truncated/);
    assert.throws(() => decodeUnderwritingReport("0xabc" as `0x${string}`), /not hex/);
  });
});
