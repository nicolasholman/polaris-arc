import { createHash, createHmac, randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  __setNodeCryptoForTests,
  hmacSha256Hex,
  hmacSha256HexAsync,
  hmacSha256Js,
  sha256,
  timingSafeEqualHex,
} from "../src/server/hmac.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);

afterEach(() => __setNodeCryptoForTests(undefined));

describe("pure-JS SHA-256 and HMAC", () => {
  it("matches the FIPS 180-2 test vectors", () => {
    expect(hex(sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256(new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches the RFC 4231 HMAC-SHA256 test cases", () => {
    // Test case 1
    expect(hex(hmacSha256Js(bytes("0b".repeat(20)), utf8("Hi There")))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
    // Test case 2
    expect(hex(hmacSha256Js("Jefe", "what do ya want for nothing?"))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    // Test case 6: a key longer than the block size is hashed first
    expect(hex(hmacSha256Js(bytes("aa".repeat(131)), "Test Using Larger Than Block-Size Key - Hash Key First"))).toBe(
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    );
  });

  it("agrees with node:crypto on random inputs of every length around the block boundaries", () => {
    for (let len = 0; len < 200; len++) {
      const data = randomBytes(len);
      expect(hex(sha256(data))).toBe(createHash("sha256").update(data).digest("hex"));
      const key = randomBytes((len * 7) % 150).toString("hex");
      expect(hex(hmacSha256Js(key, data))).toBe(createHmac("sha256", key).update(data).digest("hex"));
    }
  });

  it("encodes multi-byte UTF-8 the way node does", () => {
    const msg = `1790426298.${JSON.stringify({ description: "Café · 4 × $50.38 · \u{1F31F}" })}`;
    expect(hex(hmacSha256Js("whsec_ü", msg))).toBe(createHmac("sha256", "whsec_ü").update(msg).digest("hex"));
  });
});

describe("hmacSha256Hex", () => {
  it("gives the same answer on the node, pure-JS and Web Crypto paths", async () => {
    const key = "whsec_test";
    const msg = `1790426298.${JSON.stringify({ a: 1 })}`;
    const node = hmacSha256Hex(key, msg);
    expect(node).toBe(createHmac("sha256", key).update(msg).digest("hex"));
    __setNodeCryptoForTests(null);
    expect(hmacSha256Hex(key, msg)).toBe(node);
    expect(await hmacSha256HexAsync(key, msg)).toBe(node);
  });

  it("compares hex in constant time and refuses unequal lengths", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abcdef")).toBe(false);
    __setNodeCryptoForTests(null);
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
  });
});
