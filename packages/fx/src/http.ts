import type { FxService } from "./service.ts";

/**
 * The `/api/fx?currency=ARS` handler, shared so every app answers the same
 * way: 400 for anything but a three-letter code, otherwise the service's
 * `FxLookup` as JSON (200 even when there is no rate: "no rate" is an answer,
 * and the app shows no line). Everyone gets the same public answer, so
 * browsers may cache it briefly; the age printed next to it comes from the
 * feed's own `updatedAt`, not from when the response was fetched.
 */
export async function handleFxRequest(service: FxService, request: Request): Promise<Response> {
  const currency = new URL(request.url).searchParams.get("currency")?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return Response.json({ error: "Pass a three-letter currency code, for example ?currency=ARS." }, { status: 400 });
  }
  const result = await service.lookup(currency);
  return Response.json(result, {
    headers: {
      "Cache-Control": result.status === "ok" ? "public, max-age=60, stale-while-revalidate=240" : "public, max-age=30",
    },
  });
}
