import "server-only";

import { decodeEventLog, encodeFunctionData, getAddress, isHex, keccak256, pad, parseAbi, slice, type Address, type Hex, type Log } from "viem";

import { messageTransmitterV2Abi } from "./chain/circle";
import { publicClient, requireChain } from "./chain/client";
import { formatUnits } from "./chain/money";
import { getConfig, type ChainConfig } from "./env";
import { HttpError } from "./http";
import { carry } from "./relayer/carry";

/**
 * Pay from any chain: a buyer burns USDC on another chain with CCTP V2
 * (`TokenMessengerV2.depositForBurn`, destination domain 26 = Arc, the
 * recipient their Polaris account, no destination caller), and this server
 * finishes the transfer on Arc: it reads Circle's attestation from Iris and
 * calls `MessageTransmitterV2.receiveMessage(message, attestation)` as the
 * relayer, paying the gas in USDC. The buyer never needs anything on Arc.
 *
 * `receiveMessage` is permissionless and mints only to the recipient the
 * burn named, so the relayer can't redirect a cent; Circle's attestation is
 * the only authority. A message already received answers "minted".
 *
 * CCTP V2 hooks: a burn made with `depositForBurnWithHook` whose mint
 * recipient and destination caller are PolarisCctpHookReceiver, and whose
 * hookData is `abi.encode(merchant, orderId, orderAmount, refundTo)`, pays
 * that order on Arc in the same call: the relayer calls
 * `PolarisCctpHookReceiver.relay(message, attestation)` instead.
 */

export type CctpSource = { chainId: number; name: string; domain: number; usdc: Address; tokenMessengerV2: Address; rpcUrl: string; explorerUrl: string };

const TESTNET_TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const MAINNET_TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

