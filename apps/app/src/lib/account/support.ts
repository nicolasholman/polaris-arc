import { env } from "../env";
import { tryRpId } from "./rp";

export type AccountSupport =
  /** Worth trying the Face ID ceremony. Only the ceremony gives a definite yes. */
  | { ok: true }
  /** Definitely not here. Show "Open Polaris on your phone". */
  | { ok: false; reason: "no-webauthn" | "no-prf" | "insecure" | "host" };

/**
 * Mera ships no capability check, so this is the best a page can do before a
 * ceremony. "No" is definitive; "yes" means try, and a `PRF_UNAVAILABLE` from
 * the ceremony still routes to the same "Open on your phone" screen (desktop
 * Chrome's local profile, for one, reports PRF and then can't do it).
 *
 * `extension:prf` counts as a "no" only when the browser says `false`
 * outright: WebAuthn L3 lets browsers omit keys they do support.
 */
export async function checkAccountSupport(): Promise<AccountSupport> {
  if (env.devSigner) return { ok: true };
  if (typeof window === "undefined") return { ok: false, reason: "no-webauthn" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };
  if (tryRpId() === null) return { ok: false, reason: "host" };
  if (typeof window.PublicKeyCredential === "undefined") return { ok: false, reason: "no-webauthn" };
  const PKC = window.PublicKeyCredential as typeof PublicKeyCredential & {
    getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
  };
  if (typeof PKC.getClientCapabilities === "function") {
    try {
      // Some browsers take their time (or never answer); a hint isn't worth a stuck button.
      const caps = await Promise.race([
        PKC.getClientCapabilities(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
      ]);
      if (caps?.["extension:prf"] === false) return { ok: false, reason: "no-prf" };
    } catch {
      /* treat as unknown */
    }
  }
  return { ok: true };
}

/**
 * In-app browsers (Instagram, Facebook, TikTok, some WhatsApp builds) run
 * links in a WebView that can't make passkeys for our domain. A claim or pay
 * link opened there should say "Open in Safari/Chrome".
 */
export function isInAppBrowser(userAgent: string): boolean {
  return /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|musical_ly|BytedanceWebview|; wv\)/i.test(
    userAgent,
  );
}
