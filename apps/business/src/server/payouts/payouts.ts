import "server-only";

import { newId, randomBytes32, type MerchantRecord, type PayoutRecord } from "@polaris/db";
import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";

import { money } from "@/lib/data/format";

import { iausdAbi } from "../chain/abis";
import { publicClient, requireChain } from "../chain/client";
import { centsToUnits, unitsToCents } from "../chain/money";
import { getDb } from "../db";
import { getConfig, type ChainConfig } from "../env";
import { HttpError } from "../http";
import { ingestReceipt } from "../ingest/ingest";
import { DEFAULT_PAYOUT_CAP_UNITS, TWA_TYPES } from "../policy/payout";
import { getPrivy } from "../privy";
import { relayTransfer } from "../relayer/relay";
import { TYPES } from "../relayer/typed-data";

/**
 * Money out: the "easy withdraw" (plan §5.7).
 *
 * 1. One tap: the merchant's Privy embedded wallet signs an AUSD
 *    `TransferWithAuthorization` to any address; the relayer submits it.
 * 2. Automatic daily payouts: our payout signer (a Privy key quorum, added
 *    to the merchant's wallet by the merchant with a policy that allows only
 *    AUSD transfers to their chosen payout address) signs the same
 *    authorisation from the server once a day, and the relayer submits it.
 *
 * Either way the merchant never holds MON, and `payout.paid` fires from the
 * transfer's receipt.
 */

export const MIN_AUTOMATIC_PAYOUT_UNITS = 1_000_000n; // $1: below this a payout costs more attention than it's worth
const AUTHORIZATION_TTL_SECONDS = 3600;

function stablecoinDomain(chain: ChainConfig) {
  return { ...chain.stablecoinDomain, chainId: chain.id, verifyingContract: chain.contracts.stablecoin };
}

export async function walletBalanceUnits(wallet: Address): Promise<bigint> {
  const chain = requireChain();
  return (await publicClient().readContract({ address: chain.contracts.stablecoin, abi: iausdAbi, functionName: "balanceOf", args: [wallet] })) as bigint;
}

async function recordAndRelay(input: {
  merchant: MerchantRecord;
  kind: PayoutRecord["kind"];
  from: Address;
  destination: Address;
  value: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}): Promise<PayoutRecord> {
  const db = getDb();
  const chain = requireChain();
  const payout = await db.payouts.insert({
    id: newId("po", 16),
    merchantId: input.merchant.id,
    kind: input.kind,
    state: "queued",
    amountUnits: input.value.toString(),
    from: input.from,
    destination: input.destination,
    authorizationNonce: input.nonce,
    txHash: null,
    error: null,
    createdAt: new Date().toISOString(),
    paidAt: null,
  });
  try {
    const result = await relayTransfer({
      chain,
      from: input.from,
      to: input.destination,
      value: input.value,
      validAfter: 0n,
      validBefore: input.validBefore,
      nonce: input.nonce,
      signature: input.signature,
      kind: "payout",
      merchantId: input.merchant.id,
    });
    // The receipt path may already have marked it paid; don't step backwards.
    const updated = await db.payouts.update(payout.id, (p) => (p.state === "paid" ? { ...p, txHash: result.txHash } : { ...p, state: "submitted", txHash: result.txHash }));
    if (result.status === "confirmed") {
      // The receipt was ingested before the txHash was recorded here; settle it now.
      await ingestReceipt(await publicClient().getTransactionReceipt({ hash: result.txHash }));
    }
    return ((await db.payouts.get(payout.id)) ?? updated) as PayoutRecord;
  } catch (error) {
    await db.payouts.update(payout.id, (p) => ({ ...p, state: "failed", error: (error as Error).message }));
    throw error;
  }
}

/**
 * One-tap withdraw with the merchant's signed authorisation. The server
 * rebuilds the typed data from the amount and destination in the request
 * and the wallet Privy told us about; a signature for anything else fails.
 */
export async function withdrawSigned(input: {
  merchant: MerchantRecord;
  wallet: Address;
  amountCents: number;
  destination: Address;
  authorization: { validAfter: string; validBefore: string; nonce: Hex; signature: Hex };
}): Promise<PayoutRecord> {
  const chain = requireChain();
  const value = centsToUnits(input.amountCents);
  const min = getConfig().relayerLimits.minTransferUnits;
  if (value < min) throw new HttpError(400, "amount_too_small", `Withdraw at least $${(Number(min) / 1e6).toFixed(2)}.`);
  const validAfter = BigInt(input.authorization.validAfter);
  const validBefore = BigInt(input.authorization.validBefore);
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  if (validBefore <= nowS) throw new HttpError(400, "authorization_expired", "That confirmation expired. Try again.");
  if (validBefore > nowS + BigInt(AUTHORIZATION_TTL_SECONDS + 60)) throw new HttpError(400, "invalid_request", "That confirmation is valid for too long. Try again.");
  if (validAfter !== 0n) throw new HttpError(400, "invalid_request", "validAfter must be 0.");

  const recovered = await recoverTypedDataAddress({
    domain: stablecoinDomain(chain),
    types: TYPES.TransferWithAuthorization,
    primaryType: "TransferWithAuthorization",
    message: { from: input.wallet, to: input.destination, value, validAfter, validBefore, nonce: input.authorization.nonce },
    signature: input.authorization.signature,
  }).catch(() => null);
  if (!recovered || getAddress(recovered) !== input.wallet) {
    throw new HttpError(403, "bad_signature", "That confirmation didn't come from your payout account.");
  }
  const balance = await walletBalanceUnits(input.wallet);
  if (balance < value) {
    throw new HttpError(400, "insufficient_balance", `You can withdraw up to ${money(unitsToCents(balance))} right now.`, { param: "amountCents" });
  }
  return recordAndRelay({
    merchant: input.merchant,
    kind: "manual",
    from: input.wallet,
    destination: input.destination,
    value,
    validBefore,
    nonce: input.authorization.nonce,
    signature: input.authorization.signature,
  });
}

