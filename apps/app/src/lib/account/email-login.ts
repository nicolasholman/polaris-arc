import type { Address } from "viem";
import { AccountError } from "./errors";

/**
 * "Continue with email" is a sheet, opened from wherever the person is (the
 * Face ID step of onboarding, a checkout's confirm sheet). The account layer
 * asks for it here and waits; the sheet (components/email-login-sheet.tsx)
 * answers with the embedded wallet's address, or cancels.
 */

type Pending = { resolve: (address: Address) => void; reject: (error: unknown) => void };

let pending: Pending | null = null;
let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeEmailLogin(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emailLoginOpen(): boolean {
  return open;
}

/** Opens the email sheet. Resolves when the person is signed in, rejects when they close it. */
export function requestEmailLogin(): Promise<Address> {
  pending?.reject(new AccountError("cancelled", "Replaced by a new sign-in"));
  open = true;
  emit();
  return new Promise<Address>((resolve, reject) => {
    pending = { resolve, reject };
  });
}

export function finishEmailLogin(address: Address): void {
  pending?.resolve(address);
  pending = null;
  open = false;
  emit();
}

export function cancelEmailLogin(): void {
  pending?.reject(new AccountError("cancelled", "Email sign-in was closed"));
  pending = null;
  open = false;
  emit();
}
