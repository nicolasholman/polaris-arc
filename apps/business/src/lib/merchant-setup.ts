import type { Merchant, Payment, PaymentLink } from "./data/types";

export type SetupStep = { id: "registration" | "link" | "payment"; title: string; done: boolean | null };
/** Completion comes from persisted API/registry state, never a browser checkbox. */
export function merchantSetup(merchant: Merchant, links: PaymentLink[] | undefined, payments: Payment[] | undefined) {
  const paid = payments?.some((payment) => payment.status === "succeeded") ?? false;
  const registered = merchant.registration?.state === "registered" || merchant.registration?.state === "active";
  const usableLink = links?.find((link) => link.status === "active" && (!link.expiresAt || Date.parse(link.expiresAt) > Date.now())) ?? null;
  const steps: SetupStep[] = [
    { id: "registration", title: "Register your payout account", done: registered },
    { id: "link", title: "Create your first payment link", done: links === undefined ? null : usableLink !== null || paid },
    { id: "payment", title: "Receive your first payment", done: payments === undefined ? null : paid },
  ];
  return { steps, current: steps.find((step) => step.done !== true)?.id ?? null, complete: steps.every((step) => step.done === true), usableLink };
}