/** Where a buyer can pay from, per Arc network (CCTP V2 domains, Circle's USDC on each). */
export const CCTP_SOURCES: Record<"testnet" | "mainnet", CctpSource[]> = {
  testnet: [
    { chainId: 11155111, name: "Ethereum Sepolia", domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2, rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", explorerUrl: "https://sepolia.etherscan.io" },
    { chainId: 43113, name: "Avalanche Fuji", domain: 1, usdc: "0x5425890298aed601595a70AB815c96711a31Bc65", tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2, rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc", explorerUrl: "https://testnet.snowtrace.io" },
    { chainId: 11155420, name: "OP Sepolia", domain: 2, usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2, rpcUrl: "https://sepolia.optimism.io", explorerUrl: "https://sepolia-optimism.etherscan.io" },
    { chainId: 421614, name: "Arbitrum Sepolia", domain: 3, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2, rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc", explorerUrl: "https://sepolia.arbiscan.io" },
    { chainId: 84532, name: "Base Sepolia", domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2, rpcUrl: "https://sepolia.base.org", explorerUrl: "https://sepolia.basescan.org" },
    { chainId: 80002, name: "Polygon Amoy", domain: 7, usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", tokenMessengerV2: TESTNET_TOKEN_MESSENGER_V2, rpcUrl: "https://rpc-amoy.polygon.technology", explorerUrl: "https://amoy.polygonscan.com" },
  ],
  mainnet: [
    { chainId: 1, name: "Ethereum", domain: 0, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", tokenMessengerV2: MAINNET_TOKEN_MESSENGER_V2, rpcUrl: "https://ethereum-rpc.publicnode.com", explorerUrl: "https://etherscan.io" },
    { chainId: 43114, name: "Avalanche", domain: 1, usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", tokenMessengerV2: MAINNET_TOKEN_MESSENGER_V2, rpcUrl: "https://api.avax.network/ext/bc/C/rpc", explorerUrl: "https://snowtrace.io" },
    { chainId: 10, name: "OP Mainnet", domain: 2, usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", tokenMessengerV2: MAINNET_TOKEN_MESSENGER_V2, rpcUrl: "https://mainnet.optimism.io", explorerUrl: "https://optimistic.etherscan.io" },
    { chainId: 42161, name: "Arbitrum", domain: 3, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", tokenMessengerV2: MAINNET_TOKEN_MESSENGER_V2, rpcUrl: "https://arb1.arbitrum.io/rpc", explorerUrl: "https://arbiscan.io" },
    { chainId: 8453, name: "Base", domain: 6, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenMessengerV2: MAINNET_TOKEN_MESSENGER_V2, rpcUrl: "https://mainnet.base.org", explorerUrl: "https://basescan.org" },
    { chainId: 137, name: "Polygon PoS", domain: 7, usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", tokenMessengerV2: MAINNET_TOKEN_MESSENGER_V2, rpcUrl: "https://polygon-rpc.com", explorerUrl: "https://polygonscan.com" },
  ],
};

/** The sources for this Arc network, or null on a chain without CCTP (a local node). */
export function cctpSourcesFor(chain: Pick<ChainConfig, "circle" | "mainnet">): CctpSource[] | null {
  if (!chain.circle) return null;
  return CCTP_SOURCES[chain.mainnet ? "mainnet" : "testnet"];
}

export type MintStatus = {
  status: "pending" | "minted" | "failed";
  sourceDomain: number;
  burnTxHash: Hex;
  amountUnits: string | null;
  amount: string | null;
  recipient: Address | null;
  mintTxHash: Hex | null;
  explorerUrl: string | null;
  /** A pending transfer: what Circle's attestation service says it is waiting for. */
  detail: string | null;
  error: string | null;
};

type IrisMessage = {
  message?: string;
  attestation?: string;
  status?: string;
  eventNonce?: string;
  decodedMessage?: {
    sourceDomain?: string;
    destinationDomain?: string;
    destinationCaller?: string;
    decodedMessageBody?: { mintRecipient?: string; amount?: string; burnToken?: string; feeExecuted?: string };
  } | null;
};

/** PolarisCctpHookReceiver.relay: receive the mint and pay the order the hookData names. */
export const cctpHookAbi = parseAbi(["function relay(bytes message, bytes attestation) returns (bytes32 paymentId)"]);

/** Minted transfers this process has finished: burn tx → mint tx. The chain is the record; this only saves a lookup. */
const minted = new Map<string, Hex>();

let fetchImpl: typeof fetch | null = null;
/** Tests: replace the network Iris is called over. */
export function configureCctpForTests(options: { fetch?: typeof fetch | null }): void {
  fetchImpl = options.fetch ?? null;
  minted.clear();
}

const ZERO32 = `0x${"0".repeat(64)}`;

/** A bytes32 recipient as an address (the low 20 bytes). */
function addressFromBytes32(b: string): Address | null {
  if (!isHex(b) || b.length !== 66) return null;
  return getAddress(slice(b as Hex, 12));
}

async function readIris(irisApiUrl: string, sourceDomain: number, txHash: Hex): Promise<IrisMessage | null> {
  const res = await (fetchImpl ?? fetch)(`${irisApiUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, "attestation_unavailable", `Circle's attestation service answered ${res.status}. Try again in a moment.`);
  const body = (await res.json()) as { messages?: IrisMessage[] };
  return body.messages?.[0] ?? null;
}

/**
 * Finish a CCTP V2 transfer into Arc: `POST /api/public/cctp/mint
 * { sourceDomain, txHash }`. Idempotent: poll it until `minted`.
 */
export async function mintFromBurn(body: Record<string, unknown>): Promise<MintStatus> {
  const chain = requireChain();
  const circle = chain.circle;
  const sources = cctpSourcesFor(chain);
  if (!circle || !sources) throw new HttpError(400, "cctp_unavailable", "Paying from another chain isn't available on this network.");
  const sourceDomain = Number(body.sourceDomain);
  if (!Number.isInteger(sourceDomain) || !sources.some((s) => s.domain === sourceDomain)) {
    throw new HttpError(400, "invalid_request", `sourceDomain must be one of ${sources.map((s) => s.domain).join(", ")}.`, { param: "sourceDomain" });
  }
  const txHash = typeof body.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.txHash) ? (body.txHash.toLowerCase() as Hex) : null;
  if (!txHash) throw new HttpError(400, "invalid_request", "txHash must be the burn transaction's hash.", { param: "txHash" });

  const base: MintStatus = { status: "pending", sourceDomain, burnTxHash: txHash, amountUnits: null, amount: null, recipient: null, mintTxHash: null, explorerUrl: null, detail: null, error: null };
  const known = minted.get(`${sourceDomain}:${txHash}`);

  const msg = await readIris(circle.irisApiUrl, sourceDomain, txHash);
  if (!msg) return { ...base, detail: "Circle hasn't seen the burn yet. It appears a few seconds after the transaction is final on its chain." };
  const decoded = msg.decodedMessage ?? null;
  const recipient = decoded?.decodedMessageBody?.mintRecipient ? addressFromBytes32(decoded.decodedMessageBody.mintRecipient) : null;
  const amountUnits = decoded?.decodedMessageBody?.amount ?? null;
  const view: MintStatus = { ...base, recipient, amountUnits, amount: amountUnits ? formatUnits(BigInt(amountUnits)) : null };

  if (decoded?.destinationDomain !== undefined && Number(decoded.destinationDomain) !== circle.cctpDomain) {
    return { ...view, status: "failed", error: `That transfer goes to CCTP domain ${decoded.destinationDomain}, not Arc (${circle.cctpDomain}).` };
  }
  // A hooked transfer (depositForBurnWithHook) names PolarisCctpHookReceiver as its destination caller:
  // the relayer finishes it through that contract, which pays the order the hookData names.
  const hooked = Boolean(chain.cctpHook && decoded?.destinationCaller && decoded.destinationCaller.toLowerCase() === pad(chain.cctpHook, { size: 32 }).toLowerCase());
  if (decoded?.destinationCaller && decoded.destinationCaller.toLowerCase() !== ZERO32 && !hooked) {
    return { ...view, status: "failed", error: "That transfer names its own destination caller, so only that caller can finish it on Arc." };
  }
  if (msg.status !== "complete" || !msg.attestation || !msg.message || msg.attestation === "PENDING") {
    return { ...view, detail: "Waiting for Circle's attestation: a standard transfer waits for the source chain to finalise (on Ethereum about 15 minutes), a fast one seconds." };
  }

  const message = msg.message as Hex;
  const attestation = msg.attestation as Hex;
  if (known) return { ...view, status: "minted", mintTxHash: known, explorerUrl: chain.explorerUrl ? `${chain.explorerUrl}/tx/${known}` : null };

  // V2: the nonce is bytes 12..44 of the message; usedNonces says whether it was received already.
  const nonce = slice(message, 12, 44);
  const used = (await publicClient().readContract({ address: circle.messageTransmitterV2, abi: messageTransmitterV2Abi, functionName: "usedNonces", args: [nonce] })) as bigint;
  if (used !== 0n) return { ...view, status: "minted", detail: "Already received on Arc." };

  const result = await carry({
    kind: "cctpMint",
    relayId: `cctp:${keccak256(message).slice(2, 42)}`,
    to: hooked && chain.cctpHook ? chain.cctpHook : circle.messageTransmitterV2,
    data: hooked
      ? encodeFunctionData({ abi: cctpHookAbi, functionName: "relay", args: [message, attestation] })
      : encodeFunctionData({ abi: messageTransmitterV2Abi, functionName: "receiveMessage", args: [message, attestation] }),
    signer: recipient,
    waitMs: getConfig().receiptTimeoutMs,
  });
  minted.set(`${sourceDomain}:${txHash}`, result.txHash);
  return { ...view, status: result.status === "confirmed" ? "minted" : "pending", mintTxHash: result.txHash, explorerUrl: result.explorerUrl, detail: result.status === "confirmed" ? null : "Submitted on Arc." };
}

/** Decode a MintAndWithdraw from an Arc receipt's logs (for tests and the dashboard). */
export function mintedAmountFrom(logs: readonly Log[]): { recipient: Address; amount: bigint } | null {
  for (const log of logs) {
    try {
      const ev = decodeEventLog({
        abi: [{ type: "event", name: "MintAndWithdraw", inputs: [{ name: "mintRecipient", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "mintToken", type: "address", indexed: true }, { name: "feeCollected", type: "uint256", indexed: false }] }],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const a = ev.args as { mintRecipient: Address; amount: bigint };
      return { recipient: getAddress(a.mintRecipient), amount: a.amount };
    } catch {
      // another event
    }
  }
  return null;
}
