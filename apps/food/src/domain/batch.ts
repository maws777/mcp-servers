// Meal-prep arithmetic: how much of a cooked dish a portion is, what it
// contains, what's left. Pure logic, tested in test/batch.test.ts.
//
// Fractions are handled as integers in ten-thousandths (1 = 10,000): a third
// is 3,333, and "the rest" is whatever integer is left, so three thirds empty
// the pot exactly instead of leaving 0.0001 behind.

import { NUTRIENT_KEYS, type Nutrition } from "./nutrition";

export const WHOLE = 10_000;

/** Within this much of what's left (0.01 of the dish), a portion counts as "the rest". */
export const SNAP = 100;

export type Amount = { fraction: number } | { grams: number } | { portions: number } | { rest: true };

export interface BatchSize {
  remaining: number; // ten-thousandths
  total_grams?: number; // cooked weight
  portions?: number;
}

/**
 * Turns "a third", "350 g", "one portion" or "the rest" into ten-thousandths
 * of the dish, checked against what's left.
 */
export function portionOf(amount: Amount, batch: BatchSize): { units: number } | { error: string } {
  let units: number;
  if ("rest" in amount) {
    units = batch.remaining;
  } else if ("fraction" in amount) {
    units = Math.round(amount.fraction * WHOLE);
  } else if ("grams" in amount) {
    if (!batch.total_grams) {
      return { error: "this batch has no cooked weight: give it (update_batch with total_grams, or gross_grams + pot) or use a fraction or portions" };
    }
    units = Math.round((amount.grams / batch.total_grams) * WHOLE);
  } else {
    if (!batch.portions) return { error: "this batch has no portion count: give one (update_batch) or use a fraction or grams" };
    units = Math.round((amount.portions / batch.portions) * WHOLE);
  }

  if (batch.remaining <= 0) return { error: "this batch is already finished" };
  if (units <= 0) return { error: "that amount is zero" };
  if (Math.abs(units - batch.remaining) <= SNAP) return { units: batch.remaining };
  if (units > batch.remaining) {
    return { error: `only ${describeRemaining(batch)} left; use rest: true to finish it` };
  }
  return { units };
}

/** Nutrition of a share of the dish, rounded to 0.1 (computed in integer tenths). */
export function scale(totals: Nutrition, units: number): Nutrition {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((k) => [k, Math.round((Math.round(totals[k] * 10) * units) / WHOLE) / 10]),
  ) as unknown as Nutrition;
}

/** "about a third (0.333), ~460 g, ~2 portions", for messages and listings. */
export function describeRemaining(batch: BatchSize): string {
  const fraction = batch.remaining / WHOLE;
  const parts = [`${Math.round(fraction * 1000) / 10}%`];
  if (batch.total_grams) parts.push(`~${Math.round(fraction * batch.total_grams)} g`);
  if (batch.portions) parts.push(`~${Math.round(fraction * batch.portions * 10) / 10} portions`);
  return parts.join(", ");
}

/** Net cooked weight from a weighing in a saved pot (pots weighed without lid). */
export function netWeight(grossGrams: number, potEmptyGrams: number): { grams: number } | { error: string } {
  const net = Math.round(grossGrams - potEmptyGrams);
  if (net <= 0) return { error: `${grossGrams} g is not more than the empty pot (${potEmptyGrams} g): check the weight or the pot` };
  return { grams: net };
}

/** Days since cooking, for "chili from 4 days ago" nudges. */
export function ageInDays(cookedAt: string, now = new Date()): number {
  return Math.floor((now.getTime() - Date.parse(cookedAt)) / 86_400_000);
}
