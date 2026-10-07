import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { describe, it } from "node:test";

import { AES_LABEL, deriveReceiptKeys, HPKE_LABEL, openReceipt, receiptBody, sealReceipt, toHex } from "@polaris/receipts";
import { privateKeyToAccount } from "viem/accounts";

import { deriveEvmKey } from "../src/lib/account/derive.ts";
import { DEV_PRF_LABEL, devReceiptKeys } from "../src/lib/account/dev-receipts.ts";
import { pairReceipts } from "../src/lib/receipts/pair.ts";

/**
 * One Face ID, several keys: the PRF output a passkey gives derives the
 * wallet key (derive.ts, frozen) and, through HKDF labels of their own, the
 * receipt keys (@polaris/receipts). They must never coincide, and adding the
 * receipt keys must not move the wallet.
 */

const prf = (fill: number) => new Uint8Array(32).fill(fill);
const hkdf = (ikm: Uint8Array, label: string) => toHex(new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0), new TextEncoder().encode(label), 32)));

describe("receipt keys beside the wallet key", () => {
  it("leave the wallet where it was: the frozen derivation gives the same address as before", () => {
    // PRF of 32 × 0x01 → BIP-39 → m/44'/60'/0'/0/0, the same as viem's mnemonicToAccount of those 24 words. Pinned so the receipts work can't have moved it.
    const key = deriveEvmKey(prf(1));
    assert.equal(privateKeyToAccount(toHex(key)).address, "0x37566338ADFbf56aa41FE8FC38aA92dB1e12aD59");
  });

  it("are independent of the wallet key: neither HKDF output is the wallet's private key, nor is the inbox key its public key", async () => {
    const material = prf(42);
    const wallet = toHex(deriveEvmKey(material));
    const keys = await deriveReceiptKeys(material);
    const aes = hkdf(material, AES_LABEL);
    const seed = hkdf(material, HPKE_LABEL);
    assert.notEqual(aes, wallet);
    assert.notEqual(seed, wallet);
    assert.notEqual(aes, seed);
    assert.notEqual(aes, toHex(material));
    const account = privateKeyToAccount(wallet);
    assert.notEqual(toHex(keys.inboxPublicKey), account.publicKey);
    assert.ok(!account.publicKey.includes(toHex(keys.inboxPublicKey).slice(2)));
  });

  it("are the same at account creation and at every later sign-in (the same PRF output)", async () => {
    const atCreate = await deriveReceiptKeys(prf(7));
    const atSignIn = await deriveReceiptKeys(prf(7));
    assert.equal(toHex(atCreate.inboxPublicKey), toHex(atSignIn.inboxPublicKey));
    const owner = privateKeyToAccount(toHex(deriveEvmKey(prf(7)))).address;
    const sealed = await sealReceipt(atCreate.inboxPublicKey, owner, "0xabc", receiptBody({ kind: "payment", merchant: "Studio Sol", amount: "200.00", at: "2026-10-01T00:00:00Z", description: "Brand identity package" }));
    assert.equal((await openReceipt(atSignIn, owner, sealed)).description, "Brand identity package");
  });
});

describe("the dev signer's receipt keys", () => {
  const devKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

  it("are deterministic from the dev key, so headless runs seal and open like Face ID", async () => {
    const a = await devReceiptKeys(devKey);
    const b = await devReceiptKeys(devKey);
    assert.ok(a && b);
    assert.equal(toHex(a.inboxPublicKey), toHex(b.inboxPublicKey));
  });

  it("go through a stand-in PRF of their own label, never the dev key itself as the PRF", async () => {
    const keys = await devReceiptKeys(devKey);
    const direct = await deriveReceiptKeys(Uint8Array.from(Buffer.from(devKey.slice(2), "hex")));
    assert.ok(keys);
    assert.notEqual(toHex(keys.inboxPublicKey), toHex(direct.inboxPublicKey));
    const standIn = new Uint8Array(hkdfSync("sha256", Buffer.from(devKey.slice(2), "hex"), new Uint8Array(0), new TextEncoder().encode(DEV_PRF_LABEL), 32));
    assert.equal(toHex(keys.inboxPublicKey), toHex((await deriveReceiptKeys(standIn)).inboxPublicKey));
  });
});

describe("pairing activity rows with sealed receipts", () => {
  const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
  const index = [
    { id: "0xpay", kind: "payment", txHash: tx(1), amountUnits: "200000000" },
    { id: "plan:1", kind: "plan", txHash: tx(2), amountUnits: "200000000" },
    { id: "instalment:1:1", kind: "instalment", txHash: tx(3), amountUnits: "50383562" },
    { id: "instalment:2:1", kind: "instalment", txHash: tx(3), amountUnits: "25000000" },
  ];

  it("pairs a payment row by its id and an instalment row by its transaction and amount", () => {
    const rows = [
      { id: "pay-0xpay", txHash: tx(1), amount: 200_000_000n },
      { id: "pay-plan:1", txHash: tx(2), amount: 200_000_000n },
      { id: "move-a", txHash: tx(3), amount: 25_000_000n },
      { id: "move-b", txHash: tx(3), amount: 50_383_562n },
      { id: "move-c", txHash: tx(9), amount: 1n },
    ];
    const paired = pairReceipts(rows, index, (r) => (r.id.startsWith("pay-") ? r.id.slice(4) : null));
    assert.deepEqual(Object.fromEntries(paired), { "pay-0xpay": "0xpay", "pay-plan:1": "plan:1", "move-a": "instalment:2:1", "move-b": "instalment:1:1" });
  });

  it("never gives a payment row another row's receipt", () => {
    const rows = [{ id: "pay-0xother", txHash: tx(1), amount: 200_000_000n }];
    const paired = pairReceipts(rows, index, (r) => r.id.slice(4));
    assert.equal(paired.size, 0);
  });
});
