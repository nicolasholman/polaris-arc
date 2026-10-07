/**
 * `@polarispay/underwriting/testing`: test doubles for the provider APIs.
 *
 * Fixture files in the providers' documented shapes, and transports that
 * answer from them. For tests only: the product never imports this entry
 * (`test/no-fixtures-in-product.test.ts` holds the package to that), so a
 * provider without its key is "not configured", never answered from here.
 */

export { fixtureTransport, fixtureResponse, locateFixture, DEFAULT_FIXTURES_DIR, type FixtureFile } from "./fixtures.ts";
