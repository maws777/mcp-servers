// The DynamoDB code against DynamoDB Local (vitest.config.ts, project "store").
//
// What these catch that the unit tests can't: the transactions themselves.
// Conditions, cancellation reasons and which item failed, idempotency
// records, optimistic locking: all of it is DynamoDB's behaviour, so it's
// tested against DynamoDB, not a mock of what we think it does.
//
// Each test gets its own user (partition), so tests never see each other.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WHOLE } from "../../src/domain/batch";
import type { Nutrition } from "../../src/domain/nutrition";
import { BatchChanged, createBatch, deletePortionEntry, eatFromBatch, getBatch, updateBatch, type Portion } from "../../src/store/batches";
import { IdempotencyConflict } from "../../src/store/db";
import { createEntry, deleteEntry, getEntry, getRecord, listEntries, updateEntry } from "../../src/store/entries";

const TZ = "Europe/Paris";
const newUser = () => `test-${randomUUID()}`;
const newKey = () => randomUUID();

const bananaTotals: Nutrition = { kcal: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4, fiber_g: 3.1, alcohol_g: 0 };
const banana = { name: "banana", quantity: "1", grams: 120, ...bananaTotals };
const breakfast = new Date("2026-11-09T07:30:00Z"); // 08:30 in Paris

function logBanana(sub: string, key = newKey(), eatenAt = breakfast) {
  return createEntry(sub, { description: "Banana", meal: "breakfast", items: [banana], totals: bananaTotals, eatenAt }, TZ, {
    key,
    request: { description: "Banana", eaten_at: eatenAt.toISOString() },
  });
}

