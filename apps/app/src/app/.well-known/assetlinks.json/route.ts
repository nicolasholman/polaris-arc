import { assetLinksResponse } from "@/lib/assetlinks";

/**
 * GET /.well-known/assetlinks.json: Digital Asset Links for the Android app
 * (apps/android). Android fetches it to verify the Trusted Web Activity, so the
 * app opens this site full screen and https links to it open in the app.
 * Built per request from POLARIS_ANDROID_PACKAGE and
 * POLARIS_ANDROID_SHA256_FINGERPRINTS (src/lib/assetlinks.ts); 404 until a
 * fingerprint is set.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return assetLinksResponse({
    POLARIS_ANDROID_PACKAGE: process.env.POLARIS_ANDROID_PACKAGE,
    POLARIS_ANDROID_SHA256_FINGERPRINTS: process.env.POLARIS_ANDROID_SHA256_FINGERPRINTS,
  });
}
