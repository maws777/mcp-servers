// Times and days in my time zone. A "day" is a calendar day in Europe/Paris,
// not in UTC: a snack at 00:30 Paris time (23:30 UTC) belongs to the new day.
// Lambda runs in UTC, so every conversion goes through Intl with an explicit
// time zone; nothing relies on the machine's local time.

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Wall-clock parts of an instant in a time zone. */
function wallClock(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

/** Offset of the time zone from UTC at that instant, in milliseconds (+1 h in Paris winter). */
function offsetMs(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(+w.y, +w.m - 1, +w.d, +w.h, +w.min, +w.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Local date ("2026-11-09") and time ("19:42:05") of an instant. */
export function localParts(instant: Date, timeZone: string): { date: string; time: string } {
  const w = wallClock(instant, timeZone);
  return { date: `${w.y}-${w.m}-${w.d}`, time: `${w.h}:${w.min}:${w.s}` };
}

export function today(timeZone: string, now = new Date()): string {
  return localParts(now, timeZone).date;
}

/**
 * Turns what Claude sends into an instant:
 * - nothing: now;
 * - with an offset or Z ("2026-11-09T19:30:00+01:00"): that instant;
 * - without ("2026-11-09T19:30", "2026-11-09"): wall-clock time in my time
 *   zone (a bare date means noon). Two passes handle daylight-saving changes.
 */
export function resolveInstant(input: string | undefined, timeZone: string, now = new Date()): Date {
  if (!input) return now;
  const s = input.trim();
  if (OFFSET_RE.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`can't read the time "${input}"`);
    return d;
  }
  const m = LOCAL_RE.exec(s);
  if (!m) throw new Error(`can't read the time "${input}" (use 2026-11-09T19:30 or 2026-11-09)`);
  const [, y, mo, d, h = "12", mi = "00", se = "00"] = m;
  const wallAsUtc = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +se);
  let guess = wallAsUtc - offsetMs(new Date(wallAsUtc), timeZone);
  guess = wallAsUtc - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** Refuses meal times in the future (beyond a small clock skew) or more than a year back. */
export function timeProblem(instant: Date, now = new Date()): string | null {
  if (instant.getTime() > now.getTime() + 10 * 60_000) return "that time is in the future";
  if (instant.getTime() < now.getTime() - 366 * 86_400_000) return "that time is more than a year ago";
  return null;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
