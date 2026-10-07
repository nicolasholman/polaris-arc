import "server-only";

/**
 * The contracts' ABIs, generated from the Hardhat artifacts
 * (packages/contracts/abi, `pnpm --filter @polarispay/contracts abi`). The
 * typed indexes give viem full inference over function names, arguments and
 * event arguments. Circle's contracts on Arc (CCTP, Memo) are in ./circle.ts.
 */
export {
  batchSettlementAbi,
  collateralVaultAbi,
  collectionsReceiverAbi,
  creditGuardAbi,
  iusdcAbi,
  merchantRegistryAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  polarisPaymentsAbi,
  polarisSendAbi,
  polarisSplitAbi,
  scoreManagerAbi,
  underwritingReceiverAbi,
} from "@polarispay/contracts/abi";
