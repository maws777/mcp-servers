// The dashboard's read-only API (docs/design/food-dashboard.md, section 2).
//
//   GET /api/day?date=YYYY-MM-DD     entries of the day, totals vs targets
//   GET /api/trends?days=7..90       daily totals, averages, weight
//   GET /api/fridge                  open batches
//   GET /api/history?month=YYYY-MM   kcal per day, for the calendar
//   GET /api/summary?date=YYYY-MM-DD the AI summary of the day (phase 4b)
//
// Every number comes from src/views, the same code the MCP tools use. The
// user is the token's `sub`, passed in by the Lambda entry; nothing in the
// request can name another user.

import { DATE_RE, today } from "../domain/time";
import { listBatches } from "../store/batches";
import { listEntries, type Entry } from "../store/entries";
import { getProfile } from "../store/profile";
import { dayHash } from "../summary/context";
import { getSummary, isFresh, type SummaryItem } from "../summary/store";
import { batchView, daySummary, eachDay, totalsByDay, trends } from "../views";

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface ApiDeps {
  /** Asks the summary Lambda for a new summary, without waiting for it. */
  requestSummary?: (sub: string, date: string) => Promise<void>;
}

/** A generation started less than this ago is assumed to be still running. */
const GENERATING_FOR_MS = 60_000;

const summaryView = (s: SummaryItem | undefined) =>
  s?.resume ? { resume: s.resume, conseil: s.conseil ?? "", final: Boolean(s.final), generated_at: s.generated_at ?? null } : null;

/**
 * The cached summary, and whether it matches the day as it is now.
 *   ready    the summary was built from exactly these entries
 *   pending  it's out of date (or missing) and a new one was asked for:
 *            the page shows the old one and asks again a few seconds later
 *   stale    out of date, and nothing will be generated (a past day)
 *   none     nothing to summarize
 * This Lambda can't write and can't call the model: it only reads and asks.
 */
async function summaryRoute(sub: string, date: string | undefined, now: Date, deps: ApiDeps): Promise<ApiResult> {
  const { summary: day, entries, profile } = await daySummary(sub, date);
  const isToday = day.date === today(profile.time_zone, now);
  const hash = dayHash(entries, profile);
  const item = await getSummary(sub, day.date);
  const body = (status: string) => ({ status: 200, body: { date: day.date, status, summary: summaryView(item) } });

  if (isFresh(item, hash)) return body("ready");
  if (entries.length === 0) return body(item?.resume ? "stale" : "none");
  if (!isToday || !deps.requestSummary) return body(item?.resume ? "stale" : "none");

  const started = item?.generating_hash === hash && item.generating_at && now.getTime() - Date.parse(item.generating_at) < GENERATING_FOR_MS;
  if (!started) await deps.requestSummary(sub, day.date);
  return body("pending");
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const bad = (message: string): ApiResult => ({ status: 400, body: { error: "bad_request", message } });

/** What the page shows for an entry. No internal keys. */
function entryView(e: Entry) {
  return {
    entry_id: e.entry_id,
    local_time: e.local_time,
    meal: e.meal ?? null,
    description: e.description,
    totals: e.totals,
    from_batch: Boolean(e.batch_id),
    items: e.items.map((i) => ({ name: i.name, quantity: i.quantity ?? null, kcal: i.kcal })),
  };
}

/** Last day of a YYYY-MM month. */
function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of the next month
}

export async function handleApi(sub: string, path: string, query: URLSearchParams, now = new Date(), deps: ApiDeps = {}): Promise<ApiResult> {
  switch (path) {
    case "/api/day": {
      const date = query.get("date") ?? undefined;
      if (date !== undefined && !DATE_RE.test(date)) return bad("date must be YYYY-MM-DD");
      const { summary, entries, profile } = await daySummary(sub, date);
      return {
        status: 200,
        body: { today: today(profile.time_zone, now), summary, entries: entries.map(entryView) },
      };
    }

    case "/api/trends": {
      const days = Number(query.get("days") ?? "7");
      if (!Number.isInteger(days) || days < 7 || days > 90) return bad("days must be a whole number from 7 to 90");
      return { status: 200, body: await trends(sub, days, now) };
    }

    case "/api/fridge": {
      const batches = await listBatches(sub, false);
      return { status: 200, body: { batches: batches.map((b) => batchView(b, now)) } };
    }

    case "/api/history": {
      const profile = await getProfile(sub);
      const month = query.get("month") ?? today(profile.time_zone, now).slice(0, 7);
      if (!MONTH_RE.test(month)) return bad("month must be YYYY-MM");
      const from = `${month}-01`;
      const to = monthEnd(month);
      const byDay = totalsByDay(await listEntries(sub, from, to));
      return {
        status: 200,
        body: {
          month,
          target_kcal: profile.targets?.kcal ?? null,
          days: eachDay(from, to).map((date) => ({ date, logged: byDay.has(date), kcal: byDay.get(date)?.kcal ?? 0 })),
        },
      };
    }

    case "/api/summary": {
      const date = query.get("date") ?? undefined;
      if (date !== undefined && !DATE_RE.test(date)) return bad("date must be YYYY-MM-DD");
      return summaryRoute(sub, date, now, deps);
    }

    default:
      return { status: 404, body: { error: "not_found" } };
  }
}

// Exported for tests.
export { monthEnd };
