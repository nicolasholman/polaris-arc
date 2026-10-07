/**
 * Digital Asset Links for the Android app (apps/android, a Trusted Web Activity).
 *
 * Android verifies a TWA by fetching https://<host>/.well-known/assetlinks.json
 * and looking for a statement that names the app's package and the SHA-256
 * fingerprint of the certificate it was signed with. When it matches, Chrome
 * shows the site full screen, with no address bar, and https://<host> links
 * open in the app. When it doesn't, the app still works, but Chrome shows the
 * page as a Custom Tab with its address bar.
 *
 * Built from the server's environment (read per request, so a host can add a
 * fingerprint without a rebuild):
 *
 * - POLARIS_ANDROID_PACKAGE: the app's package name (default app.polarispay.twa)
 * - POLARIS_ANDROID_SHA256_FINGERPRINTS: one or more SHA-256 certificate
 *   fingerprints, separated by commas or whitespace. List every key the app
 *   may be signed with: the local or upload key, and Google Play's app signing
 *   key once the app is on Play. `pnpm --filter @polaris/android fingerprint`
 *   prints the local one.
 *
 * Self-contained (no path aliases) so node's test runner can import it.
 */

/** The package name apps/android builds (twa-manifest.json `packageId`). */
export const DEFAULT_ANDROID_PACKAGE = "app.polarispay.twa";

/** The relation a TWA (and Android App Links) needs. */
export const HANDLE_ALL_URLS = "delegate_permission/common.handle_all_urls";

export type AssetStatement = {
  relation: string[];
  target: {
    namespace: "android_app";
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
};

export type AssetLinksResult =
  | { status: 200; statements: AssetStatement[] }
  | { status: 404; reason: string }
  | { status: 500; reason: string };

// A Java package name with at least two segments, as Android requires.
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * "AA:BB:…" (32 bytes, upper-case hex, colon-separated), the form Android and
 * `keytool -list -v` print. Accepts lower case and a fingerprint without
 * colons; throws on anything that isn't 32 bytes of hex. The error never
 * repeats the input, in case something secret was pasted by mistake.
 */
export function normalizeFingerprint(input: string): string {
  const trimmed = input.trim();
  const hex = trimmed.includes(":") ? trimmed.split(":") : (trimmed.match(/.{1,2}/g) ?? []);
  if (hex.length !== 32 || !hex.every((byte) => /^[0-9a-fA-F]{2}$/.test(byte))) {
    throw new Error("not a SHA-256 certificate fingerprint (32 bytes of hex, e.g. AA:BB:…)");
  }
  return hex.map((byte) => byte.toUpperCase()).join(":");
}

/** Every fingerprint in a comma- or whitespace-separated list, normalised and de-duplicated. */
export function parseFingerprints(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  const normalized = entries.map((entry, index) => {
    try {
      return normalizeFingerprint(entry);
    } catch (error) {
      throw new Error(`entry ${index + 1} of ${entries.length} is ${(error as Error).message}`);
    }
  });
  return [...new Set(normalized)];
}

/** The statement list for one Android package signed by any of `fingerprints`. */
export function buildAssetLinks(packageName: string, fingerprints: string[]): AssetStatement[] {
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`"${packageName}" is not an Android package name`);
  }
  if (fingerprints.length === 0) {
    throw new Error("at least one SHA-256 certificate fingerprint is required");
  }
  return [
    {
      relation: [HANDLE_ALL_URLS],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints.map(normalizeFingerprint),
      },
    },
  ];
}

type AssetLinksEnv = {
  POLARIS_ANDROID_PACKAGE?: string;
  POLARIS_ANDROID_SHA256_FINGERPRINTS?: string;
};

/**
 * What /.well-known/assetlinks.json serves for this environment: the
 * statements (200), nothing configured (404, so a missing fingerprint is
 * obvious to `curl` rather than an empty list), or a misconfiguration (500,
 * never a partial list that would verify some builds and not others).
 */
export function assetLinksFromEnv(env: AssetLinksEnv): AssetLinksResult {
  const packageName = env.POLARIS_ANDROID_PACKAGE?.trim() || DEFAULT_ANDROID_PACKAGE;
  let fingerprints: string[];
  try {
    fingerprints = parseFingerprints(env.POLARIS_ANDROID_SHA256_FINGERPRINTS);
  } catch (error) {
    return { status: 500, reason: `POLARIS_ANDROID_SHA256_FINGERPRINTS: ${(error as Error).message}` };
  }
  if (fingerprints.length === 0) {
    return { status: 404, reason: "No Android app is linked to this site: POLARIS_ANDROID_SHA256_FINGERPRINTS is not set." };
  }
  try {
    return { status: 200, statements: buildAssetLinks(packageName, fingerprints) };
  } catch (error) {
    return { status: 500, reason: `POLARIS_ANDROID_PACKAGE: ${(error as Error).message}` };
  }
}

/** The HTTP response for /.well-known/assetlinks.json. */
export function assetLinksResponse(env: AssetLinksEnv): Response {
  const result = assetLinksFromEnv(env);
  if (result.status === 200) {
    return new Response(`${JSON.stringify(result.statements, null, 2)}\n`, {
      status: 200,
      // Android caches the verification itself; an hour keeps a new key quick to pick up.
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    });
  }
  // The detail goes to the server log; the public body only says what kind of problem it is.
  if (result.status === 500) console.error(`[assetlinks] ${result.reason}`);
  const error = result.status === 404 ? result.reason : "The Android app link is misconfigured on this server.";
  return new Response(`${JSON.stringify({ error })}\n`, {
    status: result.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
