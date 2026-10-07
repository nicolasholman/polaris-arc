import "server-only";

import { encodeFunctionData, getAddress, isAddress, isHex, keccak256, pad, parseAbi, recoverTypedDataAddress, slice, toHex, type Address, type Hex } from "viem";

import { requireChain } from "./chain/client";
import { formatUnits } from "./chain/money";
import { getConfig, type ChainConfig } from "./env";
import { HttpError } from "./http";
import { carry } from "./relayer/carry";

/**
 * Circle Gateway: one USDC balance across chains, spent on Arc instantly.
 *
 * A buyer deposits USDC once into Circle's GatewayWallet on any chain Gateway
 * runs on (Base, Ethereum, Arbitrum, Avalanche… and Arc itself). To pay a
 * Polaris link they sign one EIP-712 burn intent (no gas, no chain switch):
 * "burn `value` of my Gateway balance on domain N and mint it on Arc to my
 * Polaris account". This server sends the signed intent to Circle's Gateway
 * API, which answers with an attestation in well under a second, and the
 * relayer calls `GatewayMinter.gatewayMint(attestation, signature)` on Arc,
 * paying the gas in USDC. The USDC is in the buyer's Polaris account before
 * the checkout's next step, which pays the order as any Arc payment.
 *
 * The relayer can't redirect a cent: the recipient is in the intent the
 * buyer signed, Circle's operator signs the attestation, and gatewayMint
 * mints only to the recipient it names (no destination caller is set).
 */

export type GatewaySource = { domain: number; name: string; usdc: Address };
export type GatewayNetwork = { apiUrl: string; wallet: Address; minter: Address; arcDomain: number; arcUsdc: Address; sources: GatewaySource[] };

