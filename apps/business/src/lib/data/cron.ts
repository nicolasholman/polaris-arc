/**
 * The CRE cron trigger's schedules (six fields: second minute hour
 * day-of-month month day-of-week, UTC), in words and with their next fire.
 * Only what the Polaris workflows use is understood: `*`, `*\/n`, a number
 * and a comma list in the first three fields, `*` in the last three.
 * Anything else reads as the raw expression and has no computed next run.
 */

type Field = { every: number; values: number[] | null };

function field(text: string, max: number): Field | null {
  if (text === "*") return { every: 1, values: null };
  const step = /^\*\/(\d+)$/.exec(text);
  if (step) {
    const n = Number(step[1]);
    return n > 0 && n < max ? { every: n, values: null } : null;
  }
  if (/^\d+(,\d+)*$/.test(text)) {
    const values = text.split(",").map(Number);
    return values.every((v) => v < max) ? { every: 0, values } : null;
  }
  return null;
}

export type ParsedCron = { second: Field; minute: Field; hour: Field };

export function parseCron(expression: string): ParsedCron | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 6) return null;
  const [s, m, h, dom, mon, dow] = parts as [string, string, string, string, string, string];
  if (dom !== "*" || mon !== "*" || (dow !== "*" && dow !== "?")) return null;
  const second = field(s, 60);
  const minute = field(m, 60);
  const hour = field(h, 24);
  return second && minute && hour ? { second, minute, hour } : null;
}

function matches(f: Field, v: number): boolean {
  return f.values ? f.values.includes(v) : v % f.every === 0;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Every minute", "Every 10 minutes", "Every 30 seconds", "Daily at 14:00 UTC", or the expression itself. */
export function describeCron(expression: string): string {
  const c = parseCron(expression);
  if (!c) return `Cron ${expression}`;
  const single = (f: Field) => (f.values && f.values.length === 1 ? f.values[0]! : null);
  const s = single(c.second);
  const m = single(c.minute);
  const h = single(c.hour);
  if (!c.second.values && c.minute.every === 1 && !c.minute.values && c.hour.every === 1 && !c.hour.values) {
    return c.second.every === 1 ? "Every second" : `Every ${c.second.every} seconds`;
  }
  if (s !== null && !c.minute.values && !c.hour.values && c.hour.every === 1) {
    return c.minute.every === 1 ? "Every minute" : `Every ${c.minute.every} minutes`;
  }
  if (s !== null && m !== null && !c.hour.values) return c.hour.every === 1 ? `Hourly at :${pad(m)}` : `Every ${c.hour.every} hours at :${pad(m)}`;
  if (s !== null && m !== null && h !== null) return `Daily at ${pad(h)}:${pad(m)} UTC`;
  return `Cron ${expression}`;
}

/** When the schedule next fires after `after` (ms), or null for an expression this doesn't read. */
export function nextCronFire(expression: string, after: number): number | null {
  const c = parseCron(expression);
  if (!c) return null;
  // Step second by second from the next whole second: at most a day of steps, skipping whole minutes and hours that can't match.
  let t = Math.floor(after / 1000) * 1000 + 1000;
  const limit = t + 2 * 86_400_000;
  while (t <= limit) {
    const d = new Date(t);
    if (!matches(c.hour, d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!matches(c.minute, d.getUTCMinutes())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes() + 1);
      continue;
    }
    if (matches(c.second, d.getUTCSeconds())) return t;
    t += 1000;
  }
  return null;
}
