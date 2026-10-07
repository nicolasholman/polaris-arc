import { MONAD, MONAD_TESTNET, SEPOLIA, assertDeployed, resolveChain, type PolarisChain, type PolarisContracts } from "./chains.js";
import {
  createCheckoutLauncher,
  defaultCheckoutOrigin,
  type BrowserEnv,
  type CheckoutSource,
  type OpenCheckoutOptions,
} from "./checkout/browser.js";
import type { CheckoutResult, CheckoutTarget } from "./checkout/types.js";
import { requirePublishableKey } from "./keys.js";
import type { CreditProfile, LegacyMethods } from "./legacy.js";
import { quotePayIn4, type AmountInput, type PayIn4Options, type PayIn4Quote } from "./money.js";
import type { PayParams, PayResult, Result } from "./pay/direct.js";
import { splitLink, type SplitLinkParams } from "./splits.js";
import type { Address, Eip1193Provider, Hex } from "./types.js";

/**
 * The browser client.
 *
 *   const polaris = createPolaris({ publishableKey: "pk_test_…" });
 *   const result = await polaris.openCheckout(session);          // hosted checkout in a popup
 *   const paid = await polaris.pay({ merchant, amount, orderId }); // direct wallet pay
 *
 * Nothing here needs a secret key, and nothing loads ethers until a wallet
 * method is called: a page that only opens the hosted checkout stays small.
 */

export type PolarisOptions = {
  /** Your publishable key (pk_test_… or pk_live_…). Test keys default to Monad testnet, live keys to Monad. */
  publishableKey?: string;
  /** Chain preset: MONAD_TESTNET, MONAD, or your own. Overrides the key's default. */
  chain?: PolarisChain | PolarisContracts;
  /** 0.2 name for `chain`. */
  contracts?: PolarisChain | PolarisContracts;
  /**
   * Where the hosted checkout lives. Default https://pay.polarispay.app, or
   * http://localhost:3000 when this page is itself served from localhost.
   * Results are accepted only from this origin.
   */
  checkoutOrigin?: string;
  /**
   * The gasless relay for `pay()`: POST endpoint that submits the buyer's
   * signed authorization (see RelayPayRequest). Without it the buyer's wallet
   * sends the transaction and pays the gas.
   */
  relayUrl?: string;
  /** EIP-1193 provider for wallet methods. Defaults to `window.ethereum`. */
  provider?: Eip1193Provider | unknown;
  /** Read-only RPC for `getCredit`, so a badge can render before the buyer connects. */
  rpcUrl?: string;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** 0.2: merchant API key forwarded to your `endpoint` by `payLater`. */
  apiKey?: string;
  /** 0.2: your endpoint that opens a plan. Default /api/checkout. */
  endpoint?: string;
};

export interface Polaris {
  readonly chain: PolarisChain;
  /** 0.2 alias of `chain`. */
  readonly contracts: PolarisChain;
  readonly publishableKey: string | undefined;
  readonly livemode: boolean;
  readonly checkoutOrigin: string;

  /** The hosted checkout URL for a session, id or URL. */
  checkoutUrl(target: CheckoutTarget): string;
  /** Send this page to the hosted checkout. The buyer comes back to the session's successUrl. */
  redirectToCheckout(target: CheckoutTarget): void;
  /**
   * Open the hosted checkout in a centred popup (a full-page redirect on
   * phones) and resolve with its result. Call it from a click handler. The
   * result is a UI hint: fulfil from the webhook.
   */
  openCheckout(source: CheckoutSource, options?: OpenCheckoutOptions): Promise<CheckoutResult>;

  /** Pay a merchant directly from the buyer's wallet: one signature, gasless with a `relayUrl`. */
  pay(params: PayParams): Promise<PayResult>;
  /** The payment recorded on chain for an order, or null: check payer and amount before fulfilling. */
  getPayment(params: { merchant: string; orderId: string }): Promise<{
    paymentId: Hex;
    payer: Address;
    merchant: Address;
    amount: string;
    paidAt: Date;
  } | null>;
  /** Price Pay in 4 for an amount, as the loan engine will. */
  quote(amount: AmountInput, options?: PayIn4Options): PayIn4Quote;

  /**
   * Split-the-bill links. A split is the organiser's own request (their Face
   * ID opens it), so an app hands them the Polaris app's "Split a bill"
   * screen filled in; nothing is created until they confirm there.
   */
  splits: {
    /** `${checkoutOrigin}/split/new?…`, filled in with the bill and how to split it. */
    link(params: SplitLinkParams): string;
    /** Open that screen in a new tab. Call it from a click handler. */
    open(params: SplitLinkParams): void;
  };

