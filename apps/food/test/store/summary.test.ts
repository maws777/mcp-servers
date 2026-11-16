// AI summaries against DynamoDB Local, with a fake model: when a summary is
// generated, cached, refused; and what /api/summary answers.

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleApi } from "../../src/dashboard/api";
import type { Nutrition } from "../../src/domain/nutrition";
import { createEntry, deleteEntry } from "../../src/store/entries";
import { generateSummary } from "../../src/summary/generate";
import type { InvokeModel } from "../../src/summary/model";
import { getSummary, listNotes, listUsers, takeQuota } from "../../src/summary/store";

const TZ = "Europe/Paris";
const now = new Date("2026-11-16T18:00:00Z"); // 19:00 in Paris
const DAY = "2026-11-16";
const newUser = () => `test-${randomUUID()}`;
const pasta: Nutrition = { kcal: 600, protein_g: 22, carbs_g: 90, fat_g: 14, fiber_g: 6, alcohol_g: 0 };

function log(sub: string, eatenAt = "2026-11-16T11:30:00Z", description = "Pâtes") {
  return createEntry(sub, { description, meal: "lunch", items: [{ name: "pâtes", ...pasta }], totals: pasta, eatenAt: new Date(eatenAt) }, TZ, {
    key: randomUUID(),
    request: { eatenAt, description },
  });
}

/** A model that answers `output` and records what it was shown. */
function fakeModel(output: unknown = { resume: "Belle journée de pâtes.", conseil: "Ajoute des légumes ce soir.", note: "Jour pâtes." }) {
  return vi.fn<InvokeModel>(async () => ({ output, stop_reason: "end_turn", input_tokens: 900, output_tokens: 80 }));
}

describe("generateSummary", () => {
  it("generates once, then serves the cache until the day changes", async () => {
    const sub = newUser();
    await log(sub);
    const model = fakeModel();

    expect(await generateSummary(sub, DAY, { final: false, model, now })).toBe("generated");
    expect(await generateSummary(sub, DAY, { final: false, model, now })).toBe("fresh");
    expect(model).toHaveBeenCalledTimes(1);

    const saved = await getSummary(sub, DAY);
    expect(saved).toMatchObject({ resume: "Belle journée de pâtes.", conseil: "Ajoute des légumes ce soir.", final: false });

    await log(sub, "2026-11-16T17:00:00Z", "Pomme");
    expect(await generateSummary(sub, DAY, { final: false, model, now })).toBe("generated");
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("shows the model the numbers and the meals, never another user's", async () => {
    const sub = newUser();
    await log(sub);
    await log(newUser(), undefined, "Repas de quelqu'un d'autre");
    const model = fakeModel();
    await generateSummary(sub, DAY, { final: false, model, now });

    const ctx = model.mock.calls[0]![0];
    expect(ctx.stats.total_du_jour.kcal).toBe(600);
    expect(ctx.stats.heure_locale).toBe("19:00");
    expect(ctx.repas.map((r) => r.description)).toEqual(["Pâtes"]);
  });

  it("only summarizes today, and only a day with entries", async () => {
    const sub = newUser();
    const model = fakeModel();
    expect(await generateSummary(sub, DAY, { final: false, model, now })).toBe("empty");
    await log(sub, "2026-11-15T11:30:00Z");
    expect(await generateSummary(sub, "2026-11-15", { final: false, model, now })).toBe("not_today");
    expect(model).not.toHaveBeenCalled();
  });

  it("keeps the previous summary when the answer is invalid", async () => {
    const sub = newUser();
    await log(sub);
    await generateSummary(sub, DAY, { final: false, model: fakeModel(), now });
    await log(sub, "2026-11-16T17:00:00Z", "Pomme");

    expect(await generateSummary(sub, DAY, { final: false, model: fakeModel({ resume: "x".repeat(1000), conseil: "", note: "" }), now })).toBe("invalid");
    expect((await getSummary(sub, DAY))?.resume).toBe("Belle journée de pâtes.");
  });

  it("closes the day: a final summary over a fresh one, plus the diary note", async () => {
    const sub = newUser();
    await log(sub);
    await generateSummary(sub, DAY, { final: false, model: fakeModel(), now });

    expect(await generateSummary(sub, DAY, { final: true, model: fakeModel(), now })).toBe("generated");
    expect((await getSummary(sub, DAY))?.final).toBe(true);
    expect(await listNotes(sub, DAY, DAY)).toEqual([{ date: DAY, note: "Jour pâtes." }]);
    expect(await listUsers()).toContain(sub);
    // Closed and unchanged: nothing more to do.
    expect(await generateSummary(sub, DAY, { final: true, model: fakeModel(), now })).toBe("fresh");
  });

  it("the quota is one conditional counter: concurrent calls can't overshoot it", async () => {
    const sub = newUser();
    const taken = await Promise.all(Array.from({ length: 5 }, () => takeQuota(sub, DAY, 3, now)));
    expect(taken.filter(Boolean)).toHaveLength(3);
  });
});

describe("/api/summary", () => {
  const api = (sub: string, requestSummary = vi.fn(async () => {})) => ({
    requestSummary,
    call: () => handleApi(sub, "/api/summary", new URLSearchParams(`date=${DAY}`), now, { requestSummary }),
  });

  it("asks for a summary when there's none, then serves it once generated", async () => {
    const sub = newUser();
    await log(sub);
    const { requestSummary, call } = api(sub);

    expect((await call()).body).toMatchObject({ status: "pending", summary: null });
    expect(requestSummary).toHaveBeenCalledWith(sub, DAY);

    await generateSummary(sub, DAY, { final: false, model: fakeModel(), now });
    expect((await call()).body).toMatchObject({ status: "ready", summary: { resume: "Belle journée de pâtes." } });
    expect(requestSummary).toHaveBeenCalledTimes(1);
  });

  it("doesn't ask twice while a generation for the same state is running", async () => {
    const sub = newUser();
    await log(sub);
    // A generation that has started but not finished: the model never returns here.
    const slow: InvokeModel = () => new Promise(() => {});
    void generateSummary(sub, DAY, { final: false, model: slow, now });
    await vi.waitFor(async () => expect((await getSummary(sub, DAY))?.generating_hash).toBeTruthy());

    const { requestSummary, call } = api(sub);
    expect((await call()).body).toMatchObject({ status: "pending" });
    expect(requestSummary).not.toHaveBeenCalled();
  });

  it("serves an out-of-date summary as stale after the entries are gone, without asking", async () => {
    const sub = newUser();
    const entry = await log(sub);
    await generateSummary(sub, DAY, { final: false, model: fakeModel(), now });
    await deleteEntry(sub, entry.entry.entry_id);

    const { requestSummary, call } = api(sub);
    expect((await call()).body).toMatchObject({ status: "stale", summary: { resume: "Belle journée de pâtes." } });
    expect(requestSummary).not.toHaveBeenCalled();
  });
});
