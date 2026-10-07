import { type Address, getAddress, type Hex, pad, parseAbi } from "viem";

/**
 * Circle Gateway, the pure half: one USDC balance across chains, spent on
 * Arc in about a second.
 *
 * Deposit once on a source chain (approve the GatewayWallet, then
 * `deposit(usdc, value)`); once that chain is final the balance is
 * spendable. To spend, Polaris for Business builds a burn intent naming the
 * buyer's Polaris account on Arc as the recipient, the buyer's wallet signs
 * it (EIP-712, `eth_signTypedData_v4`, no gas and no chain switch: the
 * domain has no chainId), and the relayer mints it on Arc.
 *
 * Nothing here touches a wallet or the network, so the tests check it as is.
 */

export type BurnIntentMessage = {
  maxBlockHeight: string;
  maxFee: string;
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
    value: string;
    salt: Hex;
    hookData: Hex;
  };
};

export type TypedField = { name: string; type: string };

/** What `POST /api/public/gateway/intent` answers in `typedData`. */
export type BurnIntentTypedData = {
  domain: { name: string; version: string };
  types: Record<string, TypedField[]>;
  primaryType: "BurnIntent";
  message: BurnIntentMessage;
};

/** The domain's own type, which `eth_signTypedData_v4` wants listed (name and version only: Gateway's domain has no chainId). */
export const EIP712_DOMAIN_FIELDS: TypedField[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
];

/**
 * The JSON `eth_signTypedData_v4` takes for a burn intent: the server's typed
 * data with `EIP712Domain` added to its types.
 */
export function signTypedDataV4Payload(typedData: BurnIntentTypedData): string {
  const { EIP712Domain: _ignored, ...types } = typedData.types;
  void _ignored;
  return JSON.stringify({ domain: typedData.domain, types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ...types }, primaryType: typedData.primaryType, message: typedData.message });
}

/** The params of the `eth_signTypedData_v4` request: the signer first, then the payload. */
export function signTypedDataV4Params(signer: Address, typedData: BurnIntentTypedData): [Address, string] {
  return [signer, signTypedDataV4Payload(typedData)];
}

const b32 = (a: Address): Hex => pad(getAddress(a), { size: 32 }).toLowerCase() as Hex;

/**
 * Checks the intent the server built before the buyer signs it: the dollars
 * go to their own Polaris account, from the wallet they connected, for the
 * amount they asked, from the chain they chose, under Gateway's domain.
 * Returns why not, or null when it is what the buyer asked for.
 */
export function checkBurnIntent(
  typedData: BurnIntentTypedData,
  expected: { depositor: Address; recipient: Address; amount: bigint; sourceDomain: number; maxFee?: bigint },
): string | null {
  const m = typedData.message;
  if (typedData.primaryType !== "BurnIntent" || typedData.domain?.name !== "GatewayWallet" || typedData.domain.version !== "1") return "This isn't a Circle Gateway transfer.";
  if (!m?.spec) return "The transfer is incomplete.";
  if (m.spec.destinationRecipient.toLowerCase() !== b32(expected.recipient)) return "The transfer isn't to your Polaris account.";
  if (m.spec.sourceDepositor.toLowerCase() !== b32(expected.depositor) || m.spec.sourceSigner.toLowerCase() !== b32(expected.depositor)) return "The transfer isn't from your wallet.";
  if (m.spec.sourceDomain !== expected.sourceDomain) return "The transfer is from another chain than the one you chose.";
  let value: bigint;
  let fee: bigint;
  try {
    value = BigInt(m.spec.value);
    fee = BigInt(m.maxFee);
  } catch {
    return "The transfer's amount isn't readable.";
  }
  if (value !== expected.amount) return "The transfer is for another amount.";
  if (fee > (expected.maxFee ?? gatewayMaxFee(expected.sourceDomain, expected.amount))) return "Circle's fee in this transfer is higher than expected.";
  return null;
}

/* ── Deposit ───────────────────────────────────────────────────────────── */

