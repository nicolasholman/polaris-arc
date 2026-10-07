import "server-only";

/**
 * The contracts' ABIs, generated from the Hardhat artifacts
 * (packages/contracts/abi, `pnpm --filter @polarispay/contracts abi`). The
 * typed indexes give viem full inference over function names, arguments and
 * event arguments.
 */
export {
  aggregatorV3InterfaceAbi,
  batchSettlementAbi,
  collateralVaultAbi,
  collectionsReceiverAbi,
  guardianReceiverAbi,
  iausdAbi,
  merchantRegistryAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  polarisPaymentsAbi,
  polarisSendAbi,
  polarisSplitAbi,
  scoreManagerAbi,
  underwritingReceiverAbi,
} from "@polarispay/contracts/abi";
