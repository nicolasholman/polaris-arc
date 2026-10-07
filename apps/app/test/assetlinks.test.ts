import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assetLinksFromEnv,
  assetLinksResponse,
  buildAssetLinks,
  DEFAULT_ANDROID_PACKAGE,
  HANDLE_ALL_URLS,
  normalizeFingerprint,
  parseFingerprints,
} from "../src/lib/assetlinks.ts";

/**
 * /.well-known/assetlinks.json, which Android fetches to verify the Trusted
 * Web Activity in apps/android. A wrong byte here and Chrome shows the app
 * with an address bar, so the shape and the fingerprint format are pinned.
 */

// Two made-up certificate fingerprints (not any real key's).
const FP_A = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";
const FP_B = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

describe("normalizeFingerprint", () => {
  it("keeps keytool's form", () => {
    assert.equal(normalizeFingerprint(FP_A), FP_A);
  });

  it("upper-cases, trims, and adds colons to a bare hex fingerprint", () => {
    assert.equal(normalizeFingerprint(`  ${FP_A.toLowerCase()} `), FP_A);
    assert.equal(normalizeFingerprint(FP_A.replaceAll(":", "").toLowerCase()), FP_A);
  });

  it("refuses a SHA-1 fingerprint, stray characters and short input, without echoing it", () => {
    const sha1 = "DA:39:A3:EE:5E:6B:4B:0D:32:55:BF:EF:95:60:18:90:AF:D8:07:09";
    for (const bad of [sha1, FP_A.replace("14", "1G"), `${FP_A}:00`, "hunter2", ""]) {
      assert.throws(
        () => normalizeFingerprint(bad),
        (error: Error) => /not a SHA-256 certificate fingerprint/.test(error.message) && (bad === "" || !error.message.includes(bad)),
      );
    }
  });
});

describe("parseFingerprints", () => {
  it("splits on commas and whitespace and drops duplicates", () => {
    assert.deepEqual(parseFingerprints(`${FP_A}, ${FP_B}\n${FP_A.toLowerCase()}`), [FP_A, FP_B]);
  });

  it("is empty when unset", () => {
    assert.deepEqual(parseFingerprints(undefined), []);
    assert.deepEqual(parseFingerprints("  , "), []);
  });

  it("names which entry is wrong", () => {
    assert.throws(() => parseFingerprints(`${FP_A},nope`), /entry 2 of 2 is not a SHA-256/);
  });
});

describe("buildAssetLinks", () => {
  it("is one handle_all_urls statement for the package and every fingerprint", () => {
    assert.deepEqual(buildAssetLinks("app.polarispay.twa", [FP_A, FP_B.toLowerCase()]), [
      {
        relation: [HANDLE_ALL_URLS],
        target: { namespace: "android_app", package_name: "app.polarispay.twa", sha256_cert_fingerprints: [FP_A, FP_B] },
      },
    ]);
    assert.equal(HANDLE_ALL_URLS, "delegate_permission/common.handle_all_urls");
  });

  it("refuses a package name Android wouldn't accept, and an empty key list", () => {
    for (const bad of ["polaris", "app..twa", "1app.polaris", "app.polaris-pay", "app.polaris.", ""]) {
      assert.throws(() => buildAssetLinks(bad, [FP_A]), /not an Android package name/);
    }
    assert.throws(() => buildAssetLinks("app.polarispay.twa", []), /at least one/);
  });
});

describe("assetLinksFromEnv", () => {
  it("defaults the package to apps/android's", () => {
    const result = assetLinksFromEnv({ POLARIS_ANDROID_SHA256_FINGERPRINTS: FP_A });
    assert.equal(result.status, 200);
    assert.equal(DEFAULT_ANDROID_PACKAGE, "app.polarispay.twa");
    assert.equal(result.status === 200 && result.statements[0]?.target.package_name, DEFAULT_ANDROID_PACKAGE);
  });

  it("takes a package from the environment", () => {
    const result = assetLinksFromEnv({ POLARIS_ANDROID_PACKAGE: " app.polarispay.twa.staging ", POLARIS_ANDROID_SHA256_FINGERPRINTS: FP_A });
    assert.equal(result.status === 200 && result.statements[0]?.target.package_name, "app.polarispay.twa.staging");
  });

  it("is 404 with no fingerprint, and 500 for a bad fingerprint or package", () => {
    assert.equal(assetLinksFromEnv({}).status, 404);
    assert.equal(assetLinksFromEnv({ POLARIS_ANDROID_PACKAGE: "app.polarispay.twa" }).status, 404);
    assert.equal(assetLinksFromEnv({ POLARIS_ANDROID_SHA256_FINGERPRINTS: "zz" }).status, 500);
    assert.equal(assetLinksFromEnv({ POLARIS_ANDROID_PACKAGE: "nope", POLARIS_ANDROID_SHA256_FINGERPRINTS: FP_A }).status, 500);
  });
});

describe("assetLinksResponse", () => {
  it("serves the statements as JSON", async () => {
    const response = assetLinksResponse({ POLARIS_ANDROID_SHA256_FINGERPRINTS: `${FP_A} ${FP_B}` });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.match(response.headers.get("cache-control") ?? "", /max-age=3600/);
    assert.deepEqual(await response.json(), buildAssetLinks(DEFAULT_ANDROID_PACKAGE, [FP_A, FP_B]));
  });

  it("says why when nothing is configured, and is never cached", async () => {
    const response = assetLinksResponse({});
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match((await response.json()).error, /POLARIS_ANDROID_SHA256_FINGERPRINTS is not set/);
  });

  it("keeps a misconfiguration's detail out of the public body", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, "error", (message: string) => logged.push(message));
    const response = assetLinksResponse({ POLARIS_ANDROID_SHA256_FINGERPRINTS: `${FP_A},not-a-key` });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.doesNotMatch(body, /not-a-key|entry 2/);
    assert.match(body, /misconfigured/);
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", /entry 2 of 2/);
  });
});
