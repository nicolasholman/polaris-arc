/**
 * The relayer's allow-list, in one place, for two enforcers:
 *
 *   1. Privy. `buildRelayerPolicy` turns it into the policy attached to the
 *      relayer's server wallet (scripts/privy/setup-relayer.mjs). Privy's
 *      policy engine runs in its enclave and denies anything no rule allows,
 *      so a compromised server still can't sign a call off this list.
 *   2. Us. `checkRelayerCall` applies the same list before a request ever
 *      reaches Privy (or, in local development, a raw key), so a call the
 *      policy would deny fails here with a clear error, and the dev adapter
 *      is held to exactly the production policy.
 *
 * Every call that moves money carries its owner's own signature (the
 * buyer's ERC-3009 authorisation or EIP-712 intent, the link key's claim,
 * the merchant's registration or transfer), so the relayer can carry money
 * but can't choose where it goes. And it never sends MON: every rule
 * requires a zero value, and a DENY rule refuses any value at all.
 *
 * Two calls are the exception, and are marked `signedBy: "operator"`: the
 * relayer holds PolarisPayments' operator role and makes them in a
 * merchant's name with no signature from that merchant.
 *
 *   - `quoteOrder` pins a checkout session's price on its order, so the
 *     order can only be paid at that price. It moves nothing; the worst a
 *     compromised server can do with it is make an order unpayable (a wrong
 *     price is refused by every payment path, so it can't cheapen one).
 *   - `createPlanFor` publishes a subscription plan paying the merchant it
 *     names. It moves nothing either: money only flows once a buyer signs a
 *     SubscribeIntent for that exact plan, price and period, and then only
 *     to that merchant. A compromised server could publish plans in a
 *     merchant's name (the merchant can retire them with `deactivatePlan`),
 *     but buyers still sign the price.
 *
 * A merchant-signed plan intent would close the second one; it needs a
 * contract change (plan §5.3), so it is written down here instead.
 *
 * PolarisSplit (split the bill by link) adds three calls, each carrying its
 * owner's signature: the organiser's CreateSplit and CloseSplit, and each
 * friend's ERC-3009 authorization for exactly their share. A deployment that
 * predates PolarisSplit has no address for it: its rules are left out of the
 * policy and its calls are refused, like any other contract off the list.
 *
 * `payWithAuthorization` (polarispay-sdk's direct pay) goes to
 * PolarisPayments without PolarisCheckout's cross-mode order guard, so the
 * relay refuses an order that belongs to a checkout session or that the
 * checkout already settled before it signs (relayer/relay.ts).
 *
 * This module is plain, erasable TypeScript with no server-only imports, so
 * the setup scripts load it directly with Node's type stripping.
 */

import { decodeFunctionData, getAddress, type Abi, type Address, type Hex } from "viem";
import {
  collateralVaultAbi,
  iausdAbi,
  merchantRegistryAbi,
  polarisCheckoutAbi,
  polarisLoanEngineAbi,
  polarisPaymentsAbi,
  polarisSendAbi,
  polarisSplitAbi,
} from "@polarispay/contracts/abi";

export type RelayerContract = "checkout" | "payments" | "send" | "split" | "loanEngine" | "registry" | "stablecoin" | "vault";

export type AllowedCall = {
  contract: RelayerContract;
  functionName: string;
  /** Privy rule name: 50 characters at most. */
  rule: string;
  /** What it's for, in the docs and the policy proof. */
  why: string;
  /**
   * `owner`: the call carries the signature of the account whose money or
   * record it touches. `operator`: the relayer acts in a merchant's name on
   * its PolarisPayments operator role, with no signature (see above).
   */
  signedBy: "owner" | "operator";
  /**
   * The argument holding the amount of AUSD the call moves, when it may not
   * be below the relayer's minimum (`RELAYER_MIN_TRANSFER_UNITS`). The two
   * calls a stranger can make with nothing but their own fresh key (a
   * transfer, a send by link) would otherwise let anyone spend the
   * relayer's MON moving 0 AUSD between throwaway keys.
   */
  minAmountArg?: string;
};

