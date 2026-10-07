/**
 * Dates in English (the app's language) with the viewer's regional order:
 * "Sep 28" in the US, "28 Sept" in Germany. Client-side only.
 */
function uiLocale(): string {
  if (typeof navigator === "undefined") return "en-US";
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return region ? `en-${region}` : "en-US";
  } catch {
    return "en-US";
  }
}

let locale: string | undefined;
const fmt = (options: Intl.DateTimeFormatOptions) => {
  locale ??= uiLocale();
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat("en-US", options);
  }
};

export function shortDate(ts: number): string {
  return fmt({ month: "short", day: "numeric" }).format(ts);
}

export function longDate(ts: number): string {
  return fmt({ weekday: "short", month: "short", day: "numeric" }).format(ts);
}

export function time(ts: number): string {
  return fmt({ hour: "numeric", minute: "2-digit" }).format(ts);
}

export function monthYear(ts: number): string {
  return fmt({ month: "long", year: "numeric" }).format(ts);
}

export function dateTime(ts: number): string {
  return `${shortDate(ts)} · ${time(ts)}`;
}

/** "Today", "Yesterday", or "Sep 24", for grouping lists. */
export function dayLabel(ts: number, now = Date.now()): string {
  const start = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((start(now) - start(ts)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return shortDate(ts);
}

/**
 * "today", "tomorrow", "in 19 days": always relative, never a date, for a
 * line that sits beside the date itself ("Oct 16 / in 19 days").
 */
export function inDays(ts: number, now = Date.now()): string {
  const days = Math.round((ts - now) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** "in 5 days", "tomorrow", "today". */
export function relativeDay(ts: number, now = Date.now()): string {
  const days = Math.round((ts - now) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  return `on ${shortDate(ts)}`;
}
