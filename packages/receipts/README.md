# @polaris/receipts

Receipts only the buyer can read: the keys a Face ID gives besides the wallet
key, and sealing a receipt so that only those keys open it. The design and
its sources are in [`docs/research/mera.md` §16](../../docs/research/mera.md).
The Polaris app derives the keys and opens receipts; Polaris for Business
seals them with the public key alone.

| Export | What it is |
|---|---|
| `deriveReceiptKeys(prf)` | From a passkey's 32-byte PRF output: a non-extractable AES-256-GCM key (HKDF label `polaris/v1/receipts/aes-256-gcm`) and an X25519 inbox key pair (RFC 9180 `DeriveKeyPair` of HKDF label `polaris/v1/receipts/hpke-x25519-ikm`). Deterministic; the copies it makes are zeroed |
| `forgetReceiptKeys(keys)` | Zeroes the X25519 private scalar when a session ends |
| `sealReceipt(inboxPublicKey, owner, id, body)`, `openReceipt(keys, owner, row)` | A receipt as stored: HPKE (`DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `AES-256-GCM`), `enc` and `ct` in base64url, AAD `polaris.receipt.v1\|<owner, lower case>\|<id>` |
| `sealToInbox`, `openFromInbox`, `sealForSelf`, `openForSelf`, `receiptAad` | The same at the byte level; `…ForSelf` is AES-256-GCM with a random 96-bit nonce |
| `receiptBody`, `parseReceiptBody` | What a receipt says (`ReceiptBody` v1): kind, merchant, description, line items, amount, order, the plan's schedule, the subscription's period, the receipt it refers to |
| `inboxRegistrationMessage`, `receiptsReadMessage`, `readRequestStaleness` | The EIP-191 texts the account signs to register its inbox key and to read its receipts (five minutes) |

What it relies on: `@hpke/core` 1.9.0 and `@hpke/dhkem-x25519` 1.8.0 (pure-JS
X25519, so no dependency on WebCrypto X25519 in the browser), and WebCrypto's
HKDF and AES-GCM, in browsers and Node 22.

The X25519 private key is a JavaScript object holding its 32 bytes (the
pure-JS KEM's key type), not a WebCrypto key, so "non-extractable" applies to
the AES key only; the private key is kept in memory for the session and
zeroed at its end.

Changing either label, or the suite, orphans every receipt sealed so far; a
test pins the inbox key for a fixed input.

```bash
pnpm --filter @polaris/receipts test       # determinism, label separation, round trips, AAD binding
pnpm --filter @polaris/receipts typecheck
```

It ships TypeScript source (erasable syntax only): Next.js transpiles it
(`transpilePackages`), and Node runs it directly.
