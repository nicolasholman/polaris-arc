import { configurationError } from "./errors.js";

/**
 * API keys, Stripe-style:
 *
 *   pk_test_… / pk_live_…  publishable: safe in a browser, identifies the merchant
 *   sk_test_… / sk_live_…  secret: server only, creates checkout sessions
 *   whsec_…                a webhook endpoint's signing secret
 *
 * `test` keys run against Monad testnet and never move real money; `live`
 * keys run against Monad mainnet.
 */

export type KeyKind = "publishable" | "secret";
export type KeyMode = "test" | "live";

const KEY_PATTERN = /^(pk|sk)_(test|live)_[A-Za-z0-9]{8,}$/;

export type ParsedKey = { kind: KeyKind; mode: KeyMode; livemode: boolean };

/** Parse a key's prefix, or return null if it isn't a Polaris API key at all. */
export function parseKey(key: string): ParsedKey | null {
  const match = KEY_PATTERN.exec(key.trim());
  if (!match) return null;
  const kind: KeyKind = match[1] === "pk" ? "publishable" : "secret";
  const mode = match[2] as KeyMode;
  return { kind, mode, livemode: mode === "live" };
}

/** A secret key, or a clear error naming what was passed instead. */
export function requireSecretKey(key: unknown): ParsedKey {
  if (typeof key !== "string" || key.trim() === "") {
    throw configurationError(
      "missing_secret_key",
      "createPolarisServer needs a secretKey (sk_test_… or sk_live_…). Find it under Developers → API keys in Polaris for Business.",
      "secretKey",
    );
  }
  const parsed = parseKey(key);
  if (parsed?.kind === "publishable") {
    throw configurationError(
      "publishable_key_on_server",
      "That is a publishable key (pk_…). The server SDK needs the secret key (sk_…) from the same page.",
      "secretKey",
    );
  }
  if (!parsed) {
    throw configurationError(
      "invalid_secret_key",
      "secretKey doesn't look like a Polaris secret key. It starts with sk_test_ or sk_live_.",
      "secretKey",
    );
  }
  return parsed;
}

/** A publishable key, refusing a secret key outright: it must never reach a browser. */
export function requirePublishableKey(key: unknown): ParsedKey {
  if (typeof key !== "string" || key.trim() === "") {
    throw configurationError("missing_publishable_key", "Pass a publishableKey (pk_test_… or pk_live_…).", "publishableKey");
  }
  const parsed = parseKey(key);
  if (parsed?.kind === "secret") {
    throw configurationError(
      "secret_key_in_browser",
      "That is a secret key (sk_…). Never ship it to a browser: roll it under Developers → API keys, and pass the publishable key (pk_…) here instead.",
      "publishableKey",
    );
  }
  if (!parsed) {
    throw configurationError(
      "invalid_publishable_key",
      "publishableKey doesn't look like a Polaris publishable key. It starts with pk_test_ or pk_live_.",
      "publishableKey",
    );
  }
  return parsed;
}
