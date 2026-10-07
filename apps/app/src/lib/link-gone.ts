/**
 * Why a payment link opens no checkout, from Polaris for Business's answer
 * (`POST /api/public/links/{id}/checkout`): 410 `link_inactive` (the merchant
 * turned it off), `link_expired`, `link_used` (a one-time link already paid);
 * anything else that is gone (404, an unknown 410) is just "not found". The
 * checkout says which, so a buyer whose link was turned off isn't told it
 * "may have expired".
 */
export type LinkGone = "inactive" | "expired" | "used" | "not_found";

export function linkGoneReason(error: unknown): LinkGone | null {
  const { status, code } = (error ?? {}) as { status?: number; code?: string };
  if (status === 410) {
    if (code === "link_inactive") return "inactive";
    if (code === "link_expired" || code === "session_expired") return "expired";
    if (code === "link_used") return "used";
    return "not_found";
  }
  return status === 404 ? "not_found" : null;
}

/** What the checkout says for each, in the app's voice. */
export const LINK_GONE_TEXT: Record<LinkGone, { title: string; description: string }> = {
  inactive: {
    title: "This link was turned off",
    description: "The business that made it turned it off, so it no longer takes payments. Nothing was charged. Ask them for a new one.",
  },
  expired: {
    title: "This link has expired",
    description: "Its time ran out before it was paid. Nothing was charged. Ask whoever sent it for a new one.",
  },
  used: {
    title: "This link has already been paid",
    description: "It was for one payment, and that's done. Nothing more to pay here.",
  },
  not_found: {
    title: "This link doesn't go anywhere",
    description: "It may have expired, or part of it went missing. Ask whoever sent it for a new one.",
  },
};
