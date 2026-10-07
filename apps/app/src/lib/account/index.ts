import { forgetReceiptKeys, type ReceiptKeys } from "@polaris/receipts";
import type { Address, LocalAccount } from "viem";
import { env } from "../env";
import { registerInbox } from "../receipts/inbox";
import { requestEmailLogin } from "./email-login";
import { AccountError, toAccountError } from "./errors";
import { meraCreate, meraSignIn } from "./mera";
import {
  onPrivyChange,
  PRIVY_ENABLED,
  PRIVY_RECORD_KEY,
  privyAccount,
  privyLogout,
  privyStatus,
  storedPrivyAddress,
  waitForPrivyWallet,
} from "./privy";
import { resolveRpId } from "./rp";
import { forgetStoredAccount, loadStoredAccount, STORED_ACCOUNT_KEY, saveStoredAccount, type StoredAccount } from "./storage";

/**
 * The Polaris account: one interface, three implementations, a viem
 * LocalAccount out. The rest of the app never asks which one is in use.
 *
 *   mera   Face ID. A passkey's PRF output derives the key (the primary sign-up).
 *   privy  "Continue with email". Privy's embedded wallet signs (useSignTypedData).
 *   dev    NEXT_PUBLIC_DEV_SIGNER=1: a key in this tab's sessionStorage stands in
 *          for Face ID, so flows run headlessly. Never in a deployed build.
 *
 *   createAccount()      Face ID makes a new account (dev when the flag is on).
 *   continueWithEmail()  The email sheet; resolves once the embedded wallet exists.
 *   signIn()             Face ID on an existing passkey gives the same account back.
 *   getAccount()         The signed-in account for this session, or null.
 *   authorize()          What every Confirm calls: a fresh Face ID unless one just
 *                        happened (email accounts use their session).
 *   signOut()            Ends the session (and the Privy session), zeroing any key.
 *   receiptKeys()        The session's receipt keys (Face ID and dev only), or null.
 *
 * A Face ID session also holds the receipt keys the same PRF output derives
 * (@polaris/receipts): they live and die with the signing key, and opening
 * the session registers the inbox key with Polaris (receipts/inbox.ts),
 * signed by the account. Email accounts have no PRF, so no receipt keys:
 * their receipts stay as they always were.
 *
 * Browser only. Call the ceremonies from click handlers, never from effects,
 * and start them before awaiting anything else in the handler.
 */

export { AccountError, describeAccountError, toAccountError } from "./errors";
export type { AccountErrorKind } from "./errors";
export { checkAccountSupport, isInAppBrowser, type AccountSupport } from "./support";
export type { StoredAccount } from "./storage";

export type AccountSource = "mera" | "privy" | "dev";

export type AccountState =
  /** Server render and first client paint: storage not read yet. */
  | { status: "unknown" }
  /** No account on this device. */
  | { status: "none" }
  /** An account lives on this device; Face ID (or the email session) unlocks it. */
  | { status: "locked"; address: Address; source: AccountSource }
  /** Signed in: the key is in memory until sign-out or the tab closes. */
  | { status: "ready"; address: Address; source: AccountSource };

/** True when `NEXT_PUBLIC_DEV_SIGNER=1` was set at build time. */
export const DEV_SIGNER = env.devSigner;

/** True when a Privy app id is configured: "Continue with email" is offered. */
export const EMAIL_LOGIN = PRIVY_ENABLED;

/** An account that is open for signing, how to close it, and its receipt keys (Face ID and dev only). */
export type Opened = { account: LocalAccount; end: () => void; receipts?: ReceiptKeys | null };

/**
 * What each way of holding an account provides. `stored()` reads only
 * public, local records and never prompts; `create` and `unlock` may show
 * Face ID or the email sheet.
 */
export interface AccountImplementation {
  readonly source: AccountSource;
  /** Whether a payment asks again after a while (Face ID) or rides the session (email). */
  readonly reauthorize: boolean;
  /** The address of the account kept on this device, or null (or undefined while loading). */
  stored(): Address | null | undefined;
  create(): Promise<Opened>;
  unlock(opts?: { anyAccount?: boolean }): Promise<Opened>;
  forget(): void | Promise<void>;
}

