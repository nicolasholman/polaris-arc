"use client";

import { useCallback } from "react";

import { useAuth } from "./auth-context";
import { ausdDomain, AUTHORIZATION_TTL_SECONDS, CENTS_TO_AUSD_UNITS, TRANSFER_WITH_AUTHORIZATION_TYPES } from "./chain";
import type { Address, AutoPayouts, Cents, Merchant, Payout, WithdrawInput } from "./data/types";
import { PAYOUT_SIGNER_ID } from "./features";
import { useDashboardData } from "./session";

type Domain = { name: string; version: string; chainId: number; verifyingContract: Address };

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let networkDomain: Promise<Domain | null> | null = null;

/**
 * AUSD's EIP-712 domain as the server serves it (`/api/public/network`, from
 * the deployment record, so the chain id and address are the ones the relayer
 * uses), falling back to this build's NEXT_PUBLIC_AUSD_* settings. Null when
 * the server has no chain: then nothing can be withdrawn.
 */
export function stablecoinDomain(): Promise<Domain | null> {
  networkDomain ??= fetch("/api/public/network", { cache: "no-store" })
    .then(async (res) =>
      res.ok ? ((await res.json()) as { data?: { domains?: { stablecoin?: Domain } } }).data?.domains?.stablecoin ?? null : null,
    )
    .catch(() => null)
    .then((d) => d ?? (ausdDomain() as Domain | null));
  return networkDomain;
}

/**
 * One-tap withdraw. The merchant's embedded wallet signs an ERC-3009
 * TransferWithAuthorization (no gas: the relayer submits it as
 * `AUSD.transferWithAuthorization`) and the server checks the signature came
 * from that wallet before relaying it. Callers only reach this once the
 * server reports a chain and a relayer (see `useCapabilities`).
 */
export function useWithdraw() {
  const data = useDashboardData();
  const { wallet } = useAuth();

  return useCallback(
    async (amountCents: Cents, destination: Address): Promise<Payout> => {
      const domain = await stablecoinDomain();
      const input: WithdrawInput = { amountCents, destination };

      if (domain) {
        if (!wallet.address) throw new Error("Your payout account is still being set up. Try again in a moment.");
        const validAfter = "0";
        const validBefore = String(Math.floor(Date.now() / 1000) + AUTHORIZATION_TTL_SECONDS);
        const nonce = randomNonce();
        const signature = await wallet.signTypedData(
          {
            domain,
            types: { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization] },
            primaryType: "TransferWithAuthorization",
            // uint256 values as decimal strings (see docs/research/privy.md §2.5).
            message: {
              from: wallet.address,
              to: destination,
              value: (BigInt(amountCents) * CENTS_TO_AUSD_UNITS).toString(),
              validAfter,
              validBefore,
              nonce,
            },
          },
          { title: "Confirm withdrawal", buttonText: "Confirm" },
        );
        input.authorization = { validAfter, validBefore, nonce, signature };
      }

      return data.withdraw(input);
    },
    [data, wallet],
  );
}

/**
 * Automatic daily payouts. The server creates a Privy policy that allows only
 * AUSD transfers to `payoutAddress`; we then add our payout signer to the
 * merchant's wallet with that policy as its override. Turning off removes it,
 * and the server never needs the wallet for that (it checks the wallet only
 * when turning on).
 */
export function useAutoPayouts() {
  const data = useDashboardData();
  const { wallet } = useAuth();

  const enable = useCallback(
    async (payoutAddress: Address): Promise<AutoPayouts> => {
      const auto = await data.setAutoPayouts({ enabled: true, payoutAddress });
      if (PAYOUT_SIGNER_ID && auto.policyId) {
        try {
          await wallet.addPayoutSigner(PAYOUT_SIGNER_ID, [auto.policyId]);
        } catch (error) {
          // Keep the server honest: no signer means no automatic payouts.
          await data.setAutoPayouts({ enabled: false, payoutAddress }).catch(() => undefined);
          throw error;
        }
      }
      return auto;
    },
    [data, wallet],
  );

  const disable = useCallback(
    async (payoutAddress: Address | null): Promise<AutoPayouts> => {
      const auto = await data.setAutoPayouts({ enabled: false, payoutAddress });
      if (PAYOUT_SIGNER_ID) await wallet.removePayoutSigners().catch(() => undefined);
      return auto;
    },
    [data, wallet],
  );

  return { enable, disable };
}

/**
 * Register the business on chain (MerchantRegistry), right after it is named:
 * the embedded wallet signs the `Registration` the server prepares, and the
 * relayer sends `registerFor`. The merchant never holds MON. Resolves with the
 * merchant as the server now sees it (its `registration.state`).
 */
export function useRegisterMerchant() {
  const data = useDashboardData();
  const { wallet } = useAuth();

  return useCallback(async (): Promise<Merchant> => {
    const state = await data.getRegistration();
    if (!state.typedData) {
      // Registered but not yet active (activation failed or is pending): try it again.
      if (state.merchant.registration?.state === "registered") return (await data.submitRegistration({})).merchant;
      return state.merchant;
    }
    if (!wallet.address) throw new Error("Your payout account is still being set up. Try again in a moment.");
    const signature = await wallet.signTypedData(state.typedData, { title: "Register your business", buttonText: "Confirm" });
    const done = await data.submitRegistration({ signature, deadline: state.typedData.message.deadline });
    return done.merchant;
  }, [data, wallet]);
}
