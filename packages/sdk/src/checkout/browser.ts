import { BRAND_COLORS, markSvg } from "../brand.js";
import { PolarisError, configurationError } from "../errors.js";
import { parseCheckoutMessage } from "./protocol.js";
import type { CheckoutResult, CheckoutTarget } from "./types.js";

/**
 * Opening the hosted checkout: a centred popup on desktop, a full-page
 * redirect on phones, and the result back by postMessage.
 *
 * Everything here touches `window` only when called, never at import, so the
 * module is safe to import during server rendering.
 */

export const DEFAULT_CHECKOUT_ORIGIN = "https://pay.polarispay.app";
/** The Polaris app's dev server (`pnpm --filter app dev`). */
export const DEV_CHECKOUT_ORIGIN = "http://localhost:3000";

/** The hosted checkout closes itself 2.5 s after its receipt; past this, a completed popup still open is closed by the SDK. */
const COMPLETED_CLOSE_FALLBACK_MS = 3_500;

export type CheckoutDisplay = "auto" | "popup" | "redirect";

export type OpenCheckoutOptions = {
  /** "auto" (default): a popup on desktop, a redirect on phones and tablets. */
  display?: CheckoutDisplay;
  /** Give up after this long with `{ status: "timeout" }`. Default 30 minutes. */
  timeoutMs?: number;
  /** When the browser blocks the popup: "redirect" (default) navigates instead; "error" rejects with `popup_blocked`. */
  onBlocked?: "redirect" | "error";
  /** Dim the page with a "Finish paying in the Polaris window" panel while the popup is open. Default true. */
  overlay?: boolean;
  /** Popup size in CSS pixels. Default 440 × 760. */
  width?: number;
  height?: number;
  /** Close the checkout and resolve `{ status: "closed" }`. */
  signal?: AbortSignal;
  /** Called when the checkout page has loaded and is talking to this page. */
  onReady?: () => void;
};

/** A session, its id or URL, or a promise or function for one (e.g. a call to your server). */
export type CheckoutSource = CheckoutTarget | Promise<CheckoutTarget> | (() => CheckoutTarget | Promise<CheckoutTarget>);

/** The browser surface this module needs; injectable so tests don't need a real window manager. */
export type BrowserEnv = {
  window: Window;
  navigate(url: string): void;
};

function defaultEnv(): BrowserEnv {
  if (typeof window === "undefined") {
    throw configurationError(
      "no_browser",
      "The hosted checkout opens from a browser. On the server, create the session and send the buyer to session.url.",
    );
  }
  return { window, navigate: (url) => window.location.assign(url) };
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i;

/**
 * The checkout origin for a page: production, unless the page itself is
 * served from a local dev host, in which case the local Polaris app.
 */
export function defaultCheckoutOrigin(): string {
  const host = typeof location === "undefined" ? "" : location.hostname;
  return LOCAL_HOSTS.test(host) ? DEV_CHECKOUT_ORIGIN : DEFAULT_CHECKOUT_ORIGIN;
}

/** Validate and canonicalise a checkout origin ("https://pay.polarispay.app"). */
export function normaliseOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw configurationError("invalid_checkout_origin", `checkoutOrigin must be an origin like ${DEFAULT_CHECKOUT_ORIGIN}, got ${JSON.stringify(origin)}.`, "checkoutOrigin");
  }
  const local = LOCAL_HOSTS.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw configurationError("insecure_checkout_origin", "checkoutOrigin must use https (http is allowed only for localhost).", "checkoutOrigin");
  }
  return url.origin;
}

const SESSION_ID = /^[A-Za-z0-9_-]{3,128}$/;

