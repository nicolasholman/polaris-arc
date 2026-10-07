import { hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AES_LABEL,
  deriveReceiptKeys,
  forgetReceiptKeys,
  fromBase64Url,
  HPKE_LABEL,
  inboxRegistrationMessage,
  openForSelf,
  openFromInbox,
  openReceipt,
  readRequestStaleness,
  receiptAad,
  receiptBody,
  receiptsReadMessage,
  sealForSelf,
  sealReceipt,
  sealToInbox,
  toBase64Url,
  toHex,
} from "../src/index.ts";

const prf = (fill: number) => new Uint8Array(32).fill(fill);
const te = new TextEncoder();
const td = new TextDecoder();
const OWNER = "0xAbCdEf0123456789aBCdef0123456789AbCdEf01";

const body = receiptBody({
  kind: "payment",
  merchant: "Studio Sol",
  description: "Brand identity package",
  lineItems: [{ name: "Logo", quantity: 1, unitAmount: "150.00" }, { name: "Guidelines", quantity: 1, unitAmount: "50.00" }],
  amount: "200.00",
  orderId: "INV-2041",
  at: "2026-10-01T12:00:00.000Z",
  txHash: `0x${"ab".repeat(32)}`,
});

/** HKDF-SHA-256 with an empty salt, from Node's own implementation: what each label must give. */
const hkdf = (ikm: Uint8Array, label: string) => new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0), te.encode(label), 32));