type Session = { account: LocalAccount; source: AccountSource; unlockedAt: number; end: () => void; receipts: ReceiptKeys | null };

let session: Session | null = null;
let inflight: Promise<LocalAccount> | null = null;

/* ── dev: loaded only when the flag is on ────────────────────────────────── */

type DevModule = typeof import("./dev-signer");
let devModule: DevModule | null = null;
let devModuleLoading: Promise<DevModule> | null = null;

function loadDevModule(): Promise<DevModule> {
  if (!DEV_SIGNER) return Promise.reject(new Error("The dev signer is disabled"));
  devModuleLoading ??= import("./dev-signer").then((m) => {
    devModule = m;
    emit();
    return m;
  });
  return devModuleLoading;
}

const dev: AccountImplementation = {
  source: "dev",
  reauthorize: true,
  stored: () => (devModule ? devModule.devStoredAddress() : undefined),
  async create() {
    const { account, receipts } = await (await loadDevModule()).devCreate();
    return { account, end: () => undefined, receipts };
  },
  async unlock() {
    const { account, receipts } = await (await loadDevModule()).devSignIn();
    return { account, end: () => undefined, receipts };
  },
  forget: () => devModule?.devForget(),
};

/* ── mera: Face ID ───────────────────────────────────────────────────────── */

const mera: AccountImplementation = {
  source: "mera",
  reauthorize: true,
  stored: () => loadStoredAccount()?.address ?? null,
  async create() {
    const rpId = resolveRpId();
    const opened = await meraCreate(rpId);
    // Saved before anything else runs, so a failed payment never loses the account.
    saveStoredAccount({
      v: 1,
      credentialId: opened.credentialId,
      rpId,
      address: opened.account.address,
      createdAt: Date.now(),
      ...(opened.transports ? { transports: [...opened.transports] } : {}),
    });
    return { account: opened.account, end: opened.end, receipts: opened.receipts };
  },
  async unlock(opts = {}) {
    const rpId = resolveRpId();
    const stored = loadStoredAccount();
    const pinned = !opts.anyAccount && stored && stored.rpId === rpId ? stored : null;
    const opened = await meraSignIn(
      rpId,
      pinned
        ? { credentialId: pinned.credentialId, ...(pinned.transports ? { transports: pinned.transports } : {}) }
        : undefined,
    );
    if (!pinned || pinned.credentialId !== opened.credentialId || pinned.address !== opened.account.address) {
      const record: StoredAccount = {
        v: 1,
        credentialId: opened.credentialId,
        rpId,
        address: opened.account.address,
        createdAt: pinned?.createdAt ?? Date.now(),
      };
      saveStoredAccount(record);
    }
    return { account: opened.account, end: opened.end, receipts: opened.receipts };
  },
  forget: () => forgetStoredAccount(),
};

/* ── privy: Continue with email ──────────────────────────────────────────── */

async function openPrivy(): Promise<Opened> {
  const current = privyStatus();
  // Already signed in to Privy on this device: no need to ask for the email again.
  const address =
    current.authenticated && current.address
      ? current.address
      : current.authenticated
        ? await waitForPrivyWallet()
        : await requestEmailLogin();
  return { account: privyAccount(address), end: () => undefined };
}

const privy: AccountImplementation = {
  source: "privy",
  reauthorize: false,
  stored: () => storedPrivyAddress(),
  create: openPrivy,
  unlock: openPrivy,
  forget: () => privyLogout(),
};

/** Face ID, or its dev stand-in. */
const face: AccountImplementation = DEV_SIGNER ? dev : mera;
const IMPLEMENTATIONS: Record<AccountSource, AccountImplementation> = { mera, privy, dev };

export function implementation(source: AccountSource): AccountImplementation {
  return IMPLEMENTATIONS[source];
}

/* ── Which account this device used last ─────────────────────────────────── */

const LAST_KEY = "polaris.account.last";