/* ── Automatic payouts ──────────────────────────────────────────────────── */

export function nextRunAt(hourUtc: number, from = new Date()): string {
  const d = new Date(from);
  d.setUTCHours(hourUtc, 0, 0, 0);
  if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export type SweepOutcome = { merchantId: string; result: "paid" | "skipped" | "failed"; detail: string; payoutId?: string };

type WalletSigner = { signer_id: string; override_policy_ids?: string[] | null };

/**
 * Pay out one merchant's balance to their payout address, signed by our
 * payout signer under their policy. Refuses to act unless the wallet still
 * lists our signer with exactly this merchant's policy: the merchant can
 * revoke it at any time, and then nothing here can move their money.
 */
export async function sweepMerchant(merchant: MerchantRecord, now = new Date()): Promise<SweepOutcome> {
  const config = getConfig();
  const chain = requireChain();
  const privy = getPrivy();
  const auto = merchant.autoPayouts;
  const done = async (result: SweepOutcome["result"], detail: string, payoutId?: string): Promise<SweepOutcome> => {
    await getDb().merchants.update(merchant.id, (m) => ({
      ...m,
      autoPayouts: {
        ...m.autoPayouts,
        lastRunAt: now.toISOString(),
        nextRunAt: m.autoPayouts.enabled ? nextRunAt(m.autoPayouts.hourUtc, now) : null,
        lastError: result === "failed" ? detail : null,
      },
    }));
    return { merchantId: merchant.id, result, detail, payoutId };
  };

  if (!auto.enabled || !auto.payoutAddress || !auto.policyId) return done("skipped", "Automatic payouts are off.");
  if (!config.payoutSigner || !privy) return done("failed", "The payout signer isn't configured on this server.");
  if (!merchant.walletAddress || !merchant.walletId) return done("failed", "The payout account isn't set up.");

  let signers: WalletSigner[];
  try {
    const wallet = (await privy.wallets().get(merchant.walletId)) as unknown as { additional_signers?: WalletSigner[] };
    signers = wallet.additional_signers ?? [];
  } catch {
    return done("failed", "We couldn't reach Privy to check the payout signer.");
  }
  const ours = signers.find((s) => s.signer_id === config.payoutSigner?.signerId);
  if (!ours || ours.override_policy_ids?.[0] !== auto.policyId) {
    return done("failed", "Automatic payouts need your approval again: turn them off and on.");
  }

  const balance = await walletBalanceUnits(merchant.walletAddress);
  if (balance < MIN_AUTOMATIC_PAYOUT_UNITS) return done("skipped", "Nothing to pay out.");
  const value = balance > DEFAULT_PAYOUT_CAP_UNITS ? DEFAULT_PAYOUT_CAP_UNITS : balance;
  const validBefore = BigInt(Math.floor(now.getTime() / 1000) + AUTHORIZATION_TTL_SECONDS);
  const nonce = randomBytes32();

  let signature: Hex;
  try {
    const out = await privy.wallets().ethereum().signTypedData(merchant.walletId, {
      params: {
        typed_data: {
          domain: stablecoinDomain(chain),
          // Byte-identical to the policy's `types`, EIP712Domain included, or Privy won't evaluate its conditions.
          types: TWA_TYPES,
          primary_type: "TransferWithAuthorization",
          message: {
            from: merchant.walletAddress,
            to: auto.payoutAddress,
            value: value.toString(),
            validAfter: "0",
            validBefore: validBefore.toString(),
            nonce,
          },
        },
      },
      authorization_context: { authorization_private_keys: [config.payoutSigner.authorizationKey] },
    });
    signature = out.signature as Hex;
  } catch (error) {
    console.error("[payouts] the payout signer was refused", error);
    return done("failed", "Privy refused the payout signature: check the payout address and policy.");
  }

  try {
    const payout = await recordAndRelay({
      merchant,
      kind: "automatic",
      from: merchant.walletAddress,
      destination: auto.payoutAddress,
      value,
      validBefore,
      nonce,
      signature,
    });
    return done("paid", `Paid out ${value} to ${auto.payoutAddress}.`, payout.id);
  } catch (error) {
    return done("failed", (error as Error).message);
  }
}

/** Every merchant whose daily payout is due. */
export async function runPayoutSweep(options: { now?: Date; merchantId?: string } = {}): Promise<SweepOutcome[]> {
  const now = options.now ?? new Date();
  const db = getDb();
  const merchants = options.merchantId
    ? [await db.merchants.get(options.merchantId)].filter((m): m is MerchantRecord => m !== null)
    : (await db.merchants.find({ autoPayouts: true })).filter((m) => m.autoPayouts.nextRunAt && Date.parse(m.autoPayouts.nextRunAt) <= now.getTime());
  const out: SweepOutcome[] = [];
  for (const merchant of merchants) out.push(await sweepMerchant(merchant, now));
  return out;
}
