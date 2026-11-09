// Calls to the dashboard API, same origin (/api/... through CloudFront).

import { accessToken, type Config } from "./auth";

export interface Nutrition {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  alcohol_g: number;
}

export interface DayResponse {
  today: string;
  summary: {
    date: string;
    totals: Nutrition;
    targets: Partial<Nutrition> | null;
    remaining_to_target: Partial<Nutrition> | null;
  };
  entries: {
    entry_id: string;
    local_time: string;
    meal: "breakfast" | "lunch" | "dinner" | "snack" | null;
    description: string;
    totals: Nutrition;
    from_batch: boolean;
    items: { name: string; quantity: string | null; kcal: number }[];
  }[];
}

export interface TrendsResponse {
  from: string;
  to: string;
  days_logged: number;
  days_complete: number;
  logging_streak_days: number;
  average_per_logged_day: Nutrition | null;
  targets: Partial<Nutrition> | null;
  days_on_target: { kcal_within_10pct: number | null; protein_reached: number | null } | null;
  weight: { first?: { date: string; kg: number }; last?: { date: string; kg: number }; change_kg: number | null } | null;
  daily: ({ date: string; logged: boolean } & Nutrition)[];
}

export interface FridgeResponse {
  batches: {
    batch_id: string;
    name: string;
    remaining_fraction: number;
    remaining_nutrition: Nutrition;
    total_grams: number | null;
    portions: number | null;
    age_days: number;
  }[];
}

export interface HistoryResponse {
  month: string;
  target_kcal: number | null;
  days: { date: string; logged: boolean; kcal: number }[];
}

/** Thrown when there's no way to get a token: the page shows the login screen. */
export class NeedsLogin extends Error {}

export async function get<T>(cfg: Config, path: string): Promise<T> {
  let token = await accessToken(cfg);
  if (!token) throw new NeedsLogin();
  let res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    // Revoked or expired early: one refresh, one retry.
    token = await accessToken(cfg, { force: true });
    if (!token) throw new NeedsLogin();
    res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new NeedsLogin();
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}