describe("deriveReceiptKeys", () => {
  it("is deterministic: the same PRF output gives the same inbox key on every ceremony", async () => {
    const a = await deriveReceiptKeys(prf(7));
    const b = await deriveReceiptKeys(prf(7));
    expect(toHex(a.inboxPublicKey)).toBe(toHex(b.inboxPublicKey));
    expect(a.inboxPublicKey).toHaveLength(32);
    // And the AES key of one ceremony opens what the other sealed.
    const sealed = await sealForSelf(a, receiptAad(OWNER, "note-1"), te.encode("hello"));
    expect(td.decode(await openForSelf(b, receiptAad(OWNER, "note-1"), sealed))).toBe("hello");
  });

  it("pins the inbox key for a fixed PRF output, so a changed label or suite fails here first", async () => {
    const keys = await deriveReceiptKeys(prf(1));
    expect(toHex(keys.inboxPublicKey)).toMatchInlineSnapshot(`"0xa9a13cbf03bca132855787804097e2def02d063c3d4e15047f02b70d5daf442d"`);
  });

  it("gives another account other keys", async () => {
    const a = await deriveReceiptKeys(prf(1));
    const b = await deriveReceiptKeys(prf(2));
    expect(toHex(a.inboxPublicKey)).not.toBe(toHex(b.inboxPublicKey));
  });

  it("separates the labels: the AES key and the inbox seed are HKDF outputs of their own labels, unlike each other and the PRF", async () => {
    const material = randomBytes(32);
    const keys = await deriveReceiptKeys(material);
    const aesRaw = hkdf(material, AES_LABEL);
    const seed = hkdf(material, HPKE_LABEL);
    expect(toHex(aesRaw)).not.toBe(toHex(seed));
    expect(toHex(aesRaw)).not.toBe(toHex(material));
    expect(toHex(seed)).not.toBe(toHex(material));
    // Never Mera's own vault label.
    expect([AES_LABEL, HPKE_LABEL]).not.toContain("mera.v1.encrypt.secret");

    // The session's AES key is exactly HKDF(prf, AES label): an independent raw import opens its ciphertext.
    const sealed = await sealForSelf(keys, receiptAad(OWNER, "x"), te.encode("secret"));
    const raw = await crypto.subtle.importKey("raw", aesRaw, "AES-GCM", false, ["decrypt"]);
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: receiptAad(OWNER, "x") }, raw, sealed.ct);
    expect(td.decode(opened)).toBe("secret");

    // The inbox key pair is DeriveKeyPair(HKDF(prf, HPKE label)), not DeriveKeyPair(prf) or of the AES bytes.
    const fromSeed = await deriveFromSeed(seed);
    expect(fromSeed).toBe(toHex(keys.inboxPublicKey));
    expect(await deriveFromSeed(material)).not.toBe(toHex(keys.inboxPublicKey));
    expect(await deriveFromSeed(aesRaw)).not.toBe(toHex(keys.inboxPublicKey));
  });

  it("keeps the AES key non-extractable", async () => {
    const keys = await deriveReceiptKeys(prf(3));
    expect(keys.aesKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", keys.aesKey)).rejects.toThrow();
  });

  it("leaves the caller's PRF bytes as they were (the caller zeroes them), and refuses a wrong length", async () => {
    const material = prf(9);
    await deriveReceiptKeys(material);
    expect(material.every((b) => b === 9)).toBe(true);
    await expect(deriveReceiptKeys(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  it("forgetReceiptKeys zeroes the X25519 private scalar, after which nothing opens", async () => {
    const keys = await deriveReceiptKeys(prf(4));
    const sealed = await sealReceipt(keys.inboxPublicKey, OWNER, "r1", body);
    forgetReceiptKeys(keys);
    await expect(openReceipt(keys, OWNER, sealed)).rejects.toThrow();
  });
});

async function deriveFromSeed(seed: Uint8Array): Promise<string> {
  const { suite } = await import("../src/keys.ts");
  const copy = new Uint8Array(seed);
  const pair = await suite.kem.deriveKeyPair(copy.buffer);
  return toHex(new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey)));
}

describe("sealing to the inbox", () => {
  it("round-trips: sealed with the public key alone, opened with the session's keys", async () => {
    const keys = await deriveReceiptKeys(prf(5));
    const sealed = await sealReceipt(toHex(keys.inboxPublicKey), OWNER, "0xpay", body);
    expect(sealed.owner).toBe(OWNER.toLowerCase());
    expect(fromBase64Url(sealed.enc)).toHaveLength(32);
    // The ciphertext is the plaintext plus a 16-byte tag, and the plaintext isn't in it.
    expect(fromBase64Url(sealed.ct)).toHaveLength(JSON.stringify(body).length + 16);
    expect(td.decode(fromBase64Url(sealed.ct))).not.toContain("Brand identity");
    expect(await openReceipt(keys, OWNER, sealed)).toEqual(body);
  });

  it("opens with the owner in any case (the AAD lowercases it)", async () => {
    const keys = await deriveReceiptKeys(prf(5));
    const sealed = await sealReceipt(keys.inboxPublicKey, OWNER.toLowerCase(), "id", body);
    expect(await openReceipt(keys, OWNER.toUpperCase().replace("0X", "0x"), sealed)).toEqual(body);
  });

  it("fails for another owner or another receipt id: rows can't be swapped", async () => {
    const keys = await deriveReceiptKeys(prf(6));
    const sealed = await sealReceipt(keys.inboxPublicKey, OWNER, "plan:1", body);
    await expect(openReceipt(keys, "0x0000000000000000000000000000000000000001", sealed)).rejects.toThrow();
    await expect(openReceipt(keys, OWNER, { ...sealed, id: "plan:2" })).rejects.toThrow();
    // Two of the same buyer's receipts, ciphertexts exchanged: neither opens as the other.
    const other = await sealReceipt(keys.inboxPublicKey, OWNER, "plan:2", { ...body, amount: "1.00" });
    await expect(openReceipt(keys, OWNER, { id: "plan:1", enc: other.enc, ct: other.ct })).rejects.toThrow();
    await expect(openReceipt(keys, OWNER, { id: "plan:2", enc: sealed.enc, ct: sealed.ct })).rejects.toThrow();
  });

  it("fails for another account's keys, and for a tampered ciphertext", async () => {
    const mine = await deriveReceiptKeys(prf(8));
    const theirs = await deriveReceiptKeys(prf(9));
    const sealed = await sealReceipt(mine.inboxPublicKey, OWNER, "id", body);
    await expect(openReceipt(theirs, OWNER, sealed)).rejects.toThrow();
    const ct = fromBase64Url(sealed.ct);
    ct[0] = (ct[0] ?? 0) ^ 1;
    await expect(openReceipt(mine, OWNER, { ...sealed, ct: toBase64Url(ct) })).rejects.toThrow();
  });

  it("seals each receipt freshly: the same body twice gives different ciphertexts", async () => {
    const keys = await deriveReceiptKeys(prf(10));
    const a = await sealToInbox(keys.inboxPublicKey, receiptAad(OWNER, "id"), te.encode("same"));
    const b = await sealToInbox(keys.inboxPublicKey, receiptAad(OWNER, "id"), te.encode("same"));
    expect(toHex(a.ct)).not.toBe(toHex(b.ct));
    expect(td.decode(await openFromInbox(keys, receiptAad(OWNER, "id"), a))).toBe("same");
  });

  it("AES for the device's own records binds the AAD the same way", async () => {
    const keys = await deriveReceiptKeys(prf(11));
    const sealed = await sealForSelf(keys, receiptAad(OWNER, "n1"), te.encode("note"));
    expect(sealed.iv).toHaveLength(12);
    await expect(openForSelf(keys, receiptAad(OWNER, "n2"), sealed)).rejects.toThrow();
  });

  it("refuses a public key that isn't 32 bytes", async () => {
    await expect(sealToInbox(new Uint8Array(31), receiptAad(OWNER, "id"), te.encode("x"))).rejects.toThrow(/32 bytes/);
  });
});

describe("the signed texts", () => {
  it("names the inbox key in the registration, lowercased", () => {
    expect(inboxRegistrationMessage(`0x${"AB".repeat(32)}`)).toBe(`Polaris receipts key 0x${"ab".repeat(32)}`);
  });

  it("names the account and the time in a read request, good for five minutes", () => {
    expect(receiptsReadMessage(OWNER, 1790000000)).toBe(
      ["Polaris: show me my sealed receipts.", "", `Account: ${OWNER.toLowerCase()}`, "Issued: 2026-09-21T14:13:20Z"].join("\n"),
    );
    expect(readRequestStaleness(1790000000, 1790000000 + 299)).toBeNull();
    expect(readRequestStaleness(1790000000, 1790000000 + 301)).toMatch(/older/);
    expect(readRequestStaleness(1790000000 + 120, 1790000000)).toMatch(/future/);
    expect(readRequestStaleness(Number.NaN, 1790000000)).toMatch(/unreadable/);
  });
});