/** Resolve a session, id or URL to the checkout URL, refusing any URL outside the checkout origin. */
export function resolveCheckoutUrl(target: CheckoutTarget, checkoutOrigin: string): { url: URL; sessionId: string | null } {
  let raw: string | null | undefined;
  let sessionId: string | null = null;

  if (typeof target === "string") {
    raw = target.trim();
  } else if (target && typeof target === "object" && typeof target.id === "string") {
    sessionId = target.id;
    raw = target.url ?? target.id;
  } else {
    throw new PolarisError("Pass a checkout session, its id, or its url.", { type: "checkout_error", code: "invalid_checkout_target" });
  }

  let url: URL;
  if (/^https?:\/\//i.test(raw)) {
    try {
      url = new URL(raw);
    } catch {
      throw new PolarisError(`Not a checkout URL: ${raw}`, { type: "checkout_error", code: "invalid_checkout_target" });
    }
    if (url.origin !== checkoutOrigin) {
      throw new PolarisError(
        `The checkout URL is on ${url.origin}, but this page trusts checkout results only from ${checkoutOrigin}. Set checkoutOrigin to match the API that created the session.`,
        { type: "checkout_error", code: "checkout_origin_mismatch" },
      );
    }
    sessionId ??= decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "") || null;
  } else {
    if (!SESSION_ID.test(raw)) {
      throw new PolarisError(`Not a checkout session id: ${JSON.stringify(raw)}`, { type: "checkout_error", code: "invalid_checkout_target" });
    }
    sessionId ??= raw;
    url = new URL(`/pay/${encodeURIComponent(raw)}`, checkoutOrigin);
  }
  return { url, sessionId };
}

