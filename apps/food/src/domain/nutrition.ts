// Nutrition values: what Claude estimates and the server checks and adds up.
// Pure logic, no AWS: tested in milliseconds (test/nutrition.test.ts).

import { z } from "zod";

export interface Nutrition {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  alcohol_g: number;
}

export const NUTRIENT_KEYS = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "alcohol_g"] as const;

export interface Limits {
  kcal: number;
  macro: number;
  fiber: number;
  alcohol: number;
}

/** Per item of a meal. (Batch items get wider limits in phase 2: 2 kg of rice is 7,000 kcal.) */
export const ENTRY_LIMITS: Limits = { kcal: 5000, macro: 500, fiber: 150, alcohol: 200 };

const amount = (max: number, what: string) =>
  z.number().min(0, `${what} can't be negative`).max(max, `${what} over ${max} looks wrong`);

/**
 * One ingredient or food, estimated by Claude for the quantity I gave.
 * The descriptions are what Claude reads in the tool schema.
 */
export function itemSchema(limits: Limits) {
  return z.object({
    name: z.string().trim().min(1).max(80).describe('What it is, e.g. "beef mince 5% fat", "banana"'),
    quantity: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe('The quantity as the user said it, e.g. "500 g", "2 cans", "1 tbsp"'),
    grams: z.number().positive().max(10_000).optional().describe("Weight in grams, when known or estimable"),
    kcal: amount(limits.kcal, "kcal").describe("Energy for this quantity, kcal"),
    protein_g: amount(limits.macro, "protein").describe("Protein for this quantity, grams"),
    carbs_g: amount(limits.macro, "carbs").describe("Carbohydrates for this quantity, grams"),
    fat_g: amount(limits.macro, "fat").describe("Fat for this quantity, grams"),
    fiber_g: amount(limits.fiber, "fiber").optional().describe("Fiber, grams"),
    alcohol_g: amount(limits.alcohol, "alcohol").optional().describe("Alcohol, grams (7 kcal/g)"),
  });
}

export type Item = z.infer<ReturnType<typeof itemSchema>>;

/**
 * Energy consistency: protein and carbs give 4 kcal/g, fat 9, alcohol 7.
 * The stated kcal must be within 25% of that (or 15 kcal, for tiny values
 * where rounding dominates). Catches a misplaced digit, the commonest slip
 * when estimating. Returns a message Claude can act on, or null if fine.
 */
export function energyProblem(n: Pick<Nutrition, "kcal" | "protein_g" | "carbs_g" | "fat_g"> & { alcohol_g?: number }, label: string): string | null {
  const fromMacros = 4 * n.protein_g + 4 * n.carbs_g + 9 * n.fat_g + 7 * (n.alcohol_g ?? 0);
  const tolerance = Math.max(0.25 * n.kcal, 15);
  if (Math.abs(fromMacros - n.kcal) <= tolerance) return null;
  return (
    `${label}: ${n.kcal} kcal doesn't match its macros ` +
    `(4×${n.protein_g} protein + 4×${n.carbs_g} carbs + 9×${n.fat_g} fat` +
    `${n.alcohol_g ? ` + 7×${n.alcohol_g} alcohol` : ""} = ${Math.round(fromMacros)} kcal). ` +
    `Re-check the numbers.`
  );
}

/** All problems in a list of items, empty if everything is plausible. */
export function itemProblems(items: Item[]): string[] {
  return items.map((item) => energyProblem(item, item.name)).filter((p): p is string => p !== null);
}

/**
 * Sum of the items, done here and not by the model. Computed in tenths as
 * integers, so adding 0.1 ten times gives exactly 1.0 (binary floats don't).
 */
export function sumItems(items: Item[]): Nutrition {
  const tenths = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as Record<keyof Nutrition, number>;
  for (const item of items) {
    for (const key of NUTRIENT_KEYS) tenths[key] += Math.round((item[key] ?? 0) * 10);
  }
  return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, tenths[k] / 10])) as unknown as Nutrition;
}

export function addNutrition(a: Nutrition, b: Nutrition): Nutrition {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((k) => [k, (Math.round(a[k] * 10) + Math.round(b[k] * 10)) / 10]),
  ) as unknown as Nutrition;
}

export const ZERO: Nutrition = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, alcohol_g: 0 };
