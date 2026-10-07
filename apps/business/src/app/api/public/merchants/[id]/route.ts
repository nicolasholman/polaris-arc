import { withPublic } from "@/server/auth";
import { getDb } from "@/server/db";
import { HttpError, ok, methodNotAllowed } from "@/server/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** A merchant's public profile: the `metadataURI` their MerchantRegistry entry points at. */
export const GET = withPublic<Ctx>(async (_req, _auth, { params }) => {
  const { id } = await params;
  const merchant = /^mer_[A-Za-z0-9]{8,64}$/.test(id) ? await getDb().merchants.findOne({ publicId: id }) : null;
  if (!merchant) throw new HttpError(404, "not_found", "No such merchant.");
  return ok({ id: merchant.publicId, name: merchant.businessName, payoutAddress: merchant.walletAddress, since: merchant.createdAt });
});

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);
