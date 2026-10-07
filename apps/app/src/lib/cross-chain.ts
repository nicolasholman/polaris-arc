import { type Address, getAddress, type Hex, parseAbi } from "viem";

/**
 * Pay from any chain: what Polaris for Business reports about the ways in
 * besides CCTP (`GET /api/public/network`), read defensively since an older
 * API has none of them, and the pure pieces of the Chainlink CCIP path.
 *
 *   gateway  Circle Gateway: one USDC balance across chains, spent on Arc in
 *            about a second (a signed intent, no source-chain gas).
 *   ccip     PolarisCCIPSender on a source chain: one transaction there pays
 *            the order on Arc (CCTP moves the dollars, CCIP carries the order).
 *            Listed only where a sender is deployed.
 *   rates    Chainlink Data Feeds on Arc mainnet, for display only.
 *
 * Pure (viem only), so the tests run it without a browser.
 */

export type GatewaySource = { domain: number; name: string; usdc: Address };

export type GatewayInfo = {
  /** GatewayWallet: the same address on every chain of the network; deposits go here. */
  wallet: Address;
  /** GatewayMinter on Arc. */
  minter: Address;
  sources: GatewaySource[];
  intentPath: string;
  mintPath: string;
  balancesPath: string;
};

export type CcipSource = {
  name: string;
  chainId: number;
  /** CCIP chain selector of the source chain (decimal string). */
  selector: string;
  router: Address;
  usdc: Address;
  tokenMessengerV2: Address;
  cctpDomain: number;
  rpcUrl: string;
  /** PolarisCCIPSender on the source chain. */
  sender: Address;
};

export type CcipInfo = {
  chainSelector: string;
  router: Address;
  receiver: Address;
  /** CCIP Explorer, without a trailing slash: a message is `${explorer}/msg/${messageId}`. */
  explorer: string;
  sources: CcipSource[];
};

export type ArcRate = { pair: string; feed: Address; price: number; updatedAt: number; stale: boolean };
export type ArcRates = { source: string; eurcUsd: ArcRate | null; eurUsd: ArcRate | null; usdcUsd: ArcRate | null };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const address = (v: unknown): Address | null => {
  if (typeof v !== "string") return null;
  try {
    return getAddress(v);
  } catch {
    return null;
  }
};
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** `network.gateway`, or null when absent, malformed, or without a single valid source. */
export function parseGateway(raw: unknown): GatewayInfo | null {
  const g = obj(raw);
  if (!g) return null;
  const wallet = address(g.wallet);
  const minter = address(g.minter);
  if (!wallet || !minter) return null;
  const sources = (Array.isArray(g.sources) ? g.sources : [])
    .map((s): GatewaySource | null => {
      const o = obj(s);
      const domain = int(o?.domain);
      const usdc = address(o?.usdc);
      return o && domain !== null && usdc ? { domain, name: text(o.name, `Domain ${domain}`), usdc } : null;
    })
    .filter((s): s is GatewaySource => s !== null);
  if (!sources.length) return null;
  return {
    wallet,
    minter,
    sources,
    intentPath: text(g.intentPath, "/api/public/gateway/intent"),
    mintPath: text(g.mintPath, "/api/public/gateway/mint"),
    balancesPath: text(g.balancesPath, "/api/public/gateway"),
  };
}

/** `network.ccip`, or null. Sources without a deployed PolarisCCIPSender are dropped (the API already does). */
export function parseCcip(raw: unknown): CcipInfo | null {
  const c = obj(raw);
  if (!c) return null;
  const router = address(c.router);
  const receiver = address(c.receiver);
  if (!router || !receiver) return null;
  const sources = (Array.isArray(c.sources) ? c.sources : [])
    .map((s): CcipSource | null => {
      const o = obj(s);
      if (!o) return null;
      const chainId = int(o.chainId);
      const cctpDomain = int(o.cctpDomain);
      const sender = address(o.sender);
      const usdc = address(o.usdc);
      const sRouter = address(o.router);
      const messenger = address(o.tokenMessengerV2);
      if (chainId === null || cctpDomain === null || !sender || !usdc || !sRouter || !messenger || typeof o.rpcUrl !== "string") return null;
      return { name: text(o.name, `Chain ${chainId}`), chainId, selector: String(o.selector ?? ""), router: sRouter, usdc, tokenMessengerV2: messenger, cctpDomain, rpcUrl: o.rpcUrl, sender };
    })
    .filter((s): s is CcipSource => s !== null);
  return {
    chainSelector: String(c.chainSelector ?? ""),
    router,
    receiver,
    explorer: text(c.explorer, "https://ccip.chain.link").replace(/\/+$/, ""),
    sources,
  };
}

function parseRate(raw: unknown): ArcRate | null {
  const r = obj(raw);
  if (!r) return null;
  const price = Number(r.price);
  const updatedAt = Date.parse(text(r.updatedAt));
  const feed = address(r.feed);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(updatedAt) || !feed) return null;
  return { pair: text(r.pair), feed, price, updatedAt, stale: r.stale === true };
}

/** `network.rates`, or null when there is no rate at all. */
export function parseRates(raw: unknown): ArcRates | null {
  const r = obj(raw);
  if (!r) return null;
  const rates = { source: text(r.source, "Chainlink Data Feeds on Arc"), eurcUsd: parseRate(r.eurcUsd), eurUsd: parseRate(r.eurUsd), usdcUsd: parseRate(r.usdcUsd) };
  return rates.eurcUsd || rates.eurUsd || rates.usdcUsd ? rates : null;
}

/** A fresh rate worth showing: present and not past its heartbeat. */
export function freshRate(rate: ArcRate | null | undefined): ArcRate | null {
  return rate && !rate.stale ? rate : null;
}

/** "$1.0842": a Chainlink price as the buyer reads it (4 decimals, the feed has 8). */
export function rateText(rate: ArcRate): string {
  return `$${rate.price.toFixed(4)}`;
}

/** What `micros` euros come to in dollars at a rate, in micros. Display only. */
export function eurosInDollars(micros: bigint, rate: ArcRate): bigint {
  return (micros * BigInt(Math.round(rate.price * 1e8))) / 100_000_000n;
}

/* ── Chainlink CCIP: PolarisCCIPSender ─────────────────────────────────── */

export const ccipSenderAbi = parseAbi([
  "function quotePay(address merchant, uint256 amount, string orderId, address arcRefundTo) view returns (uint256)",
  "function payOnArc(address merchant, uint256 amount, string orderId, address arcRefundTo) payable returns (bytes32 messageId)",
  "event PaySent(bytes32 indexed messageId, address indexed payer, address indexed merchant, string orderId, uint256 amount, uint256 ccipFee)",
]);

/** The CCIP fee sent with payOnArc: the quote plus a tenth, since the fee can move between quote and send (the sender refunds the rest). */
export function ccipFeeWithMargin(quoted: bigint): bigint {
  return (quoted * 11n) / 10n;
}

/** The order as payOnArc takes it. Pure. */
export function payOnArcCall(input: { sender: Address; merchant: Address; amount: bigint; orderId: string; arcRefundTo: Address; fee: bigint }) {
  return {
    address: input.sender,
    abi: ccipSenderAbi,
    functionName: "payOnArc" as const,
    args: [input.merchant, input.amount, input.orderId, input.arcRefundTo] as const,
    value: ccipFeeWithMargin(input.fee),
  };
}

/** Where a CCIP message is tracked. */
export function ccipMessageUrl(explorer: string, messageId: Hex): string {
  return `${explorer.replace(/\/+$/, "")}/msg/${messageId}`;
}
