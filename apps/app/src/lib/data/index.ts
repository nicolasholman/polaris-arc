import type { Address, Hex } from "viem";
import { apiConfigured } from "../api";
import { liveData } from "./live";
import { getRemotePaymentLink, isRemoteLinkId, type LinkLookup, lookupRemotePaymentLink } from "./remote";
import type { PolarisData } from "./types";

export type * from "./types";
export { DAY, describeDuration, describeInterval, dueAt, quotePlan, WEEK } from "./quote";

/**
 * The one data source every screen reads through: the chain, and Polaris for
 * Business's records of chain events (`live.ts`). A build without
 * `NEXT_PUBLIC_POLARIS_API_URL` has no data at all: the app shows only that
 * Polaris isn't configured (components/not-configured.tsx).
 */
export const data: PolarisData = liveData;

export const getProfile = (owner: Address | null) => data.getProfile(owner);
export const getBalance = (owner: Address | null) => data.getBalance(owner);
export const getCreditLine = (owner: Address | null) => data.getCreditLine(owner);
export const getBoost = (owner: Address | null) => data.getBoost(owner);
export const getCreditGuard = () => data.getCreditGuard();
export const getPlans = (owner: Address | null) => data.getPlans(owner);
export const getActivity = (owner: Address | null) => data.getActivity(owner);
export const getContacts = (owner: Address | null) => data.getContacts(owner);
/** Checkout sessions (`cs_…`) and payment links (`pl_…`), from Polaris for Business. Anything else, or no API: no link. */
export const getPaymentLink = (id: string) => (apiConfigured() && isRemoteLinkId(id) ? getRemotePaymentLink(id) : Promise.resolve(null));
/** The same, with why there is no link (turned off, expired, used, not found), for the checkout's own words. */
export const lookupPaymentLink = (id: string): Promise<LinkLookup> =>
  apiConfigured() && isRemoteLinkId(id) ? lookupRemotePaymentLink(id) : Promise.resolve({ link: null, gone: "not_found" });
export type { LinkLookup } from "./remote";
export const getSendLink = (linkKey: Address) => data.getSendLink(linkKey);
export const getSplit = (id: Hex, viewer: Address | null) => data.getSplit(id, viewer);
export const getSplits = (owner: Address | null) => data.getSplits(owner);