/** Phones and tablets get a full-page redirect: popups there open as tabs, and in-app browsers block them. */
export function prefersRedirect(win: Window): boolean {
  const ua = win.navigator?.userAgent ?? "";
  if (/Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini|FBAN|FBAV|Instagram|Line\//i.test(ua)) return true;
  const coarse = typeof win.matchMedia === "function" && win.matchMedia("(pointer: coarse)").matches;
  const narrow = (win.innerWidth || 1024) < 640;
  return coarse && narrow;
}

function popupFeatures(win: Window, width: number, height: number): string {
  const outerWidth = win.outerWidth || width;
  const outerHeight = win.outerHeight || height;
  const left = Math.round((win.screenX || 0) + Math.max(0, (outerWidth - width) / 2));
  const top = Math.round((win.screenY || 0) + Math.max(0, (outerHeight - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

/** Evaluate a source without awaiting it when it's already concrete, so a popup can open inside the click. */
function evaluate(source: CheckoutSource): CheckoutTarget | Promise<CheckoutTarget> {
  const value = typeof source === "function" ? source() : source;
  return isThenable(value) ? Promise.resolve(value) : value;
}

export type CheckoutLauncher = {
  readonly checkoutOrigin: string;
  checkoutUrl(target: CheckoutTarget): string;
  redirectToCheckout(target: CheckoutTarget): void;
  openCheckout(source: CheckoutSource, options?: OpenCheckoutOptions): Promise<CheckoutResult>;
};

type Active = { popup: Window; promise: Promise<CheckoutResult> };

export function createCheckoutLauncher(config: { checkoutOrigin: string }, envFactory: () => BrowserEnv = defaultEnv): CheckoutLauncher {
  const checkoutOrigin = normaliseOrigin(config.checkoutOrigin);
  let active: Active | null = null;

  function checkoutUrl(target: CheckoutTarget): string {
    return resolveCheckoutUrl(target, checkoutOrigin).url.href;
  }

  function redirectToCheckout(target: CheckoutTarget): void {
    const env = envFactory();
    env.navigate(checkoutUrl(target));
  }

  function openCheckout(source: CheckoutSource, options: OpenCheckoutOptions = {}): Promise<CheckoutResult> {
    let env: BrowserEnv;
    try {
      env = envFactory();
    } catch (err) {
      return Promise.reject(err);
    }
    const win = env.window;
    const display = options.display ?? "auto";
    const redirect = display === "redirect" || (display === "auto" && prefersRedirect(win));

    // One checkout at a time: a second click brings the open one forward.
    if (active && !active.popup.closed) {
      try {
        active.popup.focus();
      } catch {
        /* cross-origin focus can throw in old browsers */
      }
      return active.promise;
    }

    let target: CheckoutTarget | Promise<CheckoutTarget>;
    try {
      target = evaluate(source);
    } catch (err) {
      return Promise.reject(err);
    }

    if (redirect) {
      return Promise.resolve(target).then((t) => {
        const { url, sessionId } = resolveCheckoutUrl(t, checkoutOrigin);
        env.navigate(url.href);
        return { status: "redirected", sessionId } as const;
      });
    }

    // A concrete target opens straight at the checkout. A pending one (a
    // session your server is still creating) opens a blank window now, while
    // the click still counts as a user gesture, and points it at the checkout
    // once the session exists. Opening after an await gets the popup blocked.
    let resolved: { url: URL; sessionId: string | null } | null = null;
    if (!isThenable(target)) {
      try {
        resolved = resolveCheckoutUrl(target, checkoutOrigin);
      } catch (err) {
        return Promise.reject(err);
      }
    }

    const width = options.width ?? 440;
    const height = options.height ?? 760;
    const opened = win.open(resolved ? withDisplay(resolved.url).href : "about:blank", "polaris_checkout", popupFeatures(win, width, height));

    if (!opened) {
      if ((options.onBlocked ?? "redirect") === "error") {
        return Promise.reject(
          new PolarisError("The browser blocked the checkout window. Call openCheckout from a click handler, or use redirectToCheckout.", {
            type: "checkout_error",
            code: "popup_blocked",
          }),
        );
      }
      return Promise.resolve(target).then((t) => {
        const { url, sessionId } = resolveCheckoutUrl(t, checkoutOrigin);
        env.navigate(url.href);
        return { status: "redirected", sessionId } as const;
      });
    }
    const popup: Window = opened;

    if (!resolved) writeLoadingPage(popup);

    const promise = new Promise<CheckoutResult>((resolve, reject) => {
      let sessionId: string | null = resolved?.sessionId ?? null;
      let done = false;
      let closedTimer: ReturnType<typeof setTimeout> | undefined;
      const overlay = options.overlay === false ? null : showOverlay(win, {
        focusCheckout: () => {
          try {
            popup.focus();
          } catch {
            /* ignore */
          }
        },
        cancel: () => finish({ status: "closed", sessionId }),
      });

      function cleanup() {
        win.removeEventListener("message", onMessage);
        clearInterval(poll);
        clearTimeout(timeout);
        clearTimeout(closedTimer);
        options.signal?.removeEventListener("abort", onAbort);
        overlay?.remove();
        if (active?.popup === popup) active = null;
      }

      function finish(result: CheckoutResult) {
        if (done) return;
        done = true;
        cleanup();
        const close = () => {
          try {
            if (!popup.closed) popup.close();
          } catch {
            /* ignore */
          }
        };
        // A completed checkout shows its receipt for a moment and closes itself
        // (after 2.5 s); closing it at once would cut that off. Close it here only
        // if it is still open well after that.
        if (result.status === "completed") setTimeout(close, COMPLETED_CLOSE_FALLBACK_MS);
        else close();
        resolve(result);
      }

      function fail(err: unknown) {
        if (done) return;
        done = true;
        cleanup();
        try {
          popup.close();
        } catch {
          /* ignore */
        }
        reject(err);
      }

      function onMessage(event: MessageEvent) {
        // Only the window we opened, served from the checkout origin.
        if (event.origin !== checkoutOrigin || event.source !== popup) return;
        const parsed = parseCheckoutMessage(event.data);
        if (!parsed) return;
        if (parsed.sessionId && sessionId && parsed.sessionId !== sessionId && isV1(event.data)) return;
        if (parsed.kind === "ready") {
          options.onReady?.();
          return;
        }
        finish(parsed.result);
      }

      function onAbort() {
        finish({ status: "closed", sessionId });
      }

      win.addEventListener("message", onMessage);
      options.signal?.addEventListener("abort", onAbort, { once: true });

      // A closed window is "closed", after a short grace period: a checkout
      // that posts its result and closes itself must not lose the race to
      // this poll.
      const poll = setInterval(() => {
        if (done || closedTimer || !popup.closed) return;
        closedTimer = setTimeout(() => finish({ status: "closed", sessionId }), 300);
      }, 400);

      const timeout = setTimeout(() => finish({ status: "timeout", sessionId }), options.timeoutMs ?? 30 * 60_000);
      if (options.signal?.aborted) onAbort();

      if (!resolved) {
        (target as Promise<CheckoutTarget>).then(
          (t) => {
            if (done) return;
            try {
              const next = resolveCheckoutUrl(t, checkoutOrigin);
              sessionId = next.sessionId;
              popup.location.replace(withDisplay(next.url).href);
            } catch (err) {
              fail(err);
            }
          },
          (err: unknown) => fail(err),
        );
      }
    });

    active = { popup, promise };
    return promise;
  }

  return { checkoutOrigin, checkoutUrl, redirectToCheckout, openCheckout };
}

function isV1(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === "polaris:checkout";
}

/** Tell the checkout it's in a popup, so it posts its result and closes instead of redirecting. */
function withDisplay(url: URL): URL {
  const next = new URL(url.href);
  next.searchParams.set("display", "popup");
  return next;
}

/** The blank popup's placeholder while your server creates the session. Same-origin until it navigates. */
function writeLoadingPage(popup: Window): void {
  try {
    const doc = popup.document;
    doc.open();
    doc.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Polaris checkout</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:${BRAND_COLORS.ink};color:${BRAND_COLORS.text};font:500 15px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{display:grid;justify-items:center;gap:18px}
svg{animation:p 1.4s ease-in-out infinite}
p{margin:0;color:${BRAND_COLORS.muted}}
@keyframes p{50%{transform:scale(.88);opacity:.7}}
@media (prefers-reduced-motion:reduce){svg{animation:none}}
</style></head><body><main role="status" aria-live="polite">${markSvg(56)}<p>Opening Polaris checkout…</p></main></body></html>`);
    doc.close();
  } catch {
    /* Some browsers don't allow writing into the popup; it stays blank until it navigates. */
  }
}

type Overlay = { remove(): void };

/**
 * The page-level panel shown while the checkout popup is open. It keeps the
 * buyer from paying twice, and brings the popup back when it falls behind.
 * Inline styles only: nothing for the merchant to import or collide with.
 */
function showOverlay(win: Window, actions: { focusCheckout(): void; cancel(): void }): Overlay | null {
  const doc = win.document;
  if (!doc?.body) return null;

  const previouslyFocused = doc.activeElement as HTMLElement | null;
  const root = doc.createElement("div");
  root.setAttribute("data-polaris-checkout-overlay", "");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "polaris-overlay-title");
  root.setAttribute("aria-describedby", "polaris-overlay-text");
  root.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483000",
    "display:grid",
    "place-items:center",
    "padding:24px",
    "background:rgba(10,10,11,.72)",
    "backdrop-filter:blur(6px)",
    "-webkit-backdrop-filter:blur(6px)",
    "font-family:var(--polaris-font,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif)",
  ].join(";");

  const card = doc.createElement("div");
  card.style.cssText = [
    "display:grid",
    "justify-items:center",
    "gap:14px",
    "max-width:380px",
    "text-align:center",
    `color:${BRAND_COLORS.text}`,
  ].join(";");

  const mark = doc.createElement("div");
  mark.innerHTML = markSvg(48);

  const title = doc.createElement("h2");
  title.id = "polaris-overlay-title";
  title.textContent = "Finish paying in the Polaris window";
  title.style.cssText = "margin:0;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em;color:inherit";

  const text = doc.createElement("p");
  text.id = "polaris-overlay-text";
  text.textContent = "Don't see it? Bring it back and pick up where you left off.";
  text.style.cssText = `margin:0;font-size:14px;line-height:1.5;color:${BRAND_COLORS.muted}`;

  const resume = doc.createElement("button");
  resume.type = "button";
  resume.textContent = "Continue to Polaris";
  resume.style.cssText = [
    "margin-top:6px",
    "min-height:48px",
    "padding:0 26px",
    "border:0",
    "border-radius:999px",
    `background:var(--polaris-accent,${BRAND_COLORS.limeCta})`,
    `color:var(--polaris-accent-fg,${BRAND_COLORS.ink})`,
    "font:inherit",
    "font-size:15px",
    "font-weight:600",
    "cursor:pointer",
  ].join(";");

  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel payment";
  cancel.style.cssText = [
    "min-height:40px",
    "padding:0 16px",
    "border:0",
    "border-radius:999px",
    "background:transparent",
    `color:${BRAND_COLORS.muted}`,
    "font:inherit",
    "font-size:14px",
    "text-decoration:underline",
    "text-underline-offset:3px",
    "cursor:pointer",
  ].join(";");

  resume.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.focusCheckout();
  });
  cancel.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.cancel();
  });
  root.addEventListener("click", (e) => {
    if (e.target === root) actions.focusCheckout();
  });
  // Keep keyboard focus inside the panel while it's up.
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    (doc.activeElement === resume ? cancel : resume).focus();
  });

  card.append(mark, title, text, resume, cancel);
  root.append(card);
  doc.body.append(root);
  resume.focus();

  return {
    remove() {
      root.remove();
      try {
        previouslyFocused?.focus?.();
      } catch {
        /* ignore */
      }
    },
  };
}
