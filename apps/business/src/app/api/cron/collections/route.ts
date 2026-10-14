import { withCron } from "@/server/auth";
import { ok } from "@/server/http";
import { loadConfig } from "../../../../../../../services/keeper/src/config.ts";
import { clientsFor } from "../../../../../../../services/keeper/src/chain.ts";
import { runCollections } from "../../../../../../../services/keeper/src/collections.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** One bounded collection pass. Shared chain state is authoritative; no socket or loop. */
export const GET = withCron(async () => {
  const config = loadConfig();
  if (config.chainId !== 5042002) throw new Error("This hosted keeper is restricted to Arc testnet");
  const result = await runCollections(clientsFor(config), config, 0n);
  return ok(result);
});
export const POST = GET;
