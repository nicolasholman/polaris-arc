import { isMeraError } from "@category-labs/mera";

/**
 * What can go wrong with an account, in kinds the UI can act on. The buyer
 * sees `describeAccountError`, which never says passkey, wallet or PRF.
 */
export type AccountErrorKind =
  /** Face ID was dismissed, timed out, or the saved sign-in is gone. */
  | "cancelled"
  /** This browser or authenticator can't hold an account (no PRF). Show "Open on your phone". */
  | "unsupported"
  /** Not a secure context. */
  | "insecure"
  /** The page's host can't use the configured relying party. */
  | "host"
  /** Sign-in found nothing to sign in to. */
  | "no-account"
  /** A signature was requested after the session ended. */
  | "session-ended"
  | "unknown";

export class AccountError extends Error {
  readonly kind: AccountErrorKind;
  constructor(kind: AccountErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AccountError";
    this.kind = kind;
  }
}

export function toAccountError(error: unknown): AccountError {
  if (error instanceof AccountError) return error;
  if (isMeraError(error)) {
    switch (error.code) {
      case "PASSKEY_OPERATION_FAILED":
        return new AccountError("cancelled", error.message, { cause: error });
      case "PRF_UNAVAILABLE":
        return new AccountError("unsupported", error.message, { cause: error });
      case "CRYPTO_UNAVAILABLE":
        return new AccountError("insecure", error.message, { cause: error });
      case "SESSION_ENDED":
        return new AccountError("session-ended", error.message, { cause: error });
      default:
        return new AccountError("unknown", error.message, { cause: error });
    }
  }
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      return new AccountError("cancelled", error.message, { cause: error });
    }
    if (error.name === "SecurityError") return new AccountError("host", error.message, { cause: error });
    if (error.name === "NotSupportedError") return new AccountError("unsupported", error.message, { cause: error });
  }
  return new AccountError("unknown", error instanceof Error ? error.message : String(error), { cause: error });
}

/** The sentence the buyer reads. */
export function describeAccountError(error: unknown): string {
  switch (toAccountError(error).kind) {
    case "cancelled":
      return "Face ID was cancelled. Try again.";
    case "unsupported":
      return "This browser can't hold a Polaris account. Open Polaris on your phone.";
    case "insecure":
      return "Open this page over https to use Face ID.";
    case "host":
      return "Polaris accounts don't work on this site. Open polarispay.app instead.";
    case "no-account":
      return "We couldn't find a Polaris account on this device.";
    case "session-ended":
      return "Please confirm again.";
    default:
      return "Something went wrong. Try again.";
  }
}
