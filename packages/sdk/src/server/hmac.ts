/**
 * HMAC-SHA256, synchronously, on every runtime.
 *
 * `webhooks.verify` is synchronous (as the plan's snippet uses it), which
 * Web Crypto can't be. So: Node's crypto when the runtime exposes it without
 * a static import (`process.getBuiltinModule`, Node 22.3+ and 20.16+), and a
 * small pure-JS SHA-256 everywhere else (older Node, edge runtimes, Bun,
 * Deno). The two are tested against each other and against RFC 4231.
 *
 * No static `import "node:crypto"`: that would break edge bundles for a
 * module whose whole job is to be imported by webhook handlers.
 */

type NodeCrypto = {
  createHmac(alg: string, key: string | Uint8Array): { update(data: string | Uint8Array): { digest(enc: "hex"): string } };
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
};

let cached: NodeCrypto | null | undefined;

function nodeCrypto(): NodeCrypto | null {
  if (cached !== undefined) return cached;
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  try {
    cached = (proc?.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined) ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

const encoder = new TextEncoder();

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

/* ── Pure-JS SHA-256 (FIPS 180-4) ─────────────────────────────────────── */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = data.length;
  const padded = new Uint8Array((((length + 9 + 63) >> 6) << 6));
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
    h[5] = h[5]! + f;
    h[6] = h[6]! + g;
    h[7] = h[7]! + hh;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!);
  return out;
}

/** HMAC-SHA256 in pure JS (RFC 2104). */
export function hmacSha256Js(key: string | Uint8Array, message: string | Uint8Array): Uint8Array {
  let k = toBytes(key);
  if (k.length > 64) k = sha256(k);
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64 + toBytes(message).length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  inner.set(toBytes(message), 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/** Hex HMAC-SHA256 of `message` under `key`, using Node's crypto when available. */
export function hmacSha256Hex(key: string, message: string | Uint8Array): string {
  const node = nodeCrypto();
  if (node) return node.createHmac("sha256", key).update(message).digest("hex");
  return toHex(hmacSha256Js(key, message));
}

/** The same, through Web Crypto (async): for runtimes where you'd rather not run JS crypto. */
export async function hmacSha256HexAsync(key: string, message: string | Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return hmacSha256Hex(key, message);
  const cryptoKey = await subtle.importKey("raw", encoder.encode(key) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await subtle.sign("HMAC", cryptoKey, toBytes(message) as BufferSource);
  return toHex(new Uint8Array(mac));
}

/** Compare two hex strings in time independent of where they differ. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  const node = nodeCrypto();
  if (node) {
    const ab = hexBytes(a);
    const bb = hexBytes(b);
    if (!ab || !bb) return false;
    return node.timingSafeEqual(ab, bb);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** @internal For tests: force the pure-JS path. */
export function __setNodeCryptoForTests(value: NodeCrypto | null | undefined): void {
  cached = value;
}
