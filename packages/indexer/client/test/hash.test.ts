/**
 * The client's own SHA-256 and Keccak-256 (it has no runtime dependencies):
 * SHA-256 against Node's, across the padding boundaries; Keccak-256 against
 * its published vectors and EIP-55's own checksum examples. The indexer's
 * suite (test/lib.test.ts) also checks Keccak-256 against viem's on
 * multi-block inputs.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { checksumAddress, keccak256Hex, sha256Hex } from "../src/index.js";

describe("hashes", () => {
  it("SHA-256 equals Node's, across the padding boundaries and in UTF-8", () => {
    const inputs = ["", "abc", "0xfeed:12:payment.succeeded", "héllo ✓ 日本"];
    for (const n of [55, 56, 63, 64, 65, 119, 120, 1000]) inputs.push("a".repeat(n));
    for (const m of inputs) assert.equal(sha256Hex(m), createHash("sha256").update(m).digest("hex"), `length ${m.length}`);
    assert.equal(sha256Hex(new Uint8Array([0, 255, 1])), createHash("sha256").update(Buffer.from([0, 255, 1])).digest("hex"));
  });

  it("Keccak-256 is Ethereum's (the original padding, not SHA3-256's)", () => {
    assert.equal(keccak256Hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(keccak256Hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    assert.notEqual(keccak256Hex("abc"), createHash("sha3-256").update("abc").digest("hex"));
  });

  it("checksums addresses exactly as EIP-55's examples", () => {
    for (const a of [
      "0x52908400098527886E0F7030069857D2E4169EE7",
      "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
      "0xde709f2102306220921060314715629080e2fb77",
      "0x27b1fdb04752bbc536007a920d24acb045561c26",
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ]) {
      assert.equal(checksumAddress(a.toLowerCase()), a);
      assert.equal(checksumAddress(a.toUpperCase().replace("0X", "0x")), a);
    }
    assert.throws(() => checksumAddress("0x1234"), TypeError);
  });
});