export const RELAYER_CALLS: readonly AllowedCall[] = [
  { contract: "checkout", functionName: "pay", rule: "Pay now: PolarisCheckout.pay", why: "Buyer's ERC-3009 ReceiveWithAuthorization, nonce = order key", signedBy: "owner" },
  { contract: "checkout", functionName: "openPlan", rule: "Pay in 4: PolarisCheckout.openPlan", why: "Buyer's PlanIntent + ERC-2612 permit", signedBy: "owner" },
  { contract: "checkout", functionName: "subscribe", rule: "Subscribe: PolarisCheckout.subscribe", why: "Buyer's SubscribeIntent + ERC-2612 permit", signedBy: "owner" },
  { contract: "checkout", functionName: "reauthorize", rule: "Re-sign: PolarisCheckout.reauthorize", why: "Buyer's ERC-2612 permit to the loan engine, restoring a lost allowance (the CRE retry collects on its event)", signedBy: "owner" },
  { contract: "payments", functionName: "payWithAuthorization", rule: "Direct pay: PolarisPayments.payWithAuthorization", why: "polarispay-sdk pay(): buyer's ERC-3009 authorisation", signedBy: "owner" },
  { contract: "payments", functionName: "cancelWithSignature", rule: "Cancel subscription: cancelWithSignature", why: "Subscriber's CancelSubscription signature", signedBy: "owner" },
  { contract: "payments", functionName: "createPlanFor", rule: "Publish plan: PolarisPayments.createPlanFor", why: "Operator: a merchant's subscription terms from a checkout session (moves nothing)", signedBy: "operator" },
  { contract: "payments", functionName: "quoteOrder", rule: "Pin a price: PolarisPayments.quoteOrder", why: "Operator: a checkout session's price, pinned on its order (moves nothing)", signedBy: "operator" },
  { contract: "send", functionName: "send", rule: "Send by link: PolarisSend.send", why: "Sender's ERC-3009 authorisation + the link key's Open", signedBy: "owner", minAmountArg: "amount" },
  { contract: "send", functionName: "claim", rule: "Claim a link: PolarisSend.claim", why: "The link key's Claim naming the recipient", signedBy: "owner" },
  { contract: "send", functionName: "cancel", rule: "Cancel a link: PolarisSend.cancel", why: "Sender's Cancel signature", signedBy: "owner" },
  { contract: "split", functionName: "createSplit", rule: "Split a bill: PolarisSplit.createSplit", why: "Organiser's CreateSplit signature (the shares, the link's words, the expiry)", signedBy: "owner" },
  { contract: "split", functionName: "payShare", rule: "Pay a share: PolarisSplit.payShare", why: "Friend's ERC-3009 authorisation for exactly their share, nonce = split and share", signedBy: "owner" },
  { contract: "split", functionName: "closeSplit", rule: "Close a split: PolarisSplit.closeSplit", why: "Organiser's CloseSplit signature (unpaid shares can no longer be paid)", signedBy: "owner" },
  { contract: "loanEngine", functionName: "repayWithSig", rule: "Pay early: PolarisLoanEngine.repayWithSig", why: "Borrower's RepayIntent", signedBy: "owner" },
  {
    contract: "vault",
    functionName: "lockWithPermit",
    rule: "Secure a line: CollateralVault.lockWithPermit",
    why: "Borrower's ERC-2612 permit to the vault, locked into their own position (a secured Pay in 4 line with no MON)",
    signedBy: "owner",
    minAmountArg: "amount",
  },
  {
    contract: "vault",
    functionName: "withdrawWithSig",
    rule: "Take out of Boost: CollateralVault.withdrawWithSig",
    why: "Borrower's EIP-712 Withdraw: their own collateral back to them, never the caller, only while it secures no loan",
    signedBy: "owner",
    minAmountArg: "amount",
  },
  { contract: "registry", functionName: "registerFor", rule: "Onboard: MerchantRegistry.registerFor", why: "Merchant's Registration signature (Privy embedded wallet)", signedBy: "owner" },
  { contract: "registry", functionName: "updatePayoutAddressWithSig", rule: "Payout address: updatePayoutAddressWithSig", why: "Merchant's PayoutUpdate signature", signedBy: "owner" },
  { contract: "stablecoin", functionName: "transferWithAuthorization", rule: "Payouts: AUSD transferWithAuthorization", why: "Owner's ERC-3009 TransferWithAuthorization (withdrawals, payouts, sends to a user)", signedBy: "owner", minAmountArg: "value" },
];

