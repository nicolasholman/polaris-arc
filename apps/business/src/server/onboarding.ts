import "server-only";

import type { MerchantRecord } from "@polaris/db";
import { encodeFunctionData, getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";

import { requireWallet, type AuthedMerchant } from "./auth";
import { merchantRegistryAbi } from "./chain/abis";
import { publicClient, requireChain } from "./chain/client";
import { getDb } from "./db";
import { getConfig } from "./env";
import { HttpError } from "./http";
import { ensureMerchant, toMerchant } from "./merchants";
import { consume, LIMITS } from "./ratelimit";
import { carry } from "./relayer/carry";
import { polarisDomain, TYPES } from "./relayer/typed-data";

/**
 * Merchant onboarding on chain (plan §5.2 item 9, §5.7).
 *
 * The merchant's Privy embedded wallet signs a MerchantRegistry
 * `Registration` (its own address, the business name, where payouts go), and
 * the relayer, a registry operator, sends `registerFor`. The merchant never
 * holds MON. The operator can deliver a registration but not write one: every
 * field that decides where money goes is in the merchant's signature.
 *
 * Then, when a registry admin is configured (REGISTRY_ACTIVATOR), the
 * merchant is activated with a Pay in 4 cap (MERCHANT_ACTIVATION_CAP_USD,
 * $1,000 by default), by a Privy wallet whose policy allows only
 * `setActive` and `setMaxOrderValue` up to that cap.
 */

type Registry = { payoutAddress: Address; name: string; registeredAt: bigint; active: boolean; maxOrderValue: bigint };

async function readRegistry(wallet: Address): Promise<Registry> {
  const chain = requireChain();
  return (await publicClient().readContract({
    address: chain.contracts.registry,
    abi: merchantRegistryAbi,
    functionName: "merchantOf",
    args: [wallet],
  })) as Registry;
}

/** Bring our record in line with the registry (it may have been registered or activated elsewhere). */
async function syncFromChain(merchant: MerchantRecord, wallet: Address): Promise<MerchantRecord> {
  const onChain = await readRegistry(wallet);
  const state = onChain.registeredAt === 0n ? null : onChain.active ? "active" : "registered";
  if (!state || merchant.registration.state === state) return merchant;
  return (await getDb().merchants.update(merchant.id, (m) => ({
    ...m,
    registration: { ...m.registration, state, maxOrderUnits: onChain.maxOrderValue.toString(), error: null, updatedAt: new Date().toISOString() },
  }))) as MerchantRecord;
}

/**
 * A registration left in flight (the relay's receipt wait ran out, or it
 * failed) or registered with an activation error: read the registry again,
 * one call, so GET /api/me moves it on without the merchant doing anything.
 * Never throws: the stored state is returned if the chain can't be read.
 */
export async function refreshRegistration(merchant: MerchantRecord): Promise<MerchantRecord> {
  const { state, error } = merchant.registration;
  const pending = state === "submitted" || state === "failed" || (state === "registered" && error !== null);
  if (!pending || !merchant.walletAddress || getConfig().chain === null) return merchant;
  try {
    return await syncFromChain(merchant, getAddress(merchant.walletAddress));
  } catch {
    return merchant;
  }
}

/**
 * Signed into the merchant's MerchantRegistry entry for good, so it must be
 * a real host: registration waits for POLARIS_PUBLIC_URL in production.
 */
function metadataUri(merchant: MerchantRecord): string {
  const base = getConfig().publicUrl;
  if (!base) {
    throw new HttpError(503, "not_configured", "Registration on Monad opens once this server's public URL is configured.");
  }
  return `${base}/api/public/merchants/${merchant.publicId}`;
}

function registrationMessage(merchant: MerchantRecord, wallet: Address, nonce: bigint, deadline: bigint) {
  if (!merchant.businessName) throw new HttpError(409, "name_required", "Name your business first.");
  return { merchant: wallet, name: merchant.businessName, payoutAddress: wallet, metadataURI: metadataUri(merchant), nonce, deadline };
}

/** What the dashboard asks the embedded wallet to sign. */
export async function getRegistration(auth: AuthedMerchant) {
  const chain = requireChain();
  const wallet = requireWallet(auth);
  const merchant = await syncFromChain(await ensureMerchant(auth), wallet);
  const needsSignature = merchant.registration.state === "none" || merchant.registration.state === "failed";
  let typedData = null;
  if (needsSignature && merchant.businessName) {
    const nonce = (await publicClient().readContract({ address: chain.contracts.registry, abi: merchantRegistryAbi, functionName: "nonces", args: [wallet] })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const message = registrationMessage(merchant, wallet, nonce, deadline);
    typedData = {
      domain: polarisDomain("registry", chain.id, chain.contracts.registry),
      types: { Registration: [...TYPES.Registration.Registration] },
      primaryType: "Registration" as const,
      // uint256 as decimal strings: what Privy's useSignTypedData takes (research §2.5).
      message: { ...message, nonce: nonce.toString(), deadline: deadline.toString() },
    };
  }
  return { merchant: toMerchant(merchant), typedData };
}

/** Verify the merchant's Registration signature and relay `registerFor`, then activate. */
export async function submitRegistration(auth: AuthedMerchant, body: Record<string, unknown>) {
  const chain = requireChain();
  const wallet = requireWallet(auth);
  consume(LIMITS.onboardPerMerchant, auth.userId);
  let merchant = await syncFromChain(await ensureMerchant(auth), wallet);
  if (merchant.registration.state === "registered" || merchant.registration.state === "active") {
    return { merchant: toMerchant(await activate(merchant, wallet)) };
  }

  const signature = body.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new HttpError(400, "invalid_request", "signature must be the 65-byte Registration signature.", { param: "signature" });
  }
  const rawDeadline = body.deadline;
  if (typeof rawDeadline !== "string" || !/^\d{1,12}$/.test(rawDeadline)) {
    throw new HttpError(400, "invalid_request", "deadline must be the unix time you signed.", { param: "deadline" });
  }
  const deadline = BigInt(rawDeadline);
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= nowS) throw new HttpError(400, "signature_expired", "That confirmation expired. Try again.");
  if (deadline > nowS + 7200n) throw new HttpError(400, "invalid_request", "That confirmation is valid for too long. Try again.");

  const nonce = (await publicClient().readContract({ address: chain.contracts.registry, abi: merchantRegistryAbi, functionName: "nonces", args: [wallet] })) as bigint;
  const message = registrationMessage(merchant, wallet, nonce, deadline);
  const recovered = await recoverTypedDataAddress({
    domain: polarisDomain("registry", chain.id, chain.contracts.registry),
    types: TYPES.Registration,
    primaryType: "Registration",
    message,
    signature: signature as Hex,
  }).catch(() => null);
  if (!recovered || getAddress(recovered) !== wallet) {
    throw new HttpError(403, "bad_signature", "That confirmation didn't come from your payout account.");
  }

  const db = getDb();
  await db.merchants.update(merchant.id, (m) => ({ ...m, registration: { ...m.registration, state: "submitted", error: null, updatedAt: new Date().toISOString() } }));
  try {
    const result = await carry({
      kind: "registerMerchant",
      relayId: `register:${wallet.toLowerCase()}:${nonce}`,
      to: chain.contracts.registry,
      data: encodeFunctionData({
        abi: merchantRegistryAbi,
        functionName: "registerFor",
        args: [wallet, message.name, message.payoutAddress, message.metadataURI, deadline, signature as Hex],
      }),
      signer: wallet,
      merchantId: merchant.id,
    });
    merchant = (await db.merchants.update(merchant.id, (m) => ({
      ...m,
      registration: {
        ...m.registration,
        state: result.status === "confirmed" ? "registered" : "submitted",
        txHash: result.txHash,
        error: null,
        updatedAt: new Date().toISOString(),
      },
    }))) as MerchantRecord;
  } catch (error) {
    await db.merchants.update(merchant.id, (m) => ({
      ...m,
      registration: { ...m.registration, state: "failed", error: (error as Error).message, updatedAt: new Date().toISOString() },
    }));
    throw error;
  }
  return { merchant: toMerchant(await activate(merchant, wallet)) };
}