function lastSource(): AccountSource | null {
  try {
    const value = window.localStorage.getItem(LAST_KEY);
    return value === "mera" || value === "privy" || value === "dev" ? value : null;
  } catch {
    return null;
  }
}

function rememberSource(source: AccountSource): void {
  try {
    window.localStorage.setItem(LAST_KEY, source);
  } catch {
    /* only a preference */
  }
}

/* ── Store (for useSyncExternalStore) ────────────────────────────────────── */

const listeners = new Set<() => void>();
const UNKNOWN: AccountState = { status: "unknown" };
let snapshot: AccountState = UNKNOWN;
let snapshotReady = false;
let windowListeners = false;

function computeState(): AccountState {
  if (session) return { status: "ready", address: session.account.address, source: session.source };
  const last = lastSource();
  const order: AccountImplementation[] = [];
  if (last) order.push(IMPLEMENTATIONS[last]);
  for (const impl of [privy, face]) if (!order.includes(impl)) order.push(impl);
  for (const impl of order) {
    if (impl.source === "dev" && !DEV_SIGNER) continue;
    if (impl.source === "mera" && DEV_SIGNER) continue;
    const address = impl.stored();
    if (address === undefined) return UNKNOWN;
    if (address) return { status: "locked", address, source: impl.source };
  }
  return { status: "none" };
}

function sameState(a: AccountState, b: AccountState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "locked" || a.status === "ready") {
    const other = b as typeof a;
    return a.address === other.address && a.source === other.source;
  }
  return true;
}

function emit(): void {
  const next = computeState();
  if (!sameState(next, snapshot)) snapshot = next;
  snapshotReady = true;
  for (const listener of listeners) listener();
}

/** Privy's own session opens and closes ours: an email account needs no Face ID. */
function syncPrivy(): void {
  const s = privyStatus();
  if (!s.ready) return;
  if (s.authenticated && s.address && !session && !inflight) {
    startSession(privyAccount(s.address), "privy", () => undefined);
    return;
  }
  if (!s.authenticated && session?.source === "privy") endSession();
  else emit();
}

function attachWindowListeners(): void {
  if (windowListeners || typeof window === "undefined") return;
  windowListeners = true;
  // Another tab created or forgot the account.
  window.addEventListener("storage", (event) => {
    if (event.key === STORED_ACCOUNT_KEY || event.key === PRIVY_RECORD_KEY || event.key === null) emit();
  });
  // Leaving the page ends a Face ID session: the key never outlives the tab.
  window.addEventListener("pagehide", () => {
    if (session && session.source !== "privy") endSession();
  });
  window.addEventListener("pageshow", () => {
    syncPrivy();
    emit();
  });
  onPrivyChange(syncPrivy);
  if (DEV_SIGNER) void loadDevModule();
}

export function subscribe(listener: () => void): () => void {
  attachWindowListeners();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): AccountState {
  if (!snapshotReady && typeof window !== "undefined") {
    snapshot = computeState();
    snapshotReady = snapshot.status !== "unknown";
  }
  return snapshot;
}

export function getServerSnapshot(): AccountState {
  return UNKNOWN;
}

/* ── Sessions ────────────────────────────────────────────────────────────── */

function endSession(): void {
  if (!session) return;
  try {
    session.end();
  } finally {
    if (session.receipts) forgetReceiptKeys(session.receipts);
    session = null;
    emit();
  }
}

function startSession(account: LocalAccount, source: AccountSource, end: () => void, receipts: ReceiptKeys | null = null): LocalAccount {
  if (session && session.account !== account) {
    session.end();
    if (session.receipts && session.receipts !== receipts) forgetReceiptKeys(session.receipts);
  }
  session = { account, source, unlockedAt: Date.now(), end, receipts };
  rememberSource(source);
  // The inbox key goes to Polaris signed by the account, with the session that is open: no prompt.
  if (receipts) registerInbox(account, receipts.inboxPublicKey);
  emit();
  return account;
}