export const CONTRACT_ABIS: Record<RelayerContract, Abi> = {
  checkout: polarisCheckoutAbi as unknown as Abi,
  payments: polarisPaymentsAbi as unknown as Abi,
  send: polarisSendAbi as unknown as Abi,
  split: polarisSplitAbi as unknown as Abi,
  loanEngine: polarisLoanEngineAbi as unknown as Abi,
  registry: merchantRegistryAbi as unknown as Abi,
  stablecoin: iausdAbi as unknown as Abi,
  vault: collateralVaultAbi as unknown as Abi,
};

/**
 * Where each contract the relayer calls lives. Two are optional, and a
 * deployment without one has no rule for it, so nothing may call it:
 * PolarisSplit (Monad testnet's deployment of 28 Sep 2026 predates it) and
 * the vault (one that predates `lockWithPermit` has no gasless collateral).
 * A vault that predates `withdrawWithSig` (Monad testnet's today) still gets
 * that rule: no call to it can succeed there (the function doesn't exist, so
 * the simulation reverts before anything is signed), and the relay refuses
 * it first anyway (relay.ts `withdrawCollateral`, server/vault.ts).
 */
export type RelayerAddresses = Record<Exclude<RelayerContract, "split" | "vault">, Address> & { split?: Address | null; vault?: Address | null };

/** The contracts a deployment actually has, with their addresses. */
export function deployedContracts(addresses: RelayerAddresses): Array<[RelayerContract, Address]> {
  return (Object.entries(addresses) as Array<[RelayerContract, Address | null | undefined]>).filter(
    (entry): entry is [RelayerContract, Address] => typeof entry[1] === "string",
  );
}

/** The calls on the allow-list whose contract this deployment has. */
export function callsFor(addresses: RelayerAddresses): AllowedCall[] {
  const have = new Set(deployedContracts(addresses).map(([c]) => c));
  return RELAYER_CALLS.filter((c) => have.has(c.contract));
}

export class PolicyViolation extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.name = "PolicyViolation";
    this.rule = rule;
  }
}

export type CheckedCall = { contract: RelayerContract; functionName: string; args: readonly unknown[] };

/** The value of the named argument in a decoded call, from the function's ABI fragment. */
function argNamed(abi: Abi, functionName: string, args: readonly unknown[], name: string): unknown {
  for (const item of abi) {
    if (item.type !== "function" || item.name !== functionName || item.inputs.length !== args.length) continue;
    const i = item.inputs.findIndex((input) => input.name === name);
    if (i >= 0) return args[i];
  }
  return undefined;
}

/**
 * Refuse any transaction the relayer policy wouldn't allow: another chain,
 * any MON, a contract off the list, a function off the list, or (when
 * `minAmountUnits` is given) an amount below the relayer's minimum on the
 * calls that carry one.
 */
