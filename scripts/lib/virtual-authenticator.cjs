// A WebAuthn authenticator for headless runs: Chrome's own virtual authenticator (Chrome DevTools
// Protocol, WebAuthn domain) with PRF, so the app's real passkey code runs: Mera's
// createPasskeyWithPrfOutput / getPasskeyPrfOutput, and from the PRF output the account key and the
// receipt keys. Nothing in the app is swapped out; no key is handed to the page.
//
//   const { addAuthenticator } = require("./lib/virtual-authenticator.cjs");
//   const device = await addAuthenticator(context, { origin: "http://localhost:3000" });
//
// One authenticator per browser context, like the one phone a person carries. Chrome attaches a
// virtual authenticator to a single tab, and a credential copied into another tab's authenticator
// (WebAuthn.addCredential) comes without its PRF secret: there it answers with no PRF output, so the
// checkout popup a shop opens would be a different account. So the authenticator lives in one
// "device" tab on the app's origin, and every other tab of that origin hands its
// navigator.credentials.create/get options to that tab, which runs the ceremony on the virtual
// authenticator (user verification on, presence simulated) and hands back the credential the browser
// returned: id, rawId, the authenticator's response and its client extension results (the PRF output).
// The ceremony, the credential and the PRF output are Chrome's; only the hand-off between tabs is ours.

const OPTIONS = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  hasPrf: true,
  automaticPresenceSimulation: true,
};

const DEVICE_FLAG = "polaris-authenticator=1";

/** Runs in every page of the context, before the page's own scripts. */
function bridgeScript({ origin, flag }) {
  // Patched on the prototype and decided per call: a popup's first document (about:blank) can be
  // replaced by the page it opens while keeping its window, and so this script's patch.
  if (typeof CredentialsContainer === "undefined" || CredentialsContainer.prototype.__polarisBridged) return;
  const bridged = () => location.origin === origin && !location.search.includes(flag);
  const b64 = (buf) => {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const unb64 = (s) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const encode = (v) => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { __b64: b64(v) };
    if (Array.isArray(v)) return v.map(encode);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (k !== "signal" && x !== undefined) out[k] = encode(x);
      return out;
    }
    return v;
  };
  const decode = (v) => {
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === "object") {
      if (typeof v.__b64 === "string") return unb64(v.__b64);
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = decode(x);
      return out;
    }
    return v;
  };
  const call = async (op, options) => {
    if (!bridged() || !options || !options.publicKey) return native[op].call(navigator.credentials, options);
    const answer = JSON.parse(await window.__polarisWebAuthn(op, JSON.stringify(encode({ publicKey: options.publicKey, mediation: options.mediation }))));
    if (answer.error) throw new DOMException(answer.error.message, answer.error.name);
    const c = decode(answer.credential);
    const response = { ...c.response };
    if (c.transports) response.getTransports = () => [...c.transports];
    return {
      id: c.id,
      rawId: c.rawId,
      type: c.type,
      authenticatorAttachment: c.authenticatorAttachment,
      response,
      getClientExtensionResults: () => c.clientExtensionResults,
      toJSON: () => answer.credential,
    };
  };
  const proto = CredentialsContainer.prototype;
  const native = { create: proto.create, get: proto.get };
  Object.defineProperty(proto, "create", { configurable: true, writable: true, value: function create(options) { return call("create", options); } });
  Object.defineProperty(proto, "get", { configurable: true, writable: true, value: function get(options) { return call("get", options); } });
  Object.defineProperty(proto, "__polarisBridged", { value: true });
}

/** Runs in the device tab: the real ceremony, its result made serialisable. */
async function ceremony({ op, json }) {
  const b64 = (buf) => {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const decode = (v) => {
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === "object") {
      if (typeof v.__b64 === "string") {
        const bin = atob(v.__b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = decode(x);
      return out;
    }
    return v;
  };
  const encode = (v) => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { __b64: b64(v) };
    if (Array.isArray(v)) return v.map(encode);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x);
      return out;
    }
    return v;
  };
  try {
    const options = decode(JSON.parse(json));
    const cred = op === "create" ? await navigator.credentials.create(options) : await navigator.credentials.get(options);
    if (!cred) throw new DOMException("The authenticator returned no credential", "NotAllowedError");
    const r = cred.response;
    const response =
      op === "create"
        ? { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject }
        : { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle ?? null };
    return JSON.stringify({
      credential: encode({
        id: cred.id,
        rawId: cred.rawId,
        type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment ?? null,
        response,
        transports: typeof r.getTransports === "function" ? r.getTransports() : null,
        clientExtensionResults: cred.getClientExtensionResults(),
      }),
    });
  } catch (e) {
    return JSON.stringify({ error: { name: e?.name || "NotAllowedError", message: String(e?.message ?? e) } });
  }
}

/**
 * Give `context` a passkey authenticator for `origin` (the app's origin, e.g. http://localhost:3000).
 * Returns { page, authenticatorId, cdp, credentials() }. Call it before the app's pages load.
 */
async function addAuthenticator(context, { origin, devicePath = "/assets/coin.png", log = () => {} }) {
  const page = await context.newPage();
  await page.goto(`${origin}${devicePath}?${DEVICE_FLAG}`, { waitUntil: "load", timeout: 180000 });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: OPTIONS });
  let ceremonies = 0;
  await context.exposeBinding("__polarisWebAuthn", async ({ page: from }, op, json) => {
    if (op !== "create" && op !== "get") return JSON.stringify({ error: { name: "NotSupportedError", message: `unknown operation ${op}` } });
    const out = await page.evaluate(ceremony, { op, json });
    ceremonies += 1;
    const parsed = JSON.parse(out);
    log(`webauthn ${op} for ${new URL(from.url()).pathname}: ${parsed.error ? `${parsed.error.name} ${parsed.error.message}` : `credential ${parsed.credential.id.slice(0, 10)}…, prf ${parsed.credential.clientExtensionResults?.prf?.results?.first ? "yes" : "no"}`}`);
    return out;
  });
  await context.addInitScript(bridgeScript, { origin, flag: DEVICE_FLAG });
  return {
    page,
    cdp,
    authenticatorId,
    ceremonies: () => ceremonies,
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
  };
}

/**
 * The account the app keeps on this device, read from its public records: the passkey account
 * (`polaris.account.v1`, address and credential id only) or, on the Hardhat stack, the dev signer's
 * key (`polaris.dev-signer.v1`, turned into its address with `privateKeyToAccount`). Null when none.
 */
async function buyerAddress(page, privateKeyToAccount) {
  const stored = await page.evaluate(() => ({
    passkey: JSON.parse(localStorage.getItem("polaris.account.v1") || "null")?.address ?? null,
    dev: JSON.parse(localStorage.getItem("polaris.dev-signer.v1") || "null")?.privateKey ?? null,
  }));
  if (stored.passkey) return stored.passkey;
  return stored.dev && privateKeyToAccount ? privateKeyToAccount(stored.dev).address : null;
}

module.exports = { addAuthenticator, buyerAddress, AUTHENTICATOR_OPTIONS: OPTIONS };
