import { type Address, pad, parseAbi, zeroHash } from "viem";

/** TokenMessengerV2.depositForBurn (CCTP V2; selector 0x8e0250ee). */
export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
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