const TESTNET_SOURCES: GatewaySource[] = [
  { domain: 6, name: "Base Sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { domain: 0, name: "Ethereum Sepolia", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { domain: 3, name: "Arbitrum Sepolia", usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  { domain: 1, name: "Avalanche Fuji", usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  { domain: 2, name: "OP Sepolia", usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  { domain: 7, name: "Polygon Amoy", usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
  { domain: 26, name: "Arc Testnet", usdc: "0x3600000000000000000000000000000000000000" },
];
const MAINNET_SOURCES: GatewaySource[] = [
  { domain: 6, name: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { domain: 0, name: "Ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { domain: 3, name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  { domain: 1, name: "Avalanche", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
  { domain: 2, name: "OP Mainnet", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  { domain: 7, name: "Polygon PoS", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  { domain: 26, name: "Arc", usdc: "0x3600000000000000000000000000000000000000" },
];

/** Gateway on this Arc network (addresses from the record's `circle` block), or null on a local node. */
export function gatewayFor(chain: Pick<ChainConfig, "circle" | "mainnet">): GatewayNetwork | null {
  const c = chain.circle;
  if (!c?.gatewayWallet || !c.gatewayMinter) return null;
  return {
    apiUrl: process.env.CIRCLE_GATEWAY_API_URL || (chain.mainnet ? "https://gateway-api.circle.com" : "https://gateway-api-testnet.circle.com"),
    wallet: getAddress(c.gatewayWallet),
    minter: getAddress(c.gatewayMinter),
    arcDomain: c.cctpDomain,
    arcUsdc: getAddress(c.usdc),
    sources: chain.mainnet ? MAINNET_SOURCES : TESTNET_SOURCES,
  };
}

/** Circle's gas fee per source domain, USDC base units (developers.circle.com/gateway/references/fees). */
const BASE_FEE: Record<number, bigint> = { 0: 1_000_000n, 6: 10_000n, 26: 3_500n, 3: 10_000n, 2: 10_000n, 1: 20_000n, 7: 10_000n };

/**
 * The most the buyer lets Gateway take for a transfer of `value` from `domain`:
 * the source's gas fee with a quarter of headroom, plus the 0.005% transfer
 * fee rounded up, plus a cent. Circle charges the actual fee, never more.
 */
export function maxFeeFor(domain: number, value: bigint): bigint {
  const base = BASE_FEE[domain] ?? 1_000_000n;
  return (base * 5n) / 4n + (value * 5n + 99_999n) / 100_000n + 10_000n;
}

export const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

export const BURN_INTENT_DOMAIN = { name: "GatewayWallet", version: "1" } as const;

const MAX_UINT256 = (1n << 256n) - 1n;
/** Per transfer, the same ceiling as every Polaris payment. */
const MAX_VALUE = 10_000_000_000n;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const b32 = (a: Address) => pad(getAddress(a), { size: 32 }).toLowerCase() as Hex;
const addr = (b: Hex) => getAddress(slice(b, 12));

export type BurnIntent = {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: bigint;
    salt: Hex;
    hookData: Hex;
  };
};

/** The burn intent that moves `value` of `depositor`'s Gateway balance on `sourceDomain` to `recipient` on Arc. Pure. */
export function buildBurnIntent(g: GatewayNetwork, input: { sourceDomain: number; depositor: Address; recipient: Address; value: bigint; salt: Hex }): BurnIntent {
  const source = g.sources.find((s) => s.domain === input.sourceDomain);
  if (!source) throw new HttpError(400, "invalid_request", `sourceDomain must be one of ${g.sources.map((s) => s.domain).join(", ")}.`, { param: "sourceDomain" });
  if (input.value <= 0n || input.value > MAX_VALUE) throw new HttpError(400, "invalid_request", "amount must be more than 0 and at most 10,000 USDC.", { param: "amount" });
  return {
    maxBlockHeight: MAX_UINT256,
    maxFee: maxFeeFor(input.sourceDomain, input.value),
    spec: {
      version: 1,
      sourceDomain: input.sourceDomain,
      destinationDomain: g.arcDomain,
      // GatewayWallet and GatewayMinter have the same address on every chain of a network.
      sourceContract: b32(g.wallet),
      destinationContract: b32(g.minter),
      sourceToken: b32(source.usdc),
      destinationToken: b32(g.arcUsdc),
      sourceDepositor: b32(input.depositor),
      destinationRecipient: b32(input.recipient),
      sourceSigner: b32(input.depositor),
      destinationCaller: ZERO32,
      value: input.value,
      salt: input.salt,
      hookData: "0x",
    },
  };
}

/** The intent as JSON (uint256 as decimal strings), the shape the Gateway API and the app's signer take. */
export function intentToJson(i: BurnIntent) {
  return { maxBlockHeight: i.maxBlockHeight.toString(), maxFee: i.maxFee.toString(), spec: { ...i.spec, value: i.spec.value.toString() } };
}

/** Read an intent back from JSON, checking every field Polaris relies on. */
export function intentFromJson(g: GatewayNetwork, raw: unknown): BurnIntent {
  const bad = (what: string): never => {
    throw new HttpError(400, "invalid_request", `burnIntent: ${what}.`, { param: "burnIntent" });
  };
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (o.spec ?? {}) as Record<string, unknown>;
  const big = (v: unknown, name: string) => {
    if (typeof v !== "string" && typeof v !== "number") return bad(`${name} must be a decimal string`);
    try {
      return BigInt(v);
    } catch {
      return bad(`${name} must be a decimal string`);
    }
  };
  const h32 = (v: unknown, name: string) => (typeof v === "string" && isHex(v) && v.length === 66 ? (v.toLowerCase() as Hex) : bad(`${name} must be bytes32`));
  const intent: BurnIntent = {
    maxBlockHeight: big(o.maxBlockHeight, "maxBlockHeight"),
    maxFee: big(o.maxFee, "maxFee"),
    spec: {
      version: Number(s.version),
      sourceDomain: Number(s.sourceDomain),
      destinationDomain: Number(s.destinationDomain),
      sourceContract: h32(s.sourceContract, "sourceContract"),
      destinationContract: h32(s.destinationContract, "destinationContract"),
      sourceToken: h32(s.sourceToken, "sourceToken"),
      destinationToken: h32(s.destinationToken, "destinationToken"),
      sourceDepositor: h32(s.sourceDepositor, "sourceDepositor"),
      destinationRecipient: h32(s.destinationRecipient, "destinationRecipient"),
      sourceSigner: h32(s.sourceSigner, "sourceSigner"),
      destinationCaller: h32(s.destinationCaller, "destinationCaller"),
      value: big(s.value, "value"),
      salt: h32(s.salt, "salt"),
      hookData: typeof s.hookData === "string" && isHex(s.hookData) ? (s.hookData as Hex) : "0x",
    },
  };
  // Only what Polaris would have built: to Arc, through Circle's minter, as Arc's USDC, minted by anyone to the named recipient.
  const expected = buildBurnIntent(g, { sourceDomain: intent.spec.sourceDomain, depositor: addr(intent.spec.sourceDepositor), recipient: addr(intent.spec.destinationRecipient), value: intent.spec.value, salt: intent.spec.salt });
  for (const k of ["version", "destinationDomain", "sourceContract", "destinationContract", "sourceToken", "destinationToken", "sourceSigner", "destinationCaller", "hookData"] as const) {
    if (String(intent.spec[k]).toLowerCase() !== String(expected.spec[k]).toLowerCase()) bad(`${k} isn't Polaris's (Arc, Circle's GatewayMinter, USDC, signer = depositor, no destination caller)`);
  }
  if (intent.maxFee > expected.maxFee) bad(`maxFee is above ${formatUnits(expected.maxFee)} USDC`);
  return intent;
}

export type GatewayBalance = { domain: number; name: string; balanceUnits: string; balance: string };

let fetchImpl: typeof fetch | null = null;
/** Tests: replace the network the Gateway API is called over. */
export function configureGatewayForTests(options: { fetch?: typeof fetch | null }): void {
  fetchImpl = options.fetch ?? null;
  minted.clear();
}

async function api(g: GatewayNetwork, path: string, body: unknown): Promise<unknown> {
  const res = await (fetchImpl ?? fetch)(`${g.apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const message = typeof json?.message === "string" ? json.message : `Circle Gateway answered ${res.status}`;
    throw new HttpError(res.status >= 500 ? 502 : 400, res.status >= 500 ? "gateway_unavailable" : "gateway_rejected", message);
  }
  return json;
}

/** A depositor's unified balance, per source chain (`GET /api/public/gateway?depositor=`). */
export async function gatewayBalances(depositorRaw: string | null): Promise<{ available: boolean; depositor: Address | null; totalUnits: string; total: string; balances: GatewayBalance[]; wallet: Address | null; minter: Address | null; sources: GatewaySource[] }> {
  const g = gatewayFor(requireChain());
  const none = { available: false, depositor: null, totalUnits: "0", total: "0.00", balances: [], wallet: null, minter: null, sources: [] };
  if (!g) return none;
  const base = { ...none, available: true, wallet: g.wallet, minter: g.minter, sources: g.sources };
  if (!depositorRaw) return base;
  if (!isAddress(depositorRaw)) throw new HttpError(400, "invalid_request", "depositor must be an address.", { param: "depositor" });
  const depositor = getAddress(depositorRaw);
  const json = (await api(g, "/v1/balances", { token: "USDC", sources: g.sources.map((s) => ({ domain: s.domain, depositor })) })) as { balances?: Array<{ domain: number; balance: string }> };
  const balances = (json.balances ?? []).map((b) => {
    // The API answers in USDC with decimals ("12.5"); keep base units for the app.
    const units = BigInt(Math.round(Number(b.balance) * 1e6));
    return { domain: b.domain, name: g.sources.find((s) => s.domain === b.domain)?.name ?? `domain ${b.domain}`, balanceUnits: units.toString(), balance: formatUnits(units) };
  });
  const total = balances.reduce((t, b) => t + BigInt(b.balanceUnits), 0n);
  return { ...base, depositor, totalUnits: total.toString(), total: formatUnits(total), balances };
}

/** `POST /api/public/gateway/intent { depositor, sourceDomain, recipient, amountUnits }`: the typed data the buyer signs. */
export function gatewayIntent(body: Record<string, unknown>) {
  const g = gatewayFor(requireChain());
  if (!g) throw new HttpError(400, "gateway_unavailable", "Circle Gateway isn't available on this network.");
  const depositor = typeof body.depositor === "string" && isAddress(body.depositor) ? getAddress(body.depositor) : null;
  const recipient = typeof body.recipient === "string" && isAddress(body.recipient) ? getAddress(body.recipient) : null;
  if (!depositor) throw new HttpError(400, "invalid_request", "depositor must be the address that deposited into Gateway.", { param: "depositor" });
  if (!recipient) throw new HttpError(400, "invalid_request", "recipient must be the Polaris account on Arc.", { param: "recipient" });
  let value: bigint;
  try {
    value = BigInt(String(body.amountUnits));
  } catch {
    throw new HttpError(400, "invalid_request", "amountUnits must be USDC base units (6 decimals).", { param: "amountUnits" });
  }
  const salt = keccak256(toHex(`${depositor}:${recipient}:${value}:${Date.now()}:${Math.random()}`));
  const intent = buildBurnIntent(g, { sourceDomain: Number(body.sourceDomain), depositor, recipient, value, salt });
  return {
    typedData: { domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent" as const, message: intentToJson(intent) },
    maxFeeUnits: intent.maxFee.toString(),
    maxFee: formatUnits(intent.maxFee),
  };
}

export type GatewayMint = { status: "minted" | "submitted"; recipient: Address; amountUnits: string; amount: string; feeUnits: string | null; transferId: string | null; mintTxHash: Hex; explorerUrl: string | null };

/** Transfers this process has minted: salt → result. The chain is the record; this only makes a retry idempotent. */
const minted = new Map<string, GatewayMint>();

const MINTER_ABI = parseAbi(["function gatewayMint(bytes attestation, bytes signature)"]);
export const gatewayMinterAbi = MINTER_ABI;

/** `POST /api/public/gateway/mint { burnIntent, signature }`: Circle attests, the relayer mints on Arc. */
export async function gatewayMint(body: Record<string, unknown>): Promise<GatewayMint> {
  const g = gatewayFor(requireChain());
  if (!g) throw new HttpError(400, "gateway_unavailable", "Circle Gateway isn't available on this network.");
  const intent = intentFromJson(g, body.burnIntent);
  const signature = typeof body.signature === "string" && isHex(body.signature) ? (body.signature as Hex) : null;
  if (!signature) throw new HttpError(400, "invalid_request", "signature must be the buyer's signature of the burn intent.", { param: "signature" });
  const seen = minted.get(intent.spec.salt);
  if (seen) return seen;
  // Check the signature here first: a bad one never reaches Circle or costs the relayer anything.
  const signer = await recoverTypedDataAddress({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: intent, signature }).catch(() => null);
  if (!signer || b32(signer) !== intent.spec.sourceSigner) throw new HttpError(400, "invalid_signature", "The burn intent isn't signed by its depositor.", { param: "signature" });

  const res = (await api(g, "/v1/transfer", [{ burnIntent: intentToJson(intent), signature }])) as { transferId?: string; attestation?: Hex; signature?: Hex; fees?: { total?: string } };
  if (!res.attestation || !res.signature) throw new HttpError(502, "gateway_unavailable", "Circle Gateway returned no attestation.");
  const result = await carry({
    kind: "gatewayMint",
    relayId: `gateway:${intent.spec.salt.slice(2, 42)}`,
    to: g.minter,
    data: encodeFunctionData({ abi: MINTER_ABI, functionName: "gatewayMint", args: [res.attestation, res.signature] }),
    signer,
    waitMs: getConfig().receiptTimeoutMs,
  });
  const out: GatewayMint = {
    status: result.status === "confirmed" ? "minted" : "submitted",
    recipient: addr(intent.spec.destinationRecipient),
    amountUnits: intent.spec.value.toString(),
    amount: formatUnits(intent.spec.value),
    feeUnits: res.fees?.total ? BigInt(Math.round(Number(res.fees.total) * 1e6)).toString() : null,
    transferId: res.transferId ?? null,
    mintTxHash: result.txHash,
    explorerUrl: result.explorerUrl,
  };
  minted.set(intent.spec.salt, out);
  return out;
}
