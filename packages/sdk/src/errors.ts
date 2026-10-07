/**
 * One error class for everything the SDK throws, so a caller branches on
 * `err.type` and `err.code` instead of parsing messages.
 *
 * `message` is written for a developer reading a log. The checkout and pay
 * flows that face a buyer never show it raw: they return a `Result` whose
 * `error` is a sentence a buyer can act on (see `buyerMessage`).
 */

export type PolarisErrorType =
  /** The SDK was set up wrong: a missing key, a secret key in a browser, contracts that aren't deployed. */
  | "configuration_error"
  /** The request was rejected before or by the API as malformed. */
  | "invalid_request_error"
  /** The API didn't accept the key. */
  | "authentication_error"
  /** The key is valid but can't do this. */
  | "permission_error"
  /** The same idempotency key was reused with different parameters. */
  | "idempotency_error"
  /** Too many requests; retried automatically before this is thrown. */
  | "rate_limit_error"
  /** The API answered 5xx after every retry. */
  | "api_error"
  /** The API couldn't be reached, or didn't answer in time. */
  | "connection_error"
  /** A webhook's signature didn't verify. */
  | "signature_verification_error"
  /** The hosted checkout couldn't be opened. */
  | "checkout_error"
  /** The buyer's wallet refused, or the chain did. */
  | "wallet_error";

export type PolarisErrorOptions = {
  type: PolarisErrorType;
  code: string;
  /** HTTP status, when the error came from the API. */
  status?: number;
  /** The API's request id (`Polaris-Request-Id`), for support. */
  requestId?: string;
  /** The request field the error is about, when there is one. */
  param?: string;
  cause?: unknown;
};

export class PolarisError extends Error {
  readonly type: PolarisErrorType;
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly param?: string;

  constructor(message: string, options: PolarisErrorOptions) {
    super(message);
    this.name = "PolarisError";
    this.type = options.type;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.param = options.param;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false, configurable: true });
    }
    // Keep `instanceof` working when compiled to ES5-style classes by a consumer's bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Why a webhook signature failed, for logs. Never echo it to the caller of your endpoint. */
export type SignatureFailureReason =
  | "missing_header"
  | "malformed_header"
  | "no_signatures"
  | "timestamp_outside_tolerance"
  | "signature_mismatch"
  | "missing_secret"
  | "invalid_payload";

export class PolarisSignatureVerificationError extends PolarisError {
  readonly reason: SignatureFailureReason;

  constructor(reason: SignatureFailureReason, message: string) {
    super(message, { type: "signature_verification_error", code: `webhook_${reason}` });
    this.name = "PolarisSignatureVerificationError";
    this.reason = reason;
  }
}

export function isPolarisError(value: unknown): value is PolarisError {
  return value instanceof PolarisError;
}

export function configurationError(code: string, message: string, param?: string): PolarisError {
  return new PolarisError(message, { type: "configuration_error", code, param });
}

export function invalidRequest(code: string, message: string, param?: string): PolarisError {
  return new PolarisError(message, { type: "invalid_request_error", code, param });
}