  /** 0.2 wallet methods (the buyer holds gas). */
  subscribe(p: { planId: number | bigint }): Promise<Result>;
  cancelSubscription(p: { subscriptionId: number | bigint }): Promise<Result>;
  payLater(p: { amount: string; orderId: string; installments?: number; intervalSeconds?: number }): Promise<Result & { loanId?: string }>;
  lockCollateral(p: { amount: string }): Promise<Result>;
  withdrawCollateral(p: { amount: string }): Promise<Result>;
  getCredit(address?: string): Promise<CreditProfile>;
  canPayLater(amount: string): Promise<{ eligible: boolean; limit: string; symbol: string }>;
}

let warnedSepolia = false;

function pickChain(options: PolarisOptions, livemode: boolean): { chain: PolarisChain; legacyDefault: boolean } {
  const explicit = options.chain ?? options.contracts;
  if (explicit) return { chain: resolveChain(explicit), legacyDefault: false };
  if (options.publishableKey) return { chain: livemode ? MONAD : MONAD_TESTNET, legacyDefault: false };
  // 0.2 compatibility: no key and no chain meant the Sepolia deployment.
  return { chain: SEPOLIA, legacyDefault: true };
}

/** Said once, and only when a wallet method actually runs on the fallback: checkout-only pages never see it. */
function warnLegacyDefault(): void {
  if (warnedSepolia || typeof console === "undefined") return;
  warnedSepolia = true;
  console.warn(
    "polarispay-sdk: createPolaris() without a publishableKey or chain targets the 0.2 Sepolia deployment. " +
      "Pass publishableKey (Monad) or chain: MONAD_TESTNET. This fallback goes away in 0.4.",
  );
}

/** @internal Test seam: swap the browser environment the checkout launcher uses. */
export type ClientInternals = { env?: () => BrowserEnv };

export function createPolaris(options: PolarisOptions = {}, internals: ClientInternals = {}): Polaris {
  const key = options.publishableKey ? requirePublishableKey(options.publishableKey) : null;
  const livemode = key?.livemode ?? false;
  const { chain, legacyDefault } = pickChain(options, livemode);
  const launcher = createCheckoutLauncher({ checkoutOrigin: options.checkoutOrigin ?? defaultCheckoutOrigin() }, internals.env);

  let legacy: Promise<LegacyMethods> | undefined;
  function loadLegacy(): Promise<LegacyMethods> {
    if (legacyDefault) warnLegacyDefault();
    legacy ??= import("./legacy.js").then((m) =>
      m.createLegacyMethods({ chain, provider: options.provider, rpcUrl: options.rpcUrl, apiKey: options.apiKey, endpoint: options.endpoint }),
    );
    return legacy;
  }

  async function provider(): Promise<Eip1193Provider> {
    const { findProvider } = await import("./pay/wallet.js");
    return findProvider(options.provider);
  }

  return {
    chain,
    contracts: chain,
    publishableKey: options.publishableKey,
    livemode,
    checkoutOrigin: launcher.checkoutOrigin,

    checkoutUrl: launcher.checkoutUrl,
    redirectToCheckout: launcher.redirectToCheckout,
    openCheckout: launcher.openCheckout,

    async pay(params) {
      if (!chain.features.payWithAuthorization) {
        // The 0.2 deployment: approve, then pay.
        return (await loadLegacy()).payWithApproval({ ...params, amount: String(params.amount) });
      }
      // An undeployed contract is a setup mistake and throws; a missing wallet is the buyer's situation and returns.
      assertDeployed(chain, ["payments", "stablecoin"]);
      const { payWithAuthorization } = await import("./pay/direct.js");
      let wallet: Eip1193Provider;
      try {
        wallet = await provider();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), cause: err };
      }
      return payWithAuthorization(
        { chain, provider: wallet, relayUrl: options.relayUrl, publishableKey: options.publishableKey, fetch: options.fetch },
        params,
      );
    },

    async getPayment({ merchant, orderId }) {
      const [{ readPayment }, wallet] = await Promise.all([import("./pay/direct.js"), provider()]);
      return readPayment(wallet, chain, merchant, orderId);
    },

    quote: (amount, quoteOptions) => quotePayIn4(amount, quoteOptions),

    splits: {
      link: (params) => splitLink(launcher.checkoutOrigin, params),
      open(params) {
        const url = splitLink(launcher.checkoutOrigin, params);
        const g = globalThis as { open?: (url: string, target: string, features: string) => unknown };
        if (typeof g.open !== "function") throw new Error("splits.open runs in a browser; use splits.link on the server.");
        g.open(url, "_blank", "noopener");
      },
    },

    subscribe: async (p) => (await loadLegacy()).subscribe(p),
    cancelSubscription: async (p) => (await loadLegacy()).cancelSubscription(p),
    payLater: async (p) => (await loadLegacy()).payLater(p),
    lockCollateral: async (p) => (await loadLegacy()).lockCollateral(p),
    withdrawCollateral: async (p) => (await loadLegacy()).withdrawCollateral(p),
    getCredit: async (address) => (await loadLegacy()).getCredit(address),
    canPayLater: async (amount) => (await loadLegacy()).canPayLater(amount),
  };
}
