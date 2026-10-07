import { type Address, encodeAbiParameters, type Hex, pad, parseAbi, zeroHash } from "viem";

/** TokenMessengerV2.depositForBurn (CCTP V2; selector 0x8e0250ee). */
export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

/** A standard transfer: no fee, the source chain's finality (minFinalityThreshold 2000). */
export const STANDARD_TRANSFER = { maxFee: 0n, minFinalityThreshold: 2000 } as const;

/**
 * The burn that mints `amount` USDC to `recipient` on Arc (CCTP domain 26):
 * the recipient as a left-padded bytes32, no destination caller (anyone,
 * here Polaris's relayer, may call `receiveMessage` on Arc), as a standard
 * transfer. Pure, so it can be checked without a wallet.
 */
export function depositForBurnCall(input: { tokenMessengerV2: Address; usdc: Address; arcDomain: number; recipient: Address; amount: bigint }) {
  return {
    address: input.tokenMessengerV2,
    abi: tokenMessengerV2Abi,
    functionName: "depositForBurn" as const,
    args: [
      input.amount,
      input.arcDomain,
      pad(input.recipient, { size: 32 }),
      input.usdc,
      zeroHash,
      STANDARD_TRANSFER.maxFee,
      STANDARD_TRANSFER.minFinalityThreshold,
    ] as const,
  };
}

/**
 * What PolarisCctpHookReceiver on Arc reads after the burn message:
 * `abi.encode(address merchant, string orderId, uint256 orderAmount, address refundTo)`.
 * refundTo is the buyer's Polaris account on Arc: any excess, or everything
 * when the order can't take the payment, goes there.
 */
export function orderHookData(input: { merchant: Address; orderId: string; orderAmount: bigint; refundTo: Address }): Hex {
  return encodeAbiParameters(
    [
      { name: "merchant", type: "address" },
      { name: "orderId", type: "string" },
      { name: "orderAmount", type: "uint256" },
      { name: "refundTo", type: "address" },
    ],
    [input.merchant, input.orderId, input.orderAmount, input.refundTo],
  );
}

/**
 * Pay a Polaris order on Arc in one source-chain transaction (CCTP V2 hook):
 * burn to PolarisCctpHookReceiver, which is both the mint recipient and the
 * only destination caller, so only it can finish the transfer, and it pays
 * the order with the minted USDC (PolarisPayments.pay). Standard transfer.
 * The burn must cover the order. Pure.
 */
export function depositForBurnWithHookCall(input: {
  tokenMessengerV2: Address;
  usdc: Address;
  arcDomain: number;
  hookReceiver: Address;
  amount: bigint;
  merchant: Address;
  orderId: string;
  orderAmount: bigint;
  refundTo: Address;
}) {
  if (input.amount < input.orderAmount) throw new Error("The burn must cover the order amount.");
  const receiver = pad(input.hookReceiver, { size: 32 });
  return {
    address: input.tokenMessengerV2,
    abi: tokenMessengerV2Abi,
    functionName: "depositForBurnWithHook" as const,
    args: [
      input.amount,
      input.arcDomain,
      receiver,
      input.usdc,
      receiver,
      STANDARD_TRANSFER.maxFee,
      STANDARD_TRANSFER.minFinalityThreshold,
      orderHookData({ merchant: input.merchant, orderId: input.orderId, orderAmount: input.orderAmount, refundTo: input.refundTo }),
    ] as const,
  };
}
