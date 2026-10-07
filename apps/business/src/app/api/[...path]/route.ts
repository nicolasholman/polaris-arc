import { withMerchant } from "@/server/auth";
import { fail } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Any /api path that isn't a route: a JSON 404 rather than the HTML page.
 * Still behind withMerchant, so an anonymous caller learns nothing about
 * which paths exist (it gets the same 401 as everywhere else).
 */
const notFound = async () => fail(404, "not_found", "There's no API endpoint at this path.");

export const GET = withMerchant(notFound);
export const POST = withMerchant(notFound);
export const PUT = withMerchant(notFound);
export const PATCH = withMerchant(notFound);
export const DELETE = withMerchant(notFound);
