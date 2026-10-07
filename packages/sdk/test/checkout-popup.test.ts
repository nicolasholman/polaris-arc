// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCheckoutLauncher, defaultCheckoutOrigin, prefersRedirect, resolveCheckoutUrl, type BrowserEnv } from "../src/checkout/browser.js";
import { createCheckoutMessage } from "../src/checkout/protocol.js";
import { createPolaris } from "../src/client.js";
import { createPolarisServer } from "../src/server/client.js";

const ORIGIN = "https://pay.polarispay.app";
const SESSION = "cs_test_a1B2c3D4e5F6g7H8";

/** A stand-in for the checkout window: closable, focusable, navigable. */
function fakePopup() {
  const popup = {
    closed: false,
    focus: vi.fn(),
    close: vi.fn(() => {
      popup.closed = true;
    }),
    location: { replace: vi.fn() },
    document: document.implementation.createHTMLDocument("popup"),
  };
  return popup;
}

type Popup = ReturnType<typeof fakePopup>;

function setup(opts: { blocked?: boolean; userAgent?: string } = {}) {
  const popup = fakePopup();
  const open = vi.fn(() => (opts.blocked ? null : (popup as unknown as Window)));
  const navigate = vi.fn();
  const win = window as Window;
  vi.spyOn(win, "open").mockImplementation(open as never);
  if (opts.userAgent) vi.spyOn(win.navigator, "userAgent", "get").mockReturnValue(opts.userAgent);
  const env: BrowserEnv = { window: win, navigate };
  const launcher = createCheckoutLauncher({ checkoutOrigin: ORIGIN }, () => env);
  return { launcher, popup, open, navigate };
}

/** Deliver a postMessage as the browser would: with an origin and a source window. */
function post(data: unknown, from: { origin?: string; source?: unknown } = {}) {
  const event = new Event("message") as MessageEvent;
  Object.defineProperty(event, "data", { value: data });
  Object.defineProperty(event, "origin", { value: from.origin ?? ORIGIN });
  Object.defineProperty(event, "source", { value: from.source ?? null });
  window.dispatchEvent(event);
}

const completed = (popup: Popup, extra = {}) =>
  post(
    createCheckoutMessage("completed", SESSION, {
      mode: "later",
      orderId: "INV-2041",
      txHash: "0xabababababababababababababababababababababababababababababababab",
      planId: "17",
      ...extra,
    }),
    { source: popup },
  );

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveCheckoutUrl", () => {
  it("builds the hosted checkout URL from a session id", () => {
    expect(resolveCheckoutUrl(SESSION, ORIGIN)).toEqual({ url: new URL(`${ORIGIN}/pay/${SESSION}`), sessionId: SESSION });
  });

  it("takes a session object's url, and its id", () => {
    const r = resolveCheckoutUrl({ id: SESSION, url: `${ORIGIN}/pay/${SESSION}` }, ORIGIN);
    expect(r.url.href).toBe(`${ORIGIN}/pay/${SESSION}`);
    expect(r.sessionId).toBe(SESSION);
  });

  it("refuses a URL outside the checkout origin: results from it wouldn't be trusted", () => {
    expect(() => resolveCheckoutUrl("https://evil.example/pay/cs_test_x", ORIGIN)).toThrow(/checkoutOrigin/);
    expect(() => resolveCheckoutUrl("../../keys", ORIGIN)).toThrow(/session id/);
  });

  it("defaults to the local Polaris app when the page is on localhost", () => {
    expect(window.location.hostname).toBe("localhost");
    expect(defaultCheckoutOrigin()).toBe("http://localhost:3000");
  });
});