export const gatewayWalletAbi = parseAbi(["function deposit(address token, uint256 value)"]);
export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

/** The two calls of a deposit on a source chain: approve the GatewayWallet, then deposit into it. Pure. */
export function gatewayDepositCalls(input: { usdc: Address; wallet: Address; amount: bigint }) {
  return {
    approve: { address: input.usdc, abi: erc20Abi, functionName: "approve" as const, args: [input.wallet, input.amount] as const },
    deposit: { address: input.wallet, abi: gatewayWalletAbi, functionName: "deposit" as const, args: [input.usdc, input.amount] as const },
  };
}

/* ── Fees ──────────────────────────────────────────────────────────────── */

/** Circle's gas fee per source domain, USDC base units (developers.circle.com/gateway/references/fees). */
export const GATEWAY_BASE_FEE: Readonly<Record<number, bigint>> = { 0: 1_000_000n, 1: 20_000n, 2: 10_000n, 3: 10_000n, 6: 10_000n, 7: 10_000n, 26: 3_500n };

/** Circle's transfer fee, 0.005% of the value, rounded up to a base unit. */
export function gatewayTransferFee(value: bigint): bigint {
  return (value * 5n + 99_999n) / 100_000n;
}

/** What Circle typically charges to move `value` from `domain`: the source's gas fee plus 0.005%. */
export function gatewayFeeHint(domain: number, value: bigint): bigint {
  return (GATEWAY_BASE_FEE[domain] ?? 1_000_000n) + gatewayTransferFee(value);
}

/**
 * The most Polaris lets Circle take (the intent's maxFee, as the server
 * builds it): the gas fee with a quarter of headroom, the transfer fee, and a
 * cent. Circle charges the actual fee, never more.
 */
export function gatewayMaxFee(domain: number, value: bigint): bigint {
  const base = GATEWAY_BASE_FEE[domain] ?? 1_000_000n;
  return (base * 5n) / 4n + gatewayTransferFee(value) + 10_000n;
}

/** Whether a balance on `domain` covers `value` and the most Circle could take. */
export function covers(balance: bigint, domain: number, value: bigint): boolean {
  return value > 0n && balance >= value + gatewayMaxFee(domain, value);
}

/**
 * The chain to spend from: of those whose balance covers `value` and its
 * fee, the cheapest. Null when none does on its own.
 */
export function pickGatewaySource(balances: { domain: number; balanceUnits: bigint }[], value: bigint): number | null {
  const ok = balances.filter((b) => covers(b.balanceUnits, b.domain, value));
  ok.sort((a, b) => Number(gatewayFeeHint(a.domain, value) - gatewayFeeHint(b.domain, value)) || Number(b.balanceUnits - a.balanceUnits));
  return ok[0]?.domain ?? null;
}

/** What to move to pay `need` from a Polaris balance of `available`: the shortfall, or all of it when the balance is unknown or already enough. */
export function topUpAmount(need: bigint, available: bigint | null | undefined): bigint {
  if (available === null || available === undefined || available >= need) return need;
  return need - available;
}