describe("journal entries", () => {
  it("a retried create logs the meal once", async () => {
    const sub = newUser();
    const key = newKey();
    const first = await logBanana(sub, key);
    const retry = await logBanana(sub, key);

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.entry.entry_id).toBe(first.entry.entry_id);
    expect(await listEntries(sub, "2026-11-09", "2026-11-09")).toHaveLength(1);
  });

  it("refuses the same key for a different meal", async () => {
    const sub = newUser();
    const key = newKey();
    await logBanana(sub, key);

    const apple = { name: "apple", kcal: 95, protein_g: 0.5, carbs_g: 25, fat_g: 0.3 };
    await expect(
      createEntry(sub, { description: "Apple", items: [apple], totals: { ...bananaTotals, kcal: 95 }, eatenAt: breakfast }, TZ, {
        key,
        request: { description: "Apple" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(await listEntries(sub, "2026-11-09", "2026-11-09")).toHaveLength(1);
  });

  it("files an entry under the local date, not the UTC one", async () => {
    const sub = newUser();
    const { entry } = await logBanana(sub, newKey(), new Date("2026-11-08T23:30:00Z")); // 00:30 on the 9th in Paris

    expect(entry.local_date).toBe("2026-11-09");
    expect(await listEntries(sub, "2026-11-08", "2026-11-08")).toHaveLength(0);
    expect(await listEntries(sub, "2026-11-09", "2026-11-09")).toHaveLength(1);
  });

  it("moving an entry to another day keeps its ID", async () => {
    const sub = newUser();
    const { entry } = await logBanana(sub);
    await updateEntry(sub, entry.entry_id, { eatenAt: new Date("2026-11-08T19:00:00Z") }, TZ);

    expect(await listEntries(sub, "2026-11-09", "2026-11-09")).toHaveLength(0);
    expect(await listEntries(sub, "2026-11-08", "2026-11-08")).toHaveLength(1);
    expect((await getEntry(sub, entry.entry_id))?.local_date).toBe("2026-11-08");
  });

  it("a deleted entry disappears from reads but stays in the table", async () => {
    const sub = newUser();
    const { entry } = await logBanana(sub);

    expect(await deleteEntry(sub, entry.entry_id)).toBe(true);
    expect(await getEntry(sub, entry.entry_id)).toBeUndefined();
    expect(await listEntries(sub, "2026-11-09", "2026-11-09")).toHaveLength(0);
    expect((await getRecord(sub, entry.entry_id))?.deleted_at).toBeDefined();
  });

  it("one user never sees another's entries", async () => {
    const me = newUser();
    const someoneElse = newUser();
    const { entry } = await logBanana(me);

    expect(await listEntries(someoneElse, "2026-11-09", "2026-11-09")).toHaveLength(0);
    expect(await getEntry(someoneElse, entry.entry_id)).toBeUndefined();
  });
});

describe("meal-prep batches", () => {
  const chiliTotals: Nutrition = { kcal: 2400, protein_g: 180, carbs_g: 210, fat_g: 90, fiber_g: 60, alcohol_g: 0 };
  const lunch = new Date("2026-11-09T11:30:00Z");

  async function cookChili(sub: string) {
    const { batch } = await createBatch(
      sub,
      { name: "Chili", items: [{ name: "chili", ...chiliTotals }], totals: chiliTotals, portions: 6, cookedAt: new Date("2026-11-08T18:00:00Z") },
      { key: newKey(), request: { name: "Chili" } },
    );
    return batch;
  }

  const portion = (units: number, eatenBy: Portion["eatenBy"] = "me"): Portion => ({ units, eatenBy, eatenAt: lunch, meal: "lunch", label: "test" });
  const idem = () => ({ key: newKey(), request: { test: randomUUID() } });

  it("eating a third logs a third of the pot", async () => {
    const sub = newUser();
    const chili = await cookChili(sub);
    const { entry } = await eatFromBatch(sub, chili, portion(3333), TZ, idem());

    expect(entry?.totals.kcal).toBe(799.9); // 2400 x 0.3333
    expect(entry?.batch_id).toBe(chili.batch_id);
    expect((await getBatch(sub, chili.batch_id))?.remaining).toBe(WHOLE - 3333);
  });

  it("someone else's portion leaves my journal alone", async () => {
    const sub = newUser();
    const chili = await cookChili(sub);
    const { entry } = await eatFromBatch(sub, chili, portion(5000, "other"), TZ, idem());

    expect(entry).toBeUndefined();
    expect(await listEntries(sub, "2026-11-09", "2026-11-09")).toHaveLength(0);
    expect((await getBatch(sub, chili.batch_id))?.remaining).toBe(5000);
  });

  it("the last portion finishes the batch", async () => {
    const sub = newUser();
    const chili = await cookChili(sub);
    await eatFromBatch(sub, chili, portion(WHOLE), TZ, idem());

    const after = await getBatch(sub, chili.batch_id);
    expect(after?.status).toBe("finished");
    expect(after?.closed_at).toBeDefined();
  });

  it("two requests can't both take the same third", async () => {
    const sub = newUser();
    const stale = await cookChili(sub); // both requests read the batch before either wrote

    await eatFromBatch(sub, stale, portion(3333), TZ, idem());
    await expect(eatFromBatch(sub, stale, portion(3333), TZ, idem())).rejects.toBeInstanceOf(BatchChanged);

    expect((await getBatch(sub, stale.batch_id))?.remaining).toBe(WHOLE - 3333);
    expect(await listEntries(sub, "2026-11-09", "2026-11-09")).toHaveLength(1);
  });

  it("a retried portion is taken once", async () => {
    const sub = newUser();
    const chili = await cookChili(sub);
    const key = idem();
    const first = await eatFromBatch(sub, chili, portion(3333), TZ, key);
    // The retry re-reads the batch first, as the tool does.
    const fresh = (await getBatch(sub, chili.batch_id))!;
    const retry = await eatFromBatch(sub, fresh, portion(3333), TZ, key);

    expect(retry.replayed).toBe(true);
    expect(retry.entry?.entry_id).toBe(first.entry?.entry_id);
    expect((await getBatch(sub, chili.batch_id))?.remaining).toBe(WHOLE - 3333);
  });

  it("fixing the recipe recomputes portions already eaten", async () => {
    const sub = newUser();
    const chili = await cookChili(sub);
    const { entry } = await eatFromBatch(sub, chili, portion(3333), TZ, idem());

    const current = (await getBatch(sub, chili.batch_id))!;
    const { recomputed } = await updateBatch(sub, current, { totals: { ...chiliTotals, kcal: 3000 } });

    expect(recomputed).toBe(1);
    expect((await getEntry(sub, entry!.entry_id))?.totals.kcal).toBe(999.9); // 3000 x 0.3333
  });

  it("deleting a portion puts it back and reopens the batch", async () => {
    const sub = newUser();
    const chili = await cookChili(sub);
    const { entry } = await eatFromBatch(sub, chili, portion(WHOLE), TZ, idem());

    await deletePortionEntry(sub, (await getRecord(sub, entry!.entry_id))!);

    const after = await getBatch(sub, chili.batch_id);
    expect(after?.remaining).toBe(WHOLE);
    expect(after?.status).toBe("open");
    expect(after?.closed_at).toBeUndefined();
    expect(await getEntry(sub, entry!.entry_id)).toBeUndefined();
  });
});
