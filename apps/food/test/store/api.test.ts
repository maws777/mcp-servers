// The dashboard API (src/dashboard/api.ts) against DynamoDB Local.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleApi, monthEnd } from "../../src/dashboard/api";
import type { Nutrition } from "../../src/domain/nutrition";
import { createBatch } from "../../src/store/batches";
import { createEntry } from "../../src/store/entries";
import { updateProfile } from "../../src/store/profile";

const TZ = "Europe/Paris";
const now = new Date("2026-11-09T18:00:00Z");
const newUser = () => `test-${randomUUID()}`;

const oats: Nutrition = { kcal: 380, protein_g: 14, carbs_g: 60, fat_g: 8, fiber_g: 9, alcohol_g: 0 };

function logOats(sub: string, eatenAt: string, description = "Oats") {
  return createEntry(sub, { description, meal: "breakfast", items: [{ name: "oats", quantity: "100 g", ...oats }], totals: oats, eatenAt: new Date(eatenAt) }, TZ, {
    key: randomUUID(),
    request: { eatenAt, description },
  });
}

const get = (sub: string, path: string, query = "") => handleApi(sub, path, new URLSearchParams(query), now);

describe("dashboard API", () => {
  it("/api/day: entries and totals against targets", async () => {
    const sub = newUser();
    await updateProfile(sub, { targets: { kcal: 2000 } });
    await logOats(sub, "2026-11-09T07:00:00Z");
    await logOats(sub, "2026-11-09T15:00:00Z");

    const res = await get(sub, "/api/day", "date=2026-11-09");
    const body = res.body as { today: string; summary: { totals: Nutrition; remaining_to_target: { kcal: number } }; entries: unknown[] };
    expect(res.status).toBe(200);
    expect(body.today).toBe("2026-11-09");
    expect(body.entries).toHaveLength(2);
    expect(body.summary.totals.kcal).toBe(760);
    expect(body.summary.remaining_to_target.kcal).toBe(1240);
  });

  it("/api/day: never exposes the table's internal keys", async () => {
    const sub = newUser();
    await logOats(sub, "2026-11-09T07:00:00Z");
    const text = JSON.stringify((await get(sub, "/api/day", "date=2026-11-09")).body);
    expect(text).not.toContain("USER#");
    expect(text).not.toContain(sub);
  });

  it("/api/day: refuses a malformed date", async () => {
    expect((await get(newUser(), "/api/day", "date=09/11/2026")).status).toBe(400);
  });

  it("one user's request never returns another user's entries", async () => {
    const me = newUser();
    await logOats(me, "2026-11-09T07:00:00Z");
    const res = await get(newUser(), "/api/day", "date=2026-11-09");
    expect((res.body as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("/api/history: one row per day of the month, kcal on logged days", async () => {
    const sub = newUser();
    await logOats(sub, "2026-11-03T07:00:00Z");
    const res = await get(sub, "/api/history", "month=2026-11");
    const days = (res.body as { days: { date: string; logged: boolean; kcal: number }[] }).days;
    expect(days).toHaveLength(30);
    expect(days.find((d) => d.date === "2026-11-03")).toEqual({ date: "2026-11-03", logged: true, kcal: 380 });
    expect(days.filter((d) => d.logged)).toHaveLength(1);
  });

  it("/api/trends: validates days, then reports the range", async () => {
    const sub = newUser();
    expect((await get(sub, "/api/trends", "days=3")).status).toBe(400);
    const res = await get(sub, "/api/trends", "days=7");
    expect(res.status).toBe(200);
    expect((res.body as { from: string; to: string }).to).toBe("2026-11-09");
    expect((res.body as { from: string }).from).toBe("2026-11-03");
  });

  it("/api/fridge: open batches with what's left", async () => {
    const sub = newUser();
    await createBatch(
      sub,
      { name: "Chili", items: [{ name: "chili", ...oats }], totals: oats, portions: 4, cookedAt: new Date("2026-11-07T18:00:00Z") },
      { key: randomUUID(), request: {} },
    );
    const res = await get(sub, "/api/fridge");
    const batches = (res.body as { batches: { name: string; age_days: number; remaining_fraction: number }[] }).batches;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ name: "Chili", remaining_fraction: 1, age_days: 2 });
  });

  it("unknown routes are 404", async () => {
    expect((await get(newUser(), "/api/entries")).status).toBe(404);
  });
});

describe("monthEnd", () => {
  it("knows month lengths and leap years", () => {
    expect(monthEnd("2026-11")).toBe("2026-11-30");
    expect(monthEnd("2026-12")).toBe("2026-12-31");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
  });
});