/** "$0.0035", "$1.01": USDC base units with as many decimals as a small fee needs (2 to 6). */
export function preciseUsd(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${negative ? "−" : ""}$${whole.toLocaleString("en-US")}.${frac}`;
}

/* ── Finality ──────────────────────────────────────────────────────────── */

/** How long a deposit on `domain` takes to become spendable: that chain's finality. */
export function finalityHint(domain: number): string {
  switch (domain) {
    case 0:
      return "about 15 to 20 minutes";
    case 1:
      return "a few seconds";
    case 26:
      return "under a second";
    case 7:
      return "about a minute";
    default:
      return "under a few minutes";
  }
}

/* ── Source chains a wallet deposits on ────────────────────────────────── */

export type DepositChain = { domain: number; chainId: number; name: string; usdc: Address; rpcUrl: string; explorerUrl: string; nativeSymbol: string };

type ChainHint = { chainId: number; rpcUrl: string; explorerUrl: string; nativeSymbol: string };

/** Public endpoints for Gateway's EVM source chains, for a wallet that doesn't know one yet. */
const CHAIN_HINTS: { testnet: Record<number, ChainHint>; mainnet: Record<number, ChainHint> } = {
  testnet: {
    0: { chainId: 11155111, rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", explorerUrl: "https://sepolia.etherscan.io", nativeSymbol: "ETH" },
    1: { chainId: 43113, rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc", explorerUrl: "https://testnet.snowtrace.io", nativeSymbol: "AVAX" },
    2: { chainId: 11155420, rpcUrl: "https://sepolia.optimism.io", explorerUrl: "https://sepolia-optimism.etherscan.io", nativeSymbol: "ETH" },
    3: { chainId: 421614, rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc", explorerUrl: "https://sepolia.arbiscan.io", nativeSymbol: "ETH" },
    6: { chainId: 84532, rpcUrl: "https://sepolia.base.org", explorerUrl: "https://sepolia.basescan.org", nativeSymbol: "ETH" },
    7: { chainId: 80002, rpcUrl: "https://rpc-amoy.polygon.technology", explorerUrl: "https://amoy.polygonscan.com", nativeSymbol: "POL" },
  },
  mainnet: {
    0: { chainId: 1, rpcUrl: "https://ethereum-rpc.publicnode.com", explorerUrl: "https://etherscan.io", nativeSymbol: "ETH" },
    1: { chainId: 43114, rpcUrl: "https://api.avax.network/ext/bc/C/rpc", explorerUrl: "https://snowtrace.io", nativeSymbol: "AVAX" },
    2: { chainId: 10, rpcUrl: "https://mainnet.optimism.io", explorerUrl: "https://optimistic.etherscan.io", nativeSymbol: "ETH" },
    3: { chainId: 42161, rpcUrl: "https://arb1.arbitrum.io/rpc", explorerUrl: "https://arbiscan.io", nativeSymbol: "ETH" },
    6: { chainId: 8453, rpcUrl: "https://mainnet.base.org", explorerUrl: "https://basescan.org", nativeSymbol: "ETH" },
    7: { chainId: 137, rpcUrl: "https://polygon-rpc.com", explorerUrl: "https://polygonscan.com", nativeSymbol: "POL" },
  },
};

/**
 * The chains a browser wallet can deposit on: Gateway's sources other than
 * Arc itself (a Polaris account is a passkey, not a browser wallet), with the
 * chain id and endpoints from Polaris's CCTP list when it has them.
 */
export function depositChains(
  sources: { domain: number; name: string; usdc: Address }[],
  opts: { arcDomain: number; testnet: boolean; known?: { domain: number; chainId: number; rpcUrl: string; explorerUrl: string }[] },
): DepositChain[] {
  const hints = opts.testnet ? CHAIN_HINTS.testnet : CHAIN_HINTS.mainnet;
  return sources
    .filter((s) => s.domain !== opts.arcDomain)
    .map((s): DepositChain | null => {
      const known = opts.known?.find((k) => k.domain === s.domain);
      const hint = hints[s.domain];
      if (!known && !hint) return null;
      return {
        domain: s.domain,
        name: s.name,
        usdc: s.usdc,
        chainId: known?.chainId ?? hint!.chainId,
        rpcUrl: known?.rpcUrl ?? hint!.rpcUrl,
        explorerUrl: (known?.explorerUrl ?? hint!.explorerUrl).replace(/\/+$/, ""),
        nativeSymbol: hint?.nativeSymbol ?? "ETH",
      };
    })
    .filter((c): c is DepositChain => c !== null);
}

/** A public block explorer for a source chain id Polaris knows, or null. */
export function knownExplorer(chainId: number): string | null {
  for (const table of [CHAIN_HINTS.testnet, CHAIN_HINTS.mainnet]) {
    for (const hint of Object.values(table)) if (hint.chainId === chainId) return hint.explorerUrl;
  }
  return null;
}
