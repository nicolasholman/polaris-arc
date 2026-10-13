import {withOriginTransactionLock} from "./origin-transaction-lock";
import {SubmissionBoundary} from "./submission-boundary";
import { type Address, type Hex, type LocalAccount, decodeFunctionData, parseAbi, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { api, apiConfigured } from "./api";
import { BOOST_PERMIT_SECONDS, boostAmountProblem, buildBoostPermit, buildTakeOut, TAKE_OUT_SIGNATURE_SECONDS, type TakeOutBoost, takeOutProblem } from "./boost";
import { owedOnOpenPlans } from "./collection";
import { env } from "./env";
import { linkEvidenceAbi, sentLinkProof, terminalLinkProof, type LinkProof } from "./send-link-evidence";
import { readLinkIntent, saveLinkIntent, clearLinkIntent } from "./send-link-journal";
import {readCreateIntent,saveCreateIntent,clearCreateIntent,type CreateIntent} from "./send-create-journal";
import { publicClient } from "./chain";
import type { PaymentLink, Person, Plan } from "./data/types";
import { getDomain, isConfigured, resolveContract } from "./domains";
import { getNetwork } from "./network";
import { type Currency, type Micros, usd } from "./money";
import { inboxReady } from "./receipts/inbox";
import { RelayError, type RelayReceipt, relayer, type Signed } from "./relayer";
import { claimUrl } from "./links";
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
async function readNonce(name: "usdc" | "checkout" | "loanEngine", owner: Address): Promise<bigint> {
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
  const [checkoutNonce, tokenNonce] = await Promise.all([readNonce("checkout", buyer), readNonce("usdc", buyer)]);
  return { checkoutNonce, tokenNonce, permitValue: null, subscriptionPermitValue: null };
}

const allowanceAbi = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

/** USDC `allowance(owner, spender)`, or 0 when it isn't reachable. */
async function readAllowance(owner: Address, spender: Address): Promise<bigint> {
  if (!isConfigured("usdc")) return 0n;
  try {
    const address = await resolveContract("usdc");
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
    const [domain, payments] = await Promise.all([getDomain("usdc"), resolveContract("payments")]);
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

  const [checkoutDomain, tokenDomain, state] = await Promise.all([getDomain("checkout"), getDomain("usdc"), buyerState(link, account.address)]);
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
  /** Dollars (USDC) or euros (EURC). */
  currency: Currency;
  amount: Micros;
  expiresAt: number;
  receipt: RelayReceipt;
};

/** The token, its PolarisSend, and their domains, for a currency. */
const SEND_CONTRACTS = {
  USD: { token: "usdc", send: "send" },
  EUR: { token: "eurc", send: "sendEurc" },
} as const;

/** Whether this network takes euro send links (EURC and its PolarisSend are deployed). */
export async function eurosAvailable(): Promise<boolean> {
  const network = getNetwork();
  return network ? Boolean((await network).euro?.sendEurc) : false;
}

/**
 * Send by link. A throwaway key is born here and travels only inside the
 * link's fragment, which browsers never send to a server. The sender's
 * signature escrows the money against that key's address, and the key
 * itself signs `Open`, so only whoever holds the link could have opened it.
 *
 * Dollars escrow USDC in PolarisSend; euros (`EUR`) escrow EURC in the
 * PolarisSend deployed on EURC, under EURC's and that contract's own domains.
 * The link says which (`c=EUR`), so the claim goes to the same contract.
 */
const createInFlight=new Set<string>();
const createBearers=new Map<string,{key:Hex;origin:string;senderName:string;currency:Currency}>();
async function verifyCreatedSend(p:CreateIntent){
 if(!p.hash)throw new RelayError('unavailable','The original send has no known transaction hash. Genuine relayer history is required; no new signature was requested.');
 const client=publicClient();const proof=await sentLinkProof(client,p,p.hash);
 if(proof.sender.toLowerCase()!==p.sender.toLowerCase()||proof.amount!==BigInt(p.amount)||proof.expiresAt!==BigInt(p.expiresAt))throw new RelayError('unavailable','The send receipt does not match the frozen original amount, sender and expiry.');
 const tx=await client.getTransaction({hash:p.hash});const call=decodeFunctionData({abi:linkEvidenceAbi,data:tx.input});
 if(call.functionName!=='send'||call.args[4]!==0n||call.args[5]!==BigInt(p.validBefore))throw new RelayError('unavailable','The original send authorization window does not match.');
 const block=await client.getBlock({blockTag:'finalized'});if(block.number===null)throw new RelayError('unavailable','Finalized link state is unavailable.');
 const link=await client.readContract({address:p.send,abi:linkEvidenceAbi,functionName:'linkOf',args:[p.linkKey],blockNumber:block.number});
 if(link.sender.toLowerCase()!==p.sender.toLowerCase()||link.amount!==BigInt(p.amount)||link.expiresAt!==BigInt(p.expiresAt)||block.timestamp>=link.expiresAt)throw new RelayError('unavailable','The original link is not a verified open claimable link. No share link was shown.');
 return proof;
}
/** Read-only funding recovery. Bearer keys never persist; reload cannot reconstruct a share link. */
export async function recoverInitialSend(sender:Address){
 return withOriginTransactionLock(`polaris:send-journals:${env.chainId}`,()=>recoverInitialSendLocked(sender));
}
async function recoverInitialSendLocked(sender:Address){
 const p=readCreateIntent(localStorage,env.chainId,sender);if(!p)throw new RelayError('unavailable','No original send is saved on this device.');
 for(const currency of ['USD','EUR'] as const){const names=SEND_CONTRACTS[currency];const [send,token]=await Promise.all([resolveContract(names.send),resolveContract(names.token)]);if(send.toLowerCase()===p.send.toLowerCase()&&token.toLowerCase()===p.token.toLowerCase()){await verifyCreatedSend(p);const bearer=createBearers.get(`${p.chainId}:${p.sender.toLowerCase()}`);let url:string|undefined;
 if(bearer&&privateKeyToAccount(bearer.key).address.toLowerCase()===p.linkKey.toLowerCase()){url=claimUrl(bearer.origin,{key:bearer.key,amount:BigInt(p.amount),name:bearer.senderName,currency});clearCreateIntent(localStorage,p);createBearers.delete(`${p.chainId}:${p.sender.toLowerCase()}`);}
 return {linkKey:p.linkKey,hash:p.hash!,amount:BigInt(p.amount),currency,url};}}
 throw new RelayError('unavailable','The original send contract or token is not configured on this network. No outcome was inferred.');
}

export async function createSendLink(account:LocalAccount,amount:Micros,senderName:string,origin:string,currency:Currency="USD"):Promise<CreatedSendLink>{
 return withOriginTransactionLock(`polaris:send-journals:${env.chainId}`,()=>createSendLinkLocked(account,amount,senderName,origin,currency));
}

async function createSendLinkLocked(
  account: LocalAccount,
  amount: Micros,
  senderName: string,
  origin: string,
  currency: Currency = "USD",
): Promise<CreatedSendLink> {
  const active=`${env.chainId}:${account.address.toLowerCase()}`;
  if(createInFlight.has(active))throw new RelayError('unavailable','The original send is still in progress. No second signature was requested.');
  createInFlight.add(active);
  let ownedCreate:CreateIntent|undefined;const createBoundary=new SubmissionBoundary();
  try {
  if(readCreateIntent(localStorage,env.chainId,account.address))throw new RelayError('unavailable','An original send is unresolved. Check its receipt before creating another link. The bearer key is not stored on disk.');
  const names=SEND_CONTRACTS[currency];
  const [tokenDomain,sendDomain,send,token]=await Promise.all([getDomain(names.token),getDomain(names.send),resolveContract(names.send),resolveContract(names.token)]);
  const client=publicClient();
  if(send===zeroAddress||token===zeroAddress||await client.getChainId()!==env.chainId||tokenDomain.chainId!==env.chainId||sendDomain.chainId!==env.chainId||sendDomain.verifyingContract?.toLowerCase()!==send.toLowerCase()||tokenDomain.verifyingContract?.toLowerCase()!==token.toLowerCase())throw new RelayError('unavailable','Sending by link is unavailable on this network.');
  const linkPrivateKey=generatePrivateKey();const linkAccount=privateKeyToAccount(linkPrivateKey);const linkKey=linkAccount.address;
  const t=now();const expiresAt=t+BigInt(SEND_LINK_LIFETIME_DAYS)*86_400n;
  let pending:CreateIntent={version:1,chainId:env.chainId,sender:account.address,send,token,linkKey,amount:amount.toString(),expiresAt:expiresAt.toString(),validBefore:(t+10n*MINUTE).toString()};
  if(readCreateIntent(localStorage,env.chainId,account.address))throw new RelayError('unavailable','Another original send was saved while checking the network. No signature was requested.');
  saveCreateIntent(localStorage,pending); // Public metadata only, before signing; bearer key stays in memory.
  ownedCreate=pending;
  createBearers.set(active,{key:linkPrivateKey,origin,senderName,currency});
  const authorization=await sign(account,buildReceiveWithAuthorization(tokenDomain,{from:account.address,to:send,value:amount,validAfter:0n,validBefore:BigInt(pending.validBefore),nonce:sendNonce(linkKey,expiresAt)}));
  const open=await sign(linkAccount,buildOpen(sendDomain,{sender:account.address,amount,expiresAt}));
  createBoundary.enter(); // From this point response loss cannot prove rejection.
  const receipt=await relayer.send({sender:account.address,senderName,linkKey,amount,expiresAt,authorization,open,currency});
  pending={...pending,hash:receipt.txHash};saveCreateIntent(localStorage,pending);
  await verifyCreatedSend(pending);
  const result={url:claimUrl(origin,{key:linkPrivateKey,amount,name:senderName,currency}),linkKey,currency,amount,expiresAt:Number(expiresAt)*1000,receipt};
  clearCreateIntent(localStorage,pending);
  createBearers.delete(active);
  return result;
  } catch(error){
    if(ownedCreate&&!ownedCreate.hash)createBoundary.releaseUnsigned(()=>{clearCreateIntent(localStorage,ownedCreate!);createBearers.delete(active);});
    throw error;
  } finally {createInFlight.delete(active);}

}

function clearReturnedCreation(proof:LinkProof,status:string){
 if(status!=='cancelled'&&status!=='refunded')return;
 const original=readCreateIntent(localStorage,proof.chainId,proof.sender);
 if(original&&original.send.toLowerCase()===proof.send.toLowerCase()&&original.token.toLowerCase()===proof.token.toLowerCase()&&original.linkKey.toLowerCase()===proof.linkKey.toLowerCase()&&BigInt(original.amount)===proof.amount&&BigInt(original.expiresAt)===proof.expiresAt) {clearCreateIntent(localStorage,original);createBearers.delete(`${proof.chainId}:${proof.sender.toLowerCase()}`);}
}
const terminalInFlight=new Set<string>();
/** Durable link-key-scoped lock; re-entry only reads the original outcome. */
async function terminalAction(kind:'claim'|'cancel',currency:Currency,linkKey:Address,recipient:Address,submit:(broadcast:()=>void)=>Promise<RelayReceipt>):Promise<RelayReceipt>{
 return withOriginTransactionLock(`polaris:send-journals:${env.chainId}`,()=>terminalActionLocked(kind,currency,linkKey,recipient,submit));
}
async function terminalActionLocked(kind: 'claim'|'cancel', currency: Currency, linkKey: Address, recipient: Address, submit:(broadcast:()=>void)=>Promise<RelayReceipt>):Promise<RelayReceipt> {
  const names=SEND_CONTRACTS[currency];
  const [send,token]=await Promise.all([resolveContract(names.send),resolveContract(names.token)]);
  if(send===zeroAddress||token===zeroAddress)throw new RelayError('unavailable','Send links are unavailable on this network.');
  const activeKey=`${env.chainId}:${send.toLowerCase()}:${linkKey.toLowerCase()}`;
  if(terminalInFlight.has(activeKey))throw new RelayError('unavailable','The original link action is still in progress. No second signature was requested.');
  terminalInFlight.add(activeKey);
  let ownedTerminal:ReturnType<typeof readLinkIntent>=null;const terminalBoundary=new SubmissionBoundary();
  try {
  const client=publicClient();
  let pending=readLinkIntent(localStorage,env.chainId,send,linkKey);
  const recovered=Boolean(pending);
  if(pending&&(pending.kind!==kind||pending.recipient.toLowerCase()!==recipient.toLowerCase()||pending.token.toLowerCase()!==token.toLowerCase()))throw new RelayError('unavailable','An original link action is unresolved. Restore its original recipient and check its receipt before signing anything else.');
  if(!pending){
    if(await client.getChainId()!==env.chainId)throw new RelayError('unavailable','The RPC is on a different network.');
    const block=await client.getBlock({blockTag:'finalized'});if(block.number===null||!block.hash)throw new RelayError('unavailable','Finalized link state is unavailable.');
    const [link,actualToken]=await Promise.all([client.readContract({address:send,abi:linkEvidenceAbi,functionName:'linkOf',args:[linkKey],blockNumber:block.number}),client.readContract({address:send,abi:linkEvidenceAbi,functionName:'stablecoin',blockNumber:block.number})]);
    if(actualToken.toLowerCase()!==token.toLowerCase()||link.sender===zeroAddress||link.amount<=0n)throw new RelayError('already-settled','No matching funded open link was verified.');
    if(kind==='cancel'&&recipient.toLowerCase()!==link.sender.toLowerCase())throw new RelayError('invalid-signature','Only the original sender can cancel this link.');
    pending={version:1,chainId:env.chainId,send,token,linkKey,sender:link.sender,recipient,kind,amount:link.amount.toString(),expiresAt:link.expiresAt.toString(),fromBlock:block.number.toString(),stateBlockHash:block.hash};
    if(readLinkIntent(localStorage,env.chainId,send,linkKey))throw new RelayError('unavailable','An original link action was saved while checking the chain. Recover it before signing.');
    saveLinkIntent(localStorage,pending); // Before signing or handing anything to the relayer.
    ownedTerminal=pending;
  }
  if(!recovered){
    const receipt=await submit(()=>{terminalBoundary.enter();});pending={...pending,hash:receipt.txHash};saveLinkIntent(localStorage,pending);
  }
  const proof:LinkProof={...pending,amount:BigInt(pending.amount),expiresAt:BigInt(pending.expiresAt),fromBlock:BigInt(pending.fromBlock)};
  const outcome=await terminalLinkProof(client,proof,pending.hash);
  if(!outcome)throw new RelayError('unavailable','The original action is unresolved. Provider or relayer history is required; no new signature was requested.');
  if(outcome.status!==(kind==='claim'?'claimed':'cancelled')||outcome.recipient.toLowerCase()!==recipient.toLowerCase())throw new RelayError('already-settled','The link closed through a different verified action. No new signature was requested.');
  clearReturnedCreation(proof,outcome.status);
  saveLinkIntent(localStorage,{...pending,hash:outcome.hash}); // Permanent exact receipt identity; later calls stay read-only.
  // Recovery times describe the verified inclusion block, never a fabricated relay submission.
  return {txHash:outcome.hash,submittedAt:outcome.at,finalizedAt:outcome.at,explorerUrl:env.explorerUrl?`${env.explorerUrl}/tx/${outcome.hash}`:null};
  } catch(error){
    if(ownedTerminal&&!ownedTerminal.hash)terminalBoundary.releaseUnsigned(()=>clearLinkIntent(localStorage,ownedTerminal!));
    throw error;
  } finally { terminalInFlight.delete(activeKey); }
}

/** Reconcile a saved action without obtaining an account or requesting any signature. */
export async function recoverSendLinkAction(linkKey:Address,currency:Currency='USD'){
 return withOriginTransactionLock(`polaris:send-journals:${env.chainId}`,()=>recoverSendLinkActionLocked(linkKey,currency));
}
async function recoverSendLinkActionLocked(linkKey:Address,currency:Currency='USD'){
 const names=SEND_CONTRACTS[currency];const send=await resolveContract(names.send);
 const pending=readLinkIntent(localStorage,env.chainId,send,linkKey);
 if(!pending)throw new RelayError('unavailable','No original unresolved action is saved on this device.');
 const token=await resolveContract(names.token);if(token.toLowerCase()!==pending.token.toLowerCase())throw new RelayError('unavailable','The configured token changed. No outcome was inferred.');
 const proof:LinkProof={...pending,amount:BigInt(pending.amount),expiresAt:BigInt(pending.expiresAt),fromBlock:BigInt(pending.fromBlock)};
 const outcome=await terminalLinkProof(publicClient(),proof,pending.hash);
 if(!outcome)throw new RelayError('unavailable','The original action is unresolved. Genuine provider or relayer history is required. No new signature was requested.');
 clearReturnedCreation(proof,outcome.status);
 saveLinkIntent(localStorage,{...pending,hash:outcome.hash});
 return outcome;
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
  currency: Currency = "USD",
): Promise<RelayReceipt> {
  const linkAccount = privateKeyToAccount(linkPrivateKey);
  const domain = await getDomain(SEND_CONTRACTS[currency].send);
  if (domain.verifyingContract === zeroAddress) throw new RelayError("unavailable", "Euro links aren't available on this network.");
  return terminalAction('claim',currency,linkAccount.address,recipient,async(broadcast)=>{
    const deadline = now() + 15n * MINUTE;
    const claim = await sign(linkAccount, buildClaim(domain, { to: recipient, deadline }));
    broadcast();
    return relayer.claim({ linkKey: linkAccount.address, claim, deadline, amount, senderName, currency });
  });
}

export async function cancelSendLink(account: LocalAccount, linkKey: Address, currency: Currency = "USD"): Promise<RelayReceipt> {
  const domain = await getDomain(SEND_CONTRACTS[currency].send);
  return terminalAction('cancel',currency,linkKey,account.address,async(broadcast)=>{
    const cancel = await sign(account, buildCancel(domain, { linkKey, deadline: now() + 15n * MINUTE }));
    broadcast();
    return relayer.cancelSend({ cancel, currency });
  });
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
  const [domain, to] = await Promise.all([getDomain("usdc"), resolveContract("split")]);
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
  const domain = await getDomain("usdc");
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
  const [domain, loanEngine, nonce] = await Promise.all([getDomain("usdc"), resolveContract("loanEngine"), readNonce("usdc", account.address)]);
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
  const [domain, nonce] = await Promise.all([getDomain("usdc"), readNonce("usdc", account.address)]);
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
