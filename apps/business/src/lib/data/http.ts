import type { ChainlinkOverview } from "./chainlink";
import type { CreditGuard } from "./guard";
import { DataError, isSessionEnded, type DashboardData, type PayoutRun } from "./source";
import type {
  ApiKey,
  Capabilities,
  AutoPayouts,
  CreatedApiKey,
  CreatedWebhookEndpoint,
  Merchant,
  Overview,
  Payment,
  PaymentLink,
  Payout,
  PayoutsState,
  Plan,
  RegistrationStep,
  WebhookDelivery,
  WebhookEndpoint,
  WebhooksState,
} from "./types";

/** GET /api/health, as the server sends it (it holds no secrets). */
type Health = {
  chain: { id: number; name: string } | null;
  relayer: { mode: string; address: string | null };
  activator: string;
  automaticPayouts: boolean;
  checkoutOrigin: string | null;
  publicUrl?: string | null;
};

type TokenSource = () => Promise<string | null>;

export type HttpDataOptions = {
  /**
   * Called once when the API says the session is over (401 unauthenticated
   * or invalid_token): sign out and go to /login. The call still rejects.
   */
  onSessionEnded?: (error: DataError) => void;
};

/**
 * `DashboardData` over our API routes.
 *
 * Every request carries the Privy access token as a Bearer token. The server
 * derives the merchant and their wallet from that token alone; nothing here
 * sends an address or an ID the server would have to trust.
 */
export function createHttpData(getAccessToken: TokenSource, options: HttpDataOptions = {}): DashboardData {
  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await getAccessToken().catch(() => null);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(path, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      throw new DataError("We couldn't reach Polaris. Check your connection and try again.", 0, "network");
    }

    const payload = (await res.json().catch(() => null)) as
      | { data?: T; error?: { code?: string; message?: string; param?: string; field?: string } }
      | null;

    if (!res.ok) {
      const error = new DataError(
        payload?.error?.message ?? `The request failed (${res.status}).`,
        res.status,
        payload?.error?.code ?? "http_error",
        payload?.error?.param ?? payload?.error?.field,
      );
      if (isSessionEnded(error)) options.onSessionEnded?.(error);
      throw error;
    }
    if (!payload || !("data" in payload)) {
      throw new DataError("The response was empty.", res.status, "empty");
    }
    return payload.data as T;
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    getCapabilities: async () => {
      const h = await call<Health>("/api/health");
      return {
        chain: h.chain ? { id: h.chain.id, name: h.chain.name } : null,
        relayer: h.relayer.mode !== "off" && Boolean(h.relayer.address),
        automaticPayouts: h.automaticPayouts,
        activation: h.activator !== "off",
        checkoutOrigin: h.checkoutOrigin,
        registrationUrl: h.publicUrl !== null,
      } satisfies Capabilities;
    },
    getMerchant: () => call<Merchant>("/api/me"),
    updateMerchant: (input) => call<Merchant>("/api/me", { method: "POST", body: input }),
    getRegistration: () => call<RegistrationStep>("/api/merchant/registration"),
    submitRegistration: (input) => call<{ merchant: Merchant }>("/api/merchant/registration", { method: "POST", body: input }),
    getOverview: () => call<Overview>("/api/overview"),
    getChainlink: () => call<ChainlinkOverview>("/api/chainlink"),
    getCreditGuard: () => call<CreditGuard>("/api/public/credit-guard"),
    listLinks: () => call<PaymentLink[]>("/api/links"),
    createLink: (input) => call<PaymentLink>("/api/links", { method: "POST", body: input }),
    deactivateLink: (linkId) => call<PaymentLink>(`/api/links/${id(linkId)}`, { method: "PATCH", body: { active: false } }),
    listPayments: () => call<Payment[]>("/api/payments"),
    listPlans: () => call<Plan[]>("/api/plans"),
    getPayouts: () => call<PayoutsState>("/api/payouts"),
    withdraw: (input) => call<Payout>("/api/payouts", { method: "POST", body: input }),
    setAutoPayouts: (input) => call<AutoPayouts>("/api/payouts/automatic", { method: "POST", body: input }),
    payoutNow: () => call<PayoutRun>("/api/payouts/automatic/run", { method: "POST" }),
    listApiKeys: () => call<ApiKey[]>("/api/keys"),
    createApiKey: (input) => call<CreatedApiKey>("/api/keys", { method: "POST", body: input }),
    revokeApiKey: (keyId) => call<ApiKey>(`/api/keys/${id(keyId)}`, { method: "DELETE" }),
    listWebhooks: () => call<WebhooksState>("/api/webhooks"),
    createWebhook: (input) => call<CreatedWebhookEndpoint>("/api/webhooks", { method: "POST", body: input }),
    deleteWebhook: (endpointId) => call<WebhookEndpoint>(`/api/webhooks/${id(endpointId)}`, { method: "DELETE" }),
    sendTestEvent: (endpointId) => call<WebhookDelivery>(`/api/webhooks/${id(endpointId)}/test`, { method: "POST" }),
    retryDelivery: (deliveryId) => call<WebhookDelivery>(`/api/webhooks/deliveries/${id(deliveryId)}/retry`, { method: "POST" }),
  };
}
