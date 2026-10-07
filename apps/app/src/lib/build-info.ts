import { type Address, zeroAddress } from "viem";

import type { env as appEnv } from "./env";

/**
 * What this build of the app was compiled with, as GET /api/health reports
 * it to scripts/deploy-check.mjs. Every value is public already (NEXT_PUBLIC_*
 * is inlined into the bundle every visitor downloads); the point is to read
 * it without parsing that bundle: that the dev signer and the local demo
 * switches are off, which Polaris for Business the app talks to, which chain,
 * and the WebAuthn relying party a Face ID account is tied to.
 */

export type BuildInfo = {
  service: "polaris-app";
  production: boolean;
  /** NEXT_PUBLIC_DEV_SIGNER: a key in browser storage instead of Face ID. A production build blanks it (next.config.ts). */
  devSigner: boolean;
  devSignerPersist: boolean;
  /** NEXT_PUBLIC_LOCAL_DEMO: pnpm demo:local's stand-in history wallet. */
  localDemo: boolean;
  /** The local faucet behind Add money (a local chain only). */
  localFaucet: boolean;
  target: "web" | "android";
  chainId: number;
  /** NEXT_PUBLIC_POLARIS_API_URL: Polaris for Business (the relayer, checkout sessions). Null: the offline demo. */
  apiUrl: string | null;
  /** NEXT_PUBLIC_RP_ID. Null: each page's own hostname. */
  rpId: string | null;
  /** NEXT_PUBLIC_PRIVY_APP_ID ("Continue with email"). Null: the option is hidden. */
  privyAppId: string | null;
  /** Contracts this build pins (NEXT_PUBLIC_*_ADDRESS); the rest come from the API's deployment record. */
  pinnedContracts: Partial<Record<keyof typeof appEnv.contracts, Address>>;
};

export type BuildInputs = {
  env: typeof appEnv;
  nodeEnv: string | undefined;
  devSignerPersist: string | undefined;
  localDemo: string | undefined;
  localFaucetUrl: string | undefined;
  buildTarget: string | undefined;
};

export function buildInfo(input: BuildInputs): BuildInfo {
  const { env } = input;
  const pinned = Object.entries(env.contracts).filter(([, address]) => address !== zeroAddress);
  return {
    service: "polaris-app",
    production: input.nodeEnv === "production",
    devSigner: env.devSigner,
    devSignerPersist: input.devSignerPersist === "1",
    localDemo: input.localDemo === "1",
    localFaucet: (env.chainId === 31337 || env.localChain === true) && Boolean(input.localFaucetUrl?.trim()),
    target: input.buildTarget === "android" ? "android" : "web",
    chainId: env.chainId,
    apiUrl: env.apiUrl ?? null,
    rpId: env.rpId ?? null,
    privyAppId: env.privyAppId ?? null,
    pinnedContracts: Object.fromEntries(pinned) as BuildInfo["pinnedContracts"],
  };
}
