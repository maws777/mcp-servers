// What the MCP tools and the dashboard API both show: a day, trends, the
// fridge. One implementation, so the numbers Claude reports and the numbers
// on the phone can't disagree.

import { WHOLE, ageInDays, describeRemaining, scale } from "../domain/batch";
import { ZERO, addNutrition, type Nutrition } from "../domain/nutrition";
import { daysBetween, today } from "../domain/time";
import type { Batch } from "../store/batches";
import { listEntries, type Entry } from "../store/entries";
import { getProfile, listWeights, type Profile } from "../store/profile";

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The date `days - 1` days before `to`, so the range covers `days` days. */
export function startOf(to: string, days: number): string {
  const d = new Date(`${to}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i <= daysBetween(from, to); i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Nutrition per local date. */
export function totalsByDay(entries: Entry[]): Map<string, Nutrition> {
  const byDay = new Map<string, Nutrition>();
  for (const e of entries) byDay.set(e.local_date, addNutrition(byDay.get(e.local_date) ?? ZERO, e.totals));
  return byDay;
}

// --- One day -------------------------------------------------------------------

export function summarizeDay(day: string, entries: Entry[], profile: Profile) {
  const totals = entries.reduce((acc, e) => addNutrition(acc, e.totals), ZERO);
  const byMeal: Record<string, Nutrition> = {};
  for (const e of entries) {
    const key = e.meal ?? "unspecified";
    byMeal[key] = addNutrition(byMeal[key] ?? ZERO, e.totals);
  }
  const remaining = profile.targets
    ? Object.fromEntries(
        Object.entries(profile.targets).map(([k, target]) => [k, round1((target ?? 0) - totals[k as keyof Nutrition])]),
      )
    : null;
  return {
    date: day,
    entries_count: entries.length,
    totals,
    by_meal: byMeal,
    targets: profile.targets ?? null,
    remaining_to_target: remaining,
  };
}

/** A day's summary, `date` defaulting to today in the user's time zone. */
export async function daySummary(sub: string, date?: string) {
  const profile = await getProfile(sub);
  const day = date ?? today(profile.time_zone);
  const entries = await listEntries(sub, day, day);
  return { summary: summarizeDay(day, entries, profile), entries, profile };
}

// --- Trends --------------------------------------------------------------------

export async function trends(sub: string, days: number, now = new Date()) {
  const profile = await getProfile(sub);
  const to = today(profile.time_zone, now);
  const from = startOf(to, days);
  const [entries, weights] = await Promise.all([listEntries(sub, from, to), listWeights(sub, from, to)]);

  const byDay = totalsByDay(entries);
  const daily = eachDay(from, to).map((date) => ({ date, logged: byDay.has(date), ...(byDay.get(date) ?? ZERO) }));
  const logged = daily.filter((d) => d.logged && d.date !== to); // today is still in progress

  const average = logged.length
    ? (Object.fromEntries(
        (Object.keys(ZERO) as (keyof Nutrition)[]).map((k) => [k, round1(logged.reduce((s, d) => s + d[k], 0) / logged.length)]),
      ) as unknown as Nutrition)
    : null;

  // kcal within ±10% of target; protein at least the target.
  const t = profile.targets;
  const onTarget = t
    ? {
        kcal_within_10pct: t.kcal ? logged.filter((d) => Math.abs(d.kcal - t.kcal!) <= 0.1 * t.kcal!).length : null,
        protein_reached: t.protein_g ? logged.filter((d) => d.protein_g >= t.protein_g!).length : null,
      }
    : null;

  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    const d = daily[i]!;
    if (d.date === to && !d.logged) continue; // nothing yet today doesn't break the streak
    if (!d.logged) break;
    streak++;
  }

  const first = weights[0];
  const last = weights[weights.length - 1];
  return {
    from,
    to,
    days_logged: logged.length,
    days_complete: daily.length - 1,
    logging_streak_days: streak,
    average_per_logged_day: average,
    targets: t ?? null,
    days_on_target: onTarget,
    weight: weights.length ? { first, last, change_kg: first && last ? round1(last.kg - first.kg) : null, measurements: weights } : null,
    daily,
  };
}

// --- Batches -------------------------------------------------------------------

/** What Claude and the dashboard need to know about a batch. */
export function batchView(batch: Batch, now = new Date()) {
  return {
    batch_id: batch.batch_id,
    name: batch.name,
    status: batch.status,
    remaining_fraction: batch.remaining / WHOLE,
    remaining: describeRemaining(batch),
    remaining_nutrition: scale(batch.totals, batch.remaining),
    totals: batch.totals,
    total_grams: batch.total_grams ?? null,
    raw_grams: batch.raw_grams ?? null,
    portions: batch.portions ?? null,
    cooked_at: batch.cooked_at,
    age_days: ageInDays(batch.cooked_at, now),
    items: batch.items,
  };
}
