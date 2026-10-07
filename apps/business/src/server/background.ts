import "server-only";

import { after } from "next/server";

/**
 * Run `task` after the response is sent. Inside a Next.js request this is
 * `after()` (the platform keeps the function alive for it); anywhere else
 * (a worker loop, a test calling a route handler directly) it runs on the
 * next tick. Errors are logged, never thrown at the caller.
 */
export function afterResponse(name: string, task: () => Promise<unknown>): void {
  const run = () => task().catch((error) => console.error(`[${name}] failed`, error));
  try {
    after(run);
  } catch {
    setTimeout(() => void run(), 0);
  }
}