export function checkRelayerCall(
  tx: { to: Address | null | undefined; data: Hex | undefined; value?: bigint; chainId: number },
  expected: { chainId: number; addresses: RelayerAddresses; minAmountUnits?: bigint },
): CheckedCall {
  if (tx.chainId !== expected.chainId) {
    throw new PolicyViolation("chain_id", `The relayer signs only on chain ${expected.chainId}, not ${tx.chainId}.`);
  }
  if (tx.value !== undefined && tx.value !== 0n) {
    throw new PolicyViolation("Never send MON", "The relayer never sends MON.");
  }
  if (!tx.to) throw new PolicyViolation("to", "The relayer never deploys contracts.");
  const to = getAddress(tx.to);
  const contract = deployedContracts(expected.addresses).find(([, a]) => getAddress(a) === to)?.[0];
  if (!contract) throw new PolicyViolation("to", `${to} isn't a Polaris contract the relayer may call.`);
  if (!tx.data || tx.data.length < 10) throw new PolicyViolation("function_name", "The relayer only calls contract functions.");

  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: CONTRACT_ABIS[contract], data: tx.data }) as { functionName: string; args?: readonly unknown[] };
  } catch {
    throw new PolicyViolation("function_name", `That isn't a function of ${contract}.`);
  }
  const allowed = RELAYER_CALLS.find((c) => c.contract === contract && c.functionName === decoded.functionName);
  if (!allowed) {
    throw new PolicyViolation("function_name", `${contract}.${decoded.functionName} isn't on the relayer's allow-list.`);
  }
  if (allowed.minAmountArg && expected.minAmountUnits !== undefined) {
    const amount = argNamed(CONTRACT_ABIS[contract], decoded.functionName, decoded.args ?? [], allowed.minAmountArg);
    if (typeof amount !== "bigint" || amount < expected.minAmountUnits) {
      throw new PolicyViolation(
        `${decoded.functionName}.${allowed.minAmountArg}`,
        `The relayer carries ${decoded.functionName} only for ${expected.minAmountUnits} base units or more.`,
      );
    }
  }
  return { contract, functionName: decoded.functionName, args: decoded.args ?? [] };
}

/* ── The Privy policy ───────────────────────────────────────────────────── */

type Condition = Record<string, unknown>;
export type PrivyRule = { name: string; method: string; action: "ALLOW" | "DENY"; conditions: Condition[] };
export type PrivyPolicy = { version: "1.0"; name: string; chain_type: "ethereum"; rules: PrivyRule[] };

/** Addresses are compared as strings: accept both spellings. */
export const bothCases = (a: string): string[] => [getAddress(a), a.toLowerCase()];

/** Only the function fragments named `name`: Privy's ABI items can't be errors. */
export function functionFragments(abi: Abi, name: string): Abi {
  return abi.filter((item) => item.type === "function" && item.name === name) as Abi;
}

/**
 * The relayer's Privy policy (docs/research/privy.md §5.5).
 *
 * - `eth_signTransaction`: Privy signs, we broadcast to our own Monad RPC
 *   with the gas limit set from estimateGas + 15% (Monad bills the limit).
 * - One DENY rule refuses any transaction carrying MON. The Node SDK's viem
 *   adapter omits a zero `value`, so "value = 0" can't be an ALLOW condition.
 * - One ALLOW rule per call whose contract the deployment has: this chain,
 *   this contract, this function, and
 *   for the calls that move an amount a stranger chooses (an AUSD transfer,
 *   a send by link) that amount at least `minAmountUnits`, so a compromised
 *   server can't be used to burn the relayer's MON on zero-value calls.
 * - Everything else (other contracts, `approve`, raw MON transfers,
 *   `personal_sign`, typed data, key export) matches no rule and is denied.
 *
 * Privy's transaction conditions can't see the gas limit or the fee, so
 * those are capped by `submitCall` before anything is sent to Privy
 * (`RELAYER_MAX_GAS`, `RELAYER_MAX_FEE_GWEI`).
 */
