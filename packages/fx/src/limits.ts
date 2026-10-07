/** A rate older than this is treated as missing (26 h: Ethereum FX feeds' 24 h heartbeat plus slack). */
export const FX_MAX_AGE_SECONDS = 26 * 60 * 60;

/** Slack on top of a feed's heartbeat before it counts as stopped. */
export const FX_HEARTBEAT_SLACK_SECONDS = 10 * 60;

/**
 * How old one feed's rate may be before the next source in its currency's
 * list is tried: twice its heartbeat, or its heartbeat plus 10 minutes,
 * whichever is longer, and never past `cap` (26 h). A Monad FX feed
 * (240 s heartbeat) that stopped is stale after 14 min, not 26 h, so the
 * fresher fallback is read; an Ethereum one (24 h) keeps the 26 h cap.
 */
export function sourceMaxAgeSeconds(source: { heartbeatSeconds: number }, cap: number = FX_MAX_AGE_SECONDS): number {
  const own = Math.max(2 * source.heartbeatSeconds, source.heartbeatSeconds + FX_HEARTBEAT_SLACK_SECONDS);
  return Math.min(cap, own);
}
/** How long a good (or stale) read is kept before the feed is read again. */
export const FX_CACHE_MS = 5 * 60 * 1000;
/** How long a failed read is kept, so a flaky RPC is retried soon but not hammered. */
export const FX_ERROR_CACHE_MS = 30 * 1000;
