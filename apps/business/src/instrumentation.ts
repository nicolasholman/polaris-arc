/**
 * Next.js calls `register` once per server process. On the Node runtime it
 * starts the background loops (chain sync, late receipts, webhook retries,
 * automatic payouts) unless POLARIS_WORKERS=0; serverless deployments use
 * `/api/cron/tick` instead. A misconfiguration is logged, never fatal: the
 * dashboard and the API still start, and /api/health tells the operator what is missing.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { productionProblems } = await import("./server/env");
    for (const problem of productionProblems()) console.warn(`[config] ${problem}`);
  } catch (error) {
    console.error("[config] can't be read:", (error as Error).message);
  }
  if (process.env.POLARIS_WORKERS === "0") return;
  try {
    const { startWorkers } = await import("./server/workers");
    startWorkers();
  } catch (error) {
    console.error("[workers] not started:", (error as Error).message);
  }
}