export function buildRelayerPolicy(input: { chainId: number; addresses: RelayerAddresses; minAmountUnits?: bigint; name?: string }): PrivyPolicy {
  const onChain: Condition = { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(input.chainId) };
  const rules: PrivyRule[] = [
    {
      name: "Never send MON",
      method: "eth_signTransaction",
      action: "DENY",
      conditions: [{ field_source: "ethereum_transaction", field: "value", operator: "gt", value: "0" }],
    },
  ];
  for (const call of callsFor(input.addresses)) {
    const abi = functionFragments(CONTRACT_ABIS[call.contract], call.functionName);
    const conditions: Condition[] = [
      { field_source: "ethereum_transaction", field: "to", operator: "in", value: bothCases(input.addresses[call.contract] as Address) },
      onChain,
      { field_source: "ethereum_calldata", field: "function_name", abi, operator: "eq", value: call.functionName },
    ];
    if (call.minAmountArg && input.minAmountUnits !== undefined) {
      conditions.push({
        field_source: "ethereum_calldata",
        field: `${call.functionName}.${call.minAmountArg}`,
        abi,
        operator: "gte",
        value: input.minAmountUnits.toString(),
      });
    }
    rules.push({ name: call.rule, method: "eth_signTransaction", action: "ALLOW", conditions });
  }
  return { version: "1.0", name: (input.name ?? `polaris-relayer-${input.chainId}`).slice(0, 50), chain_type: "ethereum", rules };
}

/**
 * The registry admin's policy: it owns MerchantRegistry so it can activate
 * merchants, and it may do exactly that: `setActive`, and `setMaxOrderValue`
 * up to the activation cap. Nothing else a registry owner could do
 * (operators, ownership, settlements) is signable.
 */
export function buildRegistryAdminPolicy(input: { chainId: number; registry: Address; capUnits: bigint; name?: string }): PrivyPolicy {
  const registryAbi = CONTRACT_ABIS.registry;
  const base = (fn: string): Condition[] => [
    { field_source: "ethereum_transaction", field: "to", operator: "in", value: bothCases(input.registry) },
    { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(input.chainId) },
    { field_source: "ethereum_calldata", field: "function_name", abi: functionFragments(registryAbi, fn), operator: "eq", value: fn },
  ];
  return {
    version: "1.0",
    name: (input.name ?? `polaris-registry-admin-${input.chainId}`).slice(0, 50),
    chain_type: "ethereum",
    rules: [
      {
        name: "Never send MON",
        method: "eth_signTransaction",
        action: "DENY",
        conditions: [{ field_source: "ethereum_transaction", field: "value", operator: "gt", value: "0" }],
      },
      { name: "Activate a merchant: setActive", method: "eth_signTransaction", action: "ALLOW", conditions: base("setActive") },
      {
        name: "Cap a merchant: setMaxOrderValue within cap",
        method: "eth_signTransaction",
        action: "ALLOW",
        conditions: [
          ...base("setMaxOrderValue"),
          {
            field_source: "ethereum_calldata",
            field: "setMaxOrderValue.maxOrderValue",
            abi: functionFragments(registryAbi, "setMaxOrderValue"),
            operator: "lte",
            value: input.capUnits.toString(),
          },
        ],
      },
    ],
  };
}

/** Check a policy's own constraints (names ≤ 50 chars, function-only ABIs). */
export function lintPolicy(policy: PrivyPolicy): string[] {
  const problems: string[] = [];
  if (policy.name.length > 50) problems.push(`policy name is ${policy.name.length} characters (max 50)`);
  for (const rule of policy.rules) {
    if (rule.name.length > 50) problems.push(`rule "${rule.name}" is ${rule.name.length} characters (max 50)`);
    for (const c of rule.conditions) {
      const abi = c.abi as Array<{ type: string }> | undefined;
      if (abi && abi.some((item) => item.type !== "function")) problems.push(`rule "${rule.name}" has a non-function ABI item`);
      if (abi && abi.length === 0) problems.push(`rule "${rule.name}" has an empty ABI`);
    }
  }
  return problems;
}