function once(run: () => Promise<LocalAccount>): Promise<LocalAccount> {
  // A double tap must never start two ceremonies (two creates = two accounts).
  if (inflight) return inflight;
  inflight = run()
    .catch((error: unknown) => {
      throw toAccountError(error);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function open(impl: AccountImplementation, how: "create" | "unlock", opts?: { anyAccount?: boolean }) {
  return once(async () => {
    const opened = how === "create" ? await impl.create() : await impl.unlock(opts);
    return startSession(opened.account, impl.source, opened.end, opened.receipts ?? null);
  });
}

/** Face ID creates a new account on this device. */
export function createAccount(): Promise<LocalAccount> {
  return open(face, "create");
}

/**
 * "Continue with email": the email sheet, a code, and Privy's embedded
 * wallet. Signs in if the email already has an account.
 */
export function continueWithEmail(): Promise<LocalAccount> {
  if (!EMAIL_LOGIN) return Promise.reject(new AccountError("unsupported", "Email sign-in isn't set up"));
  return open(privy, "create");
}

/**
 * Face ID signs in to the account on this device. `anyAccount` skips the
 * remembered one and lets the system list every Polaris account (use it for
 * "Use a different account", or when the remembered one was deleted).
 */
export function signIn(opts: { anyAccount?: boolean } = {}): Promise<LocalAccount> {
  return open(face, "unlock", opts);
}

/** The signed-in account for this session, or null. Never prompts. */
export function getAccount(): LocalAccount | null {
  return session?.account ?? null;
}

/**
 * The receipt keys of the open session, or null: no session, an email
 * account (no PRF, so no keys), or a browser that couldn't derive them.
 * Never prompts. In memory only, like the signing key.
 */
export function receiptKeys(): ReceiptKeys | null {
  return session?.receipts ?? null;
}

/** How the current (or remembered) account is held, or null. */
export function accountSource(): AccountSource | null {
  const state = getSnapshot();
  return state.status === "ready" || state.status === "locked" ? state.source : null;
}

/**
 * For Confirm buttons: the account, behind Face ID. Reuses a Face ID session
 * only if it ran in the last `withinMs` (so creating an account and paying is
 * one Face ID); otherwise asks again, like Apple Pay does per payment. An
 * email account rides its Privy session.
 */
export function authorize(withinMs = 60_000): Promise<LocalAccount> {
  if (session) {
    const impl = IMPLEMENTATIONS[session.source];
    if (!impl.reauthorize || Date.now() - session.unlockedAt <= withinMs) return Promise.resolve(session.account);
    return open(impl, "unlock");
  }
  const state = getSnapshot();
  if (state.status === "locked") return open(IMPLEMENTATIONS[state.source], "unlock");
  return signIn();
}

/**
 * Ends the session and zeroes the key. An email account also signs out of
 * Privy. `forget` also removes this device's record of the account; Face ID
 * (or the email) finds it again.
 */
export function signOut(opts: { forget?: boolean } = {}): void {
  const source = session?.source ?? accountSource();
  endSession();
  if (source === "privy") void privyLogout().then(emit);
  if (opts.forget && source) void IMPLEMENTATIONS[source].forget();
  try {
    window.localStorage.removeItem(LAST_KEY);
  } catch {
    /* only a preference */
  }
  emit();
}

/**
 * When the account on this device was created (Face ID's record, or the dev
 * signer's), or null when it isn't this address's or isn't known (an email
 * account). Never prompts.
 */
export function accountCreatedAt(address: Address | null): number | null {
  if (typeof window === "undefined" || !address) return null;
  const mine = (a: Address | null | undefined) => Boolean(a) && a!.toLowerCase() === address.toLowerCase();
  if (DEV_SIGNER) return devModule && mine(devModule.devStoredAddress()) ? devModule.devCreatedAt() : null;
  const stored = loadStoredAccount();
  return stored && mine(stored.address) ? stored.createdAt : null;
}

/** The device's public Face ID account record (Mera path only). */
export function storedAccount(): StoredAccount | null {
  return typeof window === "undefined" || DEV_SIGNER ? null : loadStoredAccount();
}

export function isAccountError(error: unknown): error is AccountError {
  return error instanceof AccountError;
}
