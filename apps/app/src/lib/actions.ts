import { type Address, type Hex, type LocalAccount, parseAbi, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { api, apiConfigured } from "./api";
import { BOOST_PERMIT_SECONDS, boostAmountProblem, buildBoostPermit, buildTakeOut, TAKE_OUT_SIGNATURE_SECONDS, type TakeOutBoost, takeOutProblem } from "./boost";
import { owedOnOpenPlans } from "./collection";
import { publicClient } from "./chain";
import type { PaymentLink, Person, Plan } from "./data/types";
import { getDomain, isConfigured, resolveContract } from "./domains";
import { getNetwork } from "./network";
import { amountParam, type Micros, usd } from "./money";
import { inboxReady } from "./receipts/inbox";
import { RelayError, type RelayReceipt, relayer, type Signed } from "./relayer";
import { memoHash, rememberSplit, SPLIT_LIFETIME_DAYS, type SplitMemo, splitUrl } from "./split";
import {
  buildCancel,
  buildCancelSubscription,
  buildClaim,
  buildCloseSplit,
  buildCreateSplit,
  buildOpen,
  buildPermit,
  buildPlanIntent,
  buildReceiveWithAuthorization,
  buildRepayIntent,
  buildSubscribeIntent,
  buildTransferWithAuthorization,
  type Eip712Domain,
  paymentNonce,
  sendNonce,
  shareNonce,
  splitIdOf,
} from "./sign";
import type { SplitStatus } from "./data/types";

/**
 * Each money action as the app performs it: build the typed data, sign it
 * with the account (no prompt: Face ID already happened in `authorize`), and
 * hand the signatures to the relayer. Every struct is the contract's own
 * (src/lib/sign/types.ts, checked against packages/contracts by
 * `pnpm check:signatures`).
 */

const MINUTE = 60n;
const now = () => BigInt(Math.floor(Date.now() / 1000));

/** How long a link stays claimable. PolarisSend allows 5 minutes to 30 days. */
export const SEND_LINK_LIFETIME_DAYS = 7;

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const noncesAbi = parseAbi(["function nonces(address owner) view returns (uint256)"]);

/** `nonces(owner)` on a contract, or 0 when it isn't reachable (the relayer's simulation then refuses a stale signature). */
async function readNonce(name: "ausd" | "checkout" | "loanEngine", owner: Address): Promise<bigint> {
  if (!isConfigured(name)) return 0n;
  try {
    const address = await resolveContract(name);
    if (address === zeroAddress) return 0n;
    return await publicClient().readContract({ address, abi: noncesAbi, functionName: "nonces", args: [owner] });
  } catch {
    return 0n;
  }
}

type BuyerState = {
  checkoutNonce: bigint;
  tokenNonce: bigint;
  /** PolarisCheckout.quotePlan(...).permitValue: what the buyer owes in total once this plan opens. */
  permitValue: bigint | null;
  /**
   * The Subscribe permit's value, from Polaris for Business: the buyer's
   * current allowance to PolarisPayments (every other subscription renews
   * from it) plus this plan's authorised periods. A permit replaces the
   * allowance, so signing only this plan's periods would starve the others.
   */
  subscriptionPermitValue: bigint | null;
};

/**
 * What the buyer's checkout signatures depend on right now. From Polaris for
 * Business for a real session (it reads the chain), else from our own reads.
 */
async function buyerState(link: PaymentLink, buyer: Address): Promise<BuyerState> {
  if (link.session && apiConfigured()) {
    const s = await api<{
      buyer: { checkoutNonce: string; tokenNonce: string; quote: { permitValue: string } | null; subscription?: { permitValue: string } | null } | null;
    }>(`/api/public/sessions/${encodeURIComponent(link.id)}?buyer=${buyer}`);
    if (s.buyer) {
      return {
        checkoutNonce: BigInt(s.buyer.checkoutNonce),
        tokenNonce: BigInt(s.buyer.tokenNonce),
        permitValue: s.buyer.quote ? BigInt(s.buyer.quote.permitValue) : null,
        subscriptionPermitValue: s.buyer.subscription ? BigInt(s.buyer.subscription.permitValue) : null,
      };
    }
  }
  const [checkoutNonce, tokenNonce] = await Promise.all([readNonce("checkout", buyer), readNonce("ausd", buyer)]);
  return { checkoutNonce, tokenNonce, permitValue: null, subscriptionPermitValue: null };
}

const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

/** AUSD `allowance(owner, spender)`, or 0 when it isn't reachable. */
async function readAllowance(owner: Address, spender: Address): Promise<bigint> {
  if (!isConfigured("ausd")) return 0n;
  try {
    const address = await resolveContract("ausd");
    if (address === zeroAddress) return 0n;
    return await publicClient().readContract({ address, abi: allowanceAbi, functionName: "allowance", args: [owner, spender] });
  } catch {
    return 0n;
  }
}

/** Signs a payload from one of the builders (which type-check it against viem). */
async function sign<M>(account: LocalAccount, typed: { domain: Eip712Domain; message: M }): Promise<Signed<M>> {
  const signature = await account.signTypedData(typed as unknown as Parameters<LocalAccount["signTypedData"]>[0]);
  return { signature, domain: typed.domain, message: typed.message };
}

export type PayMode = "now" | "later" | "subscription";

/** Checkout: Pay now, Pay in 4 or Subscribe. */
export async function payLink(
  account: LocalAccount,
  link: PaymentLink,
  mode: PayMode,
  opts: { outstanding?: Micros } = {},
): Promise<RelayReceipt> {
  // A first payment right after Face ID created the account: let its inbox key land, so the receipt is sealed as it settles.
  await inboxReady(account.address);
  const t = now();
  if (mode === "now") {
    const [domain, payments] = await Promise.all([getDomain("ausd"), resolveContract("payments")]);
    const signed = await sign(
      account,
      buildReceiveWithAuthorization(domain, {
        from: account.address,
        to: payments,
        value: link.amount,
        validAfter: 0n,
        validBefore: t + 10n * MINUTE,
        // Commits the signature to this merchant and this order: the relayer can't redirect it.
        nonce: paymentNonce(link.merchant.address, link.orderId),
      }),
    );
    return relayer.payNow({ link, payer: account.address, authorization: signed });
  }

  const [checkoutDomain, tokenDomain, state] = await Promise.all([getDomain("checkout"), getDomain("ausd"), buyerState(link, account.address)]);
  const deadline = t + 15n * MINUTE;

  if (mode === "later") {
    const offer = link.modes.later;
    if (!offer) throw new Error("This link doesn't offer Pay in 4");
    const loanEngine = await resolveContract("loanEngine");
    const intent = await sign(
      account,
      buildPlanIntent(checkoutDomain, {
        buyer: account.address,
        merchant: link.merchant.address,
        principal: link.amount,
        installments: offer.installments,
        interval: BigInt(offer.interval),
        orderId: link.orderId,
        nonce: state.checkoutNonce,
        deadline,
      }),
    );
    // One allowance backs the whole book (§5.2): everything owed already plus this plan.
    const permit = await sign(
      account,
      buildPermit(tokenDomain, {
        owner: account.address,
        spender: loanEngine,
        value: state.permitValue ?? (opts.outstanding ?? 0n) + offer.total,
        nonce: state.tokenNonce,
        deadline: t + 30n * MINUTE,
      }),
    );
    return relayer.openPlan({ link, intent, permit });
  }

  const offer = link.modes.subscription;
  if (!offer) throw new Error("This link doesn't offer a subscription");
  const payments = await resolveContract("payments");
  const intent = await sign(
    account,
    buildSubscribeIntent(checkoutDomain, {
      buyer: account.address,
      merchant: link.merchant.address,
      planId: offer.planId,
      pricePerPeriod: offer.price,
      periodSeconds: BigInt(offer.periodSeconds),
      orderId: link.orderId,
      nonce: state.checkoutNonce,
      deadline,
    }),
  );
  // One allowance to PolarisPayments backs every subscription the buyer has: keep what the others need, add this one.
  const permitValue =
    state.subscriptionPermitValue ?? (await readAllowance(account.address, payments)) + offer.price * BigInt(offer.periodsAuthorised);
  const permit = await sign(
    account,
    buildPermit(tokenDomain, {
      owner: account.address,
      spender: payments,
      value: permitValue,
      nonce: state.tokenNonce,
      deadline: t + 30n * MINUTE,
    }),
  );
  return relayer.subscribe({ link, intent, permit });
}

export type CreatedSendLink = {
  url: string;
  linkKey: Address;
  amount: Micros;
  expiresAt: number;
  receipt: RelayReceipt;
};

/**
 * Send by link. A throwaway key is born here and travels only inside the
 * link's fragment, which browsers never send to a server. The sender's
 * signature escrows the dollars against that key's address, and the key
 * itself signs `Open`, so only whoever holds the link could have opened it.
 */
export async function createSendLink(
  account: LocalAccount,
  amount: Micros,
  senderName: string,
  origin: string,
): Promise<CreatedSendLink> {
  const linkPrivateKey = generatePrivateKey();
  const linkAccount = privateKeyToAccount(linkPrivateKey);
  const linkKey = linkAccount.address;
  const t = now();
  const expiresAt = t + BigInt(SEND_LINK_LIFETIME_DAYS) * 86_400n;
  const [tokenDomain, sendDomain, send] = await Promise.all([getDomain("ausd"), getDomain("send"), resolveContract("send")]);
  const authorization = await sign(
    account,
    buildReceiveWithAuthorization(tokenDomain, {
      from: account.address,
      to: send,
      value: amount,
      validAfter: 0n,
      validBefore: t + 10n * MINUTE,
      // Commits the signature to this link key and expiry.
      nonce: sendNonce(linkKey, expiresAt),
    }),
  );
  const open = await sign(linkAccount, buildOpen(sendDomain, { sender: account.address, amount, expiresAt }));
  const receipt = await relayer.send({ sender: account.address, senderName, linkKey, amount, expiresAt, authorization, open });
  const fragment = new URLSearchParams({ k: linkPrivateKey, a: amountParam(amount), n: senderName });
  return {
    url: `${origin}/claim#${fragment.toString()}`,
    linkKey,
    amount,
    expiresAt: Number(expiresAt) * 1000,
    receipt,
  };
}

/**
 * Claim: the link's key signs the recipient's address and a deadline. No
 * account signature needed. Until the deadline passes the claim can't be
 * redirected (PolarisSend), so it is kept short.
 */
export async function claimLink(
  recipient: Address,
  linkPrivateKey: Hex,
  amount: Micros,
  senderName: string,
): Promise<RelayReceipt> {
  const linkAccount = privateKeyToAccount(linkPrivateKey);
  const domain = await getDomain("send");
  const deadline = now() + 15n * MINUTE;
  const claim = await sign(linkAccount, buildClaim(domain, { to: recipient, deadline }));
  return relayer.claim({ linkKey: linkAccount.address, claim, deadline, amount, senderName });
}

export async function cancelSendLink(account: LocalAccount, linkKey: Address): Promise<RelayReceipt> {
  const domain = await getDomain("send");
  const cancel = await sign(account, buildCancel(domain, { linkKey, deadline: now() + 15n * MINUTE }));
  return relayer.cancelSend({ cancel });
}

/* ── Split the bill (PolarisSplit) ──────────────────────────────────────── */

export type CreatedSplit = { splitId: Hex; url: string; memo: SplitMemo; amounts: Micros[]; expiresAt: number; receipt: RelayReceipt };

/**
 * Open a split: the organiser signs CreateSplit (the shares, a fresh salt,
 * the hash of the link's words, the expiry), and the relayer opens it. The
 * split's id is known before it lands (keccak256(organiser, salt)), so the
 * link is built here; its words go in the fragment and on this device, never
 * to a server.
 */
export async function createSplit(account: LocalAccount, amounts: Micros[], memo: SplitMemo, origin: string): Promise<CreatedSplit> {
  const t = now();
  const expiresAt = t + BigInt(SPLIT_LIFETIME_DAYS) * 86_400n;
  const salt = randomNonce();
  const domain = await getDomain("split");
  if (domain.verifyingContract === zeroAddress) {
    throw new RelayError("unavailable", "Splitting a bill isn't available here yet.");
  }
  const creation = await sign(
    account,
    buildCreateSplit(domain, { organiser: account.address, salt, amounts, memoHash: memoHash(memo), expiresAt, deadline: t + 15n * MINUTE }),
  );
  const splitId = splitIdOf(account.address, salt);
  const receipt = await relayer.createSplit({ creation });
  const url = splitUrl(origin, splitId, memo);
  rememberSplit(splitId, { memo, url, role: "organiser", at: Date.now() });
  return { splitId, url, memo, amounts, expiresAt: Number(expiresAt) * 1000, receipt };
}

/**
 * Pay share `index` of a split: one ERC-3009 authorisation for exactly its
 * amount, payable to PolarisSplit, with the nonce it derives from the split
 * and the share. The dollars go straight on to the organiser. A friend short
 * of dollars is told before anything is signed.
 */
export async function payShare(account: LocalAccount, split: SplitStatus, index: number, opts: { balance?: Micros } = {}): Promise<RelayReceipt> {
  const share = split.shares[index];
  if (!share || share.paid) throw new RelayError("already-settled", "This share has already been paid.");
  if (opts.balance !== undefined && opts.balance < share.amount) {
    // Rounded up to the cent, so a share of $33.333334 never asks for $0.00.
    const short = ((share.amount - opts.balance + 9_999n) / 10_000n) * 10_000n;
    throw new RelayError("insufficient-funds", `Add ${usd(short)} to pay your share.`);
  }
  const [domain, to] = await Promise.all([getDomain("ausd"), resolveContract("split")]);
  const t = now();
  const authorization = await sign(
    account,
    buildReceiveWithAuthorization(domain, {
      from: account.address,
      to,
      value: share.amount,
      validAfter: 0n,
      validBefore: t + 10n * MINUTE,
      // Commits the signature to this split and this share: the relayer can't point it anywhere else.
      nonce: shareNonce(split.id, BigInt(index)),
    }),
  );
  return relayer.payShare({ splitId: split.id, index, payer: account.address, authorization });
}

/** Close a split: the organiser signs CloseSplit. Nothing moves; unpaid shares can't be paid after. */
export async function closeSplit(account: LocalAccount, splitId: Hex): Promise<RelayReceipt> {
  const domain = await getDomain("split");
  const close = await sign(account, buildCloseSplit(domain, { splitId, deadline: now() + 15n * MINUTE }));
  return relayer.closeSplit({ close });
}

export async function cancelSubscription(account: LocalAccount, subId: bigint): Promise<RelayReceipt> {
  const domain = await getDomain("payments");
  const cancel = await sign(account, buildCancelSubscription(domain, { subId, deadline: now() + 15n * MINUTE }));
  return relayer.cancelSubscription({ cancel });
}

/** Send straight to someone who already has Polaris (their Receive code). */
export async function transferTo(account: LocalAccount, to: Person, amount: Micros): Promise<RelayReceipt> {
  if (!to.address || to.address === zeroAddress) throw new Error("That code has no account on it");
  const domain = await getDomain("ausd");
  const t = now();
  const authorization = await sign(
    account,
    buildTransferWithAuthorization(domain, {
      from: account.address,
      to: to.address,
      value: amount,
      validAfter: 0n,
      validBefore: t + 10n * MINUTE,
      nonce: randomNonce(),
    }),
  );
  return relayer.transfer({ to, authorization });
}

const debtAbi = parseAbi(["function activeDebtOf(address borrower) view returns (uint256)"]);

/**
 * Sign again after a collection failed because Polaris's approval to take
 * the buyer's payments was gone: one ERC-2612 permit to the loan engine,
 * which PolarisCheckout.reauthorize applies. A permit replaces the approval,
 * so it covers everything still owed on every open plan
 * (`PolarisLoanEngine.activeDebtOf`, which the contract checks).
 */
export async function reauthorizePayments(account: LocalAccount, plans: Plan[]): Promise<RelayReceipt> {
  let owed = owedOnOpenPlans(plans);
  const [domain, loanEngine, nonce] = await Promise.all([getDomain("ausd"), resolveContract("loanEngine"), readNonce("ausd", account.address)]);
  if (isConfigured("loanEngine") && loanEngine !== zeroAddress) {
    try {
      owed = await publicClient().readContract({ address: loanEngine, abi: debtAbi, functionName: "activeDebtOf", args: [account.address] });
    } catch {
      // keep the plans' own figures; the relayer checks the permit against the chain anyway
    }
  }
  const permit = await sign(account, buildPermit(domain, { owner: account.address, spender: loanEngine, value: owed, nonce, deadline: now() + 30n * MINUTE }));
  return relayer.reauthorize({ buyer: account.address, permit });
}

const loanAbi = parseAbi([
  "function outstandingOf(uint256 loanId) view returns (uint256)",
  "function getLoan(uint256 loanId) view returns ((address borrower, address merchant, uint128 principal, uint128 totalOwed, uint128 totalRepaid, uint32 installmentCount, uint32 installmentsPaid, uint64 startedAt, uint64 intervalSeconds, uint8 status))",
]);

/**
 * Pay the rest of a plan early. The intent pins the plan's current state
 * (`expectedRepaid`), so it can't be replayed after a collection moved it.
 */
export async function payEarly(account: LocalAccount, plan: Plan): Promise<RelayReceipt> {
  let outstanding = plan.instalments.filter((i) => i.paidAt === null).reduce((sum, i) => sum + i.amount, 0n);
  let repaid = plan.instalments.filter((i) => i.paidAt !== null).reduce((sum, i) => sum + i.amount, 0n);
  if (isConfigured("loanEngine")) {
    try {
      const address = await resolveContract("loanEngine");
      const [owed, loan] = await Promise.all([
        publicClient().readContract({ address, abi: loanAbi, functionName: "outstandingOf", args: [plan.loanId] }),
        publicClient().readContract({ address, abi: loanAbi, functionName: "getLoan", args: [plan.loanId] }),
      ]);
      outstanding = owed;
      repaid = loan.totalRepaid;
    } catch {
      // keep the plan's own figures; the relayer refuses a stale intent anyway
    }
  }
  const [domain, nonce] = await Promise.all([getDomain("loanEngine"), readNonce("loanEngine", account.address)]);
  const repay = await sign(
    account,
    buildRepayIntent(domain, { loanId: plan.loanId, amount: outstanding, expectedRepaid: repaid, nonce, deadline: now() + 15n * MINUTE }),
  );
  return relayer.payEarly({ planId: plan.id, loanId: plan.loanId, borrower: account.address, repay });
}

/**
 * Add to Boost: one ERC-2612 permit on the dollar, spender CollateralVault,
 * value exactly `amount`, under the dollar's domain as Polaris for Business
 * reports it; the relayer carries it to `CollateralVault.lockWithPermit`
 * (lib/boost.ts). The vault is the one the deployment record names, never
 * one from the caller. `balance` (the dollar balance on screen) refuses an
 * amount the account doesn't hold before anything is signed.
 */
export async function addToBoost(account: LocalAccount, amount: Micros, opts: { balance?: Micros } = {}): Promise<RelayReceipt> {
  const problem = boostAmountProblem(amount, opts.balance);
  if (problem) throw new RelayError(problem.includes("balance") ? "insufficient-funds" : "invalid-signature", `${problem}.`);
  const network = getNetwork();
  const vault = network ? (await network).vault : null;
  if (!vault) throw new RelayError("unavailable", "Boost isn't available on this network.");
  const [domain, nonce] = await Promise.all([getDomain("ausd"), readNonce("ausd", account.address)]);
  const permit = await sign(account, buildBoostPermit(domain, { owner: account.address, vault, amount, nonce, deadline: now() + BOOST_PERMIT_SECONDS }));
  return relayer.lockCollateral({ permit });
}

const vaultNoncesAbi = parseAbi(["function nonces(address) view returns (uint256)"]);

/**
 * Take out of Boost: one EIP-712 Withdraw under the vault's own domain
 * (borrower the account, the amount, the vault's `nonces(account)`, a
 * deadline 15 minutes out), which the relayer carries to
 * `CollateralVault.withdrawWithSig` (lib/boost.ts). The vault pays the account
 * and nobody else. `boost` is what the sheet shows (`getBoost`): on a vault
 * that predates signed withdrawal (`takeOut` null), or for an amount that
 * isn't free to take out, nothing is signed.
 */
export async function takeOutOfBoost(account: LocalAccount, amount: Micros, boost: TakeOutBoost): Promise<RelayReceipt> {
  if (!boost.takeOut) throw new RelayError("unavailable", "Taking dollars out of Boost isn't available on this network yet.");
  const problem = takeOutProblem(amount, boost);
  if (problem) throw new RelayError(problem.includes("secures") ? "over-limit" : problem.includes("more than") ? "insufficient-funds" : "invalid-signature", `${problem}.`);
  const network = getNetwork();
  const vault = network ? (await network).vault : null;
  if (!vault) throw new RelayError("unavailable", "Boost isn't available on this network.");
  const nonce = await publicClient().readContract({ address: vault, abi: vaultNoncesAbi, functionName: "nonces", args: [account.address] });
  const withdraw = await sign(account, buildTakeOut(boost.takeOut, { borrower: account.address, amount, nonce, deadline: now() + TAKE_OUT_SIGNATURE_SECONDS }));
  return relayer.withdrawCollateral({ withdraw });
}
