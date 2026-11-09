import { describe, expect, it } from "vitest";
import { WHOLE, ageInDays, describeRemaining, netWeight, portionOf, scale } from "../src/domain/batch";
import { normalizeName } from "../src/domain/nutrition";

const chili = { kcal: 2400, protein_g: 180, carbs_g: 210, fat_g: 90, fiber_g: 60, alcohol_g: 0 };

describe("portionOf", () => {
  const full = { remaining: WHOLE, total_grams: 1400, portions: 6 };

  it("reads a fraction", () => {
    expect(portionOf({ fraction: 1 / 3 }, full)).toEqual({ units: 3333 });
  });

  it("reads grams against the cooked weight", () => {
    expect(portionOf({ grams: 350 }, full)).toEqual({ units: 2500 });
  });

  it("reads portions", () => {
    expect(portionOf({ portions: 2 }, full)).toEqual({ units: 3333 });
  });

  it("three thirds empty the pot exactly", () => {
    let remaining = WHOLE;
    for (let i = 0; i < 3; i++) {
      const r = portionOf({ fraction: 1 / 3 }, { remaining });
      if ("error" in r) throw new Error(r.error);
      remaining -= r.units;
    }
    expect(remaining).toBe(0);
  });

  it("'rest' takes what is left", () => {
    expect(portionOf({ rest: true }, { remaining: 1234 })).toEqual({ units: 1234 });
  });

  it("refuses more than is left", () => {
    const r = portionOf({ fraction: 0.5 }, { remaining: 3000, total_grams: 1400 });
    expect("error" in r && r.error).toMatch(/only 30%, ~420 g left/);
  });

  it("refuses grams without a cooked weight, and portions without a count", () => {
    expect(portionOf({ grams: 200 }, { remaining: WHOLE })).toHaveProperty("error");
    expect(portionOf({ portions: 1 }, { remaining: WHOLE })).toHaveProperty("error");
  });

  it("refuses a finished batch", () => {
    expect(portionOf({ rest: true }, { remaining: 0 })).toHaveProperty("error");
  });
});

describe("scale", () => {
  it("gives a third of the dish", () => {
    expect(scale(chili, 3333)).toEqual({ kcal: 799.9, protein_g: 60, carbs_g: 70, fat_g: 30, fiber_g: 20, alcohol_g: 0 });
  });

  it("gives the whole dish for WHOLE", () => {
    expect(scale(chili, WHOLE)).toEqual(chili);
  });
});

describe("pots and listings", () => {
  it("subtracts the pot's empty weight", () => {
    expect(netWeight(2100, 700)).toEqual({ grams: 1400 });
    expect(netWeight(600, 700)).toHaveProperty("error");
  });

  it("describes what's left", () => {
    expect(describeRemaining({ remaining: 5000, total_grams: 1400, portions: 6 })).toBe("50%, ~700 g, ~3 portions");
  });

  it("counts days since cooking", () => {
    expect(ageInDays("2026-11-05T19:00:00Z", new Date("2026-11-09T12:00:00Z"))).toBe(3);
  });

  it("normalizes names for matching", () => {
    expect(normalizeName("  Bœuf   Haché 5% ")).toBe("boeuf hache 5%");
  });
});