describe("openCheckout", () => {
  it("opens a centred popup and resolves with the completed result, leaving the receipt up for a moment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { launcher, popup, open } = setup();
    const promise = launcher.openCheckout(SESSION);

    expect(open).toHaveBeenCalledTimes(1);
    const [url, name, features] = open.mock.calls[0] as unknown as [string, string, string];
    expect(url).toBe(`${ORIGIN}/pay/${SESSION}?display=popup`);
    expect(name).toBe("polaris_checkout");
    expect(features).toMatch(/popup=yes,width=440,height=760,left=\d+,top=\d+/);
    expect(document.querySelector("[data-polaris-checkout-overlay]")).not.toBeNull();

    completed(popup);
    await expect(promise).resolves.toEqual({
      status: "completed",
      sessionId: SESSION,
      mode: "later",
      orderId: "INV-2041",
      txHash: "0xabababababababababababababababababababababababababababababababab",
      paymentId: null,
      planId: "17",
      subscriptionId: null,
    });
    expect(document.querySelector("[data-polaris-checkout-overlay]")).toBeNull();
    // The checkout closes itself after its receipt; the SDK only makes sure, later.
    expect(popup.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_500);
    expect(popup.close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores messages from another origin, another window, or another session", async () => {
    const { launcher, popup } = setup();
    const promise = launcher.openCheckout(SESSION, { timeoutMs: 5_000 });
    const settled = vi.fn();
    void promise.then(settled);

    completed(popup, {});
    // (that one was genuine; re-arm with a fresh launcher for the negatives)
    await promise;

    const second = setup();
    const p2 = second.launcher.openCheckout(SESSION, { timeoutMs: 5_000 });
    const done = vi.fn();
    void p2.then(done);
    post(createCheckoutMessage("completed", SESSION, { mode: "now" }), { origin: "https://evil.example", source: second.popup });
    post(createCheckoutMessage("completed", SESSION, { mode: "now" }), { origin: ORIGIN, source: window });
    post(createCheckoutMessage("completed", "cs_test_someoneElse1", { mode: "now" }), { source: second.popup });
    post({ type: "polaris:checkout", version: 2, event: "completed", sessionId: SESSION, mode: "now" }, { source: second.popup });
    post("polaris:checkout", { source: second.popup });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled();

    completed(second.popup);
    await expect(p2).resolves.toMatchObject({ status: "completed" });
  });

  it("calls onReady when the checkout says hello, without finishing", async () => {
    const { launcher, popup } = setup();
    const onReady = vi.fn();
    const promise = launcher.openCheckout(SESSION, { onReady });
    post(createCheckoutMessage("ready", SESSION), { source: popup });
    expect(onReady).toHaveBeenCalledTimes(1);
    post(createCheckoutMessage("canceled", SESSION), { source: popup });
    await expect(promise).resolves.toEqual({ status: "canceled", sessionId: SESSION });
  });

  it("understands the first checkout's polaris:payment message", async () => {
    const { launcher, popup } = setup();
    const promise = launcher.openCheckout(SESSION);
    post({ type: "polaris:payment", status: "paid", linkId: "lnk_1", orderId: "ord_1", mode: "subscription", txHash: "0x12" }, { source: popup });
    await expect(promise).resolves.toMatchObject({ status: "completed", mode: "subscribe", orderId: "ord_1", txHash: "0x12" });
  });

  it("resolves closed when the buyer closes the window (after a grace period for a late result)", async () => {
    const { launcher, popup } = setup();
    const promise = launcher.openCheckout(SESSION);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(450);
    // A result that arrives inside the grace period still wins.
    completed(popup);
    await expect(promise).resolves.toMatchObject({ status: "completed" });

    const again = setup();
    const p2 = again.launcher.openCheckout(SESSION);
    again.popup.closed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p2).resolves.toEqual({ status: "closed", sessionId: SESSION });
  });

  it("times out, closing the window", async () => {
    const { launcher, popup } = setup();
    const promise = launcher.openCheckout(SESSION, { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(promise).resolves.toEqual({ status: "timeout", sessionId: SESSION });
    expect(popup.close).toHaveBeenCalled();
  });

  it("closes on abort", async () => {
    const { launcher, popup } = setup();
    const controller = new AbortController();
    const promise = launcher.openCheckout(SESSION, { signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toEqual({ status: "closed", sessionId: SESSION });
    expect(popup.close).toHaveBeenCalled();
  });

  it("falls back to a redirect when the popup is blocked", async () => {
    const { launcher, navigate } = setup({ blocked: true });
    await expect(launcher.openCheckout(SESSION)).resolves.toEqual({ status: "redirected", sessionId: SESSION });
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/pay/${SESSION}`);
  });

  it("or rejects with popup_blocked when asked to", async () => {
    const { launcher, navigate } = setup({ blocked: true });
    await expect(launcher.openCheckout(SESSION, { onBlocked: "error" })).rejects.toMatchObject({ code: "popup_blocked" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("redirects full-screen on phones", async () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const { launcher, open, navigate } = setup({ userAgent: iphone });
    expect(prefersRedirect(window)).toBe(true);
    await expect(launcher.openCheckout({ id: SESSION, url: `${ORIGIN}/pay/${SESSION}` })).resolves.toMatchObject({ status: "redirected" });
    expect(open).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/pay/${SESSION}`);
  });

  it("opens the window inside the click, then points it at a session created asynchronously", async () => {
    const { launcher, popup, open } = setup();
    let resolveSession!: (s: { id: string; url: string }) => void;
    const createSession = () => new Promise<{ id: string; url: string }>((r) => (resolveSession = r));

    const promise = launcher.openCheckout(createSession);
    // Synchronously, before the session exists: a blank window with a loading page.
    expect(open).toHaveBeenCalledWith("about:blank", "polaris_checkout", expect.any(String));
    expect(popup.document.body.textContent).toContain("Opening Polaris checkout");

    resolveSession({ id: SESSION, url: `${ORIGIN}/pay/${SESSION}` });
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.location.replace).toHaveBeenCalledWith(`${ORIGIN}/pay/${SESSION}?display=popup`);

    completed(popup);
    await expect(promise).resolves.toMatchObject({ status: "completed", sessionId: SESSION });
  });

  it("closes the window and rejects when creating the session fails", async () => {
    const { launcher, popup } = setup();
    const promise = launcher.openCheckout(() => Promise.reject(new Error("your server said no")));
    await expect(promise).rejects.toThrow("your server said no");
    expect(popup.close).toHaveBeenCalled();
    expect(document.querySelector("[data-polaris-checkout-overlay]")).toBeNull();
  });

  it("brings an open checkout forward instead of opening a second", async () => {
    const { launcher, popup, open } = setup();
    const first = launcher.openCheckout(SESSION);
    const second = launcher.openCheckout(SESSION);
    expect(second).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalled();
    completed(popup);
    await first;
  });

  it("offers Continue and Cancel on the page overlay", async () => {
    const { launcher, popup } = setup();
    const promise = launcher.openCheckout(SESSION);
    const overlay = document.querySelector<HTMLElement>("[data-polaris-checkout-overlay]")!;
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    const [resume, cancel] = Array.from(overlay.querySelectorAll("button"));
    expect(document.activeElement).toBe(resume);
    resume!.click();
    expect(popup.focus).toHaveBeenCalled();
    cancel!.click();
    await expect(promise).resolves.toEqual({ status: "closed", sessionId: SESSION });
    expect(popup.close).toHaveBeenCalled();
  });

  it("can skip the overlay", async () => {
    const { launcher, popup } = setup();
    const promise = launcher.openCheckout(SESSION, { overlay: false });
    expect(document.querySelector("[data-polaris-checkout-overlay]")).toBeNull();
    completed(popup);
    await promise;
  });

  it("redirectToCheckout navigates this page", () => {
    const { launcher, navigate } = setup();
    launcher.redirectToCheckout(SESSION);
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/pay/${SESSION}`);
  });
});

describe("createPolaris in the browser", () => {
  it("wires the launcher to the configured checkout origin", async () => {
    const popup = fakePopup();
    const navigate = vi.fn();
    vi.spyOn(window, "open").mockImplementation((() => popup) as never);
    const polaris = createPolaris(
      { publishableKey: "pk_test_51Hx8yQfT3sLk2Pz", checkoutOrigin: "http://localhost:3000" },
      { env: () => ({ window, navigate }) },
    );
    expect(polaris.checkoutOrigin).toBe("http://localhost:3000");
    expect(polaris.checkoutUrl(SESSION)).toBe(`http://localhost:3000/pay/${SESSION}`);
    const promise = polaris.openCheckout(SESSION);
    post(createCheckoutMessage("expired", SESSION), { origin: "http://localhost:3000", source: popup });
    await expect(promise).resolves.toEqual({ status: "expired", sessionId: SESSION });
  });

  it("refuses a secret key in the browser", () => {
    expect(() => createPolaris({ publishableKey: "sk_test_51Hx8yQfT3sLk2Pz" })).toThrow(/Never ship it to a browser/);
  });

  it("refuses to build the server client in a browser", () => {
    expect(() => createPolarisServer({ secretKey: "sk_test_51Hx8yQfT3sLk2Pz", baseUrl: "http://localhost:3100" })).toThrow(/server only/);
  });
});