/**
 * How many different payers have paid this merchant in full (Pay now) for
 * what their checkout asked: the settlement history automatic activation
 * waits for.
 */
async function distinctPayers(merchantId: string): Promise<number> {
  const payments = await getDb().payments.find({ merchantId });
  return new Set(payments.filter((p) => p.kind === "now" && !p.mismatch).map((p) => p.payer.toLowerCase())).size;
}

/**
 * Activate a registered merchant for Pay in 4 once it has some settlement
 * history, if it hasn't been activated yet and a registry admin is set up.
 * Called after each Pay-now payment to a registered merchant (ingest).
 */
export async function activateIfEligible(merchantId: string): Promise<MerchantRecord | null> {
  const config = getConfig();
  if (config.activator.mode === "off") return null;
  const merchant = await getDb().merchants.get(merchantId);
  if (!merchant?.walletAddress || merchant.registration.state !== "registered") return merchant;
  return activate(merchant, merchant.walletAddress);
}

/** Activate a registered merchant with the Pay in 4 cap, when a registry admin is configured and it has the history. */
async function activate(merchant: MerchantRecord, wallet: Address): Promise<MerchantRecord> {
  const config = getConfig();
  if (config.activator.mode === "off" || merchant.registration.state === "active") return merchant;
  if (merchant.registration.state !== "registered") return merchant;
  if (config.activationMinPayers > 0) {
    const payers = await distinctPayers(merchant.id);
    if (payers < config.activationMinPayers) {
      const waiting = `Registered. Pay in 4 opens automatically after paid orders from ${config.activationMinPayers} different customers (${payers} so far).`;
      return (await getDb().merchants.update(merchant.id, (m) => ({
        ...m,
        registration: { ...m.registration, error: waiting, updatedAt: new Date().toISOString() },
      }))) as MerchantRecord;
    }
  }
  const chain = requireChain();
  const cap = config.activationCapUnits;
  try {
    const capped = await carry({
      kind: "activateMerchant",
      role: "activator",
      relayId: `cap:${wallet.toLowerCase()}:${cap}`,
      to: chain.contracts.registry,
      data: encodeFunctionData({ abi: merchantRegistryAbi, functionName: "setMaxOrderValue", args: [wallet, cap] }),
      signer: null,
      merchantId: merchant.id,
    });
    const activated = await carry({
      kind: "activateMerchant",
      role: "activator",
      relayId: `activate:${wallet.toLowerCase()}`,
      to: chain.contracts.registry,
      data: encodeFunctionData({ abi: merchantRegistryAbi, functionName: "setActive", args: [wallet, true] }),
      signer: null,
      merchantId: merchant.id,
    });
    return (await getDb().merchants.update(merchant.id, (m) => ({
      ...m,
      registration: {
        ...m.registration,
        state: activated.status === "confirmed" && capped.status === "confirmed" ? "active" : m.registration.state,
        error: null,
        activationTxHash: activated.txHash,
        maxOrderUnits: cap.toString(),
        updatedAt: new Date().toISOString(),
      },
    }))) as MerchantRecord;
  } catch (error) {
    console.error("[onboarding] activation failed", error);
    return (await getDb().merchants.update(merchant.id, (m) => ({
      ...m,
      registration: { ...m.registration, error: "Registered. Activation for Pay in 4 is pending.", updatedAt: new Date().toISOString() },
    }))) as MerchantRecord;
  }
}
