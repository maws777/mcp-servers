import { describe, expect, it } from "vitest";
import { ENTRY_LIMITS, energyProblem, itemProblems, itemSchema, sumItems } from "../src/domain/nutrition";

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  name: "beef mince 5%",
  quantity: "500 g",
  grams: 500,
  kcal: 685,
  protein_g: 106,
  carbs_g: 0,
  fat_g: 27,
  ...over,
});

describe("energy check", () => {
  it("accepts consistent values", () => {
    expect(energyProblem(item(), "x")).toBeNull();
  });

  it("rejects a misplaced digit", () => {
    expect(energyProblem(item({ kcal: 6850 }) as never, "beef")).toMatch(/doesn't match/);
  });

  it("counts alcohol at 7 kcal/g", () => {
    const beer = { kcal: 150, protein_g: 1.6, carbs_g: 13, fat_g: 0, alcohol_g: 14 };
    expect(energyProblem(beer, "beer")).toBeNull();
    expect(energyProblem({ ...beer, alcohol_g: 0 }, "beer")).not.toBeNull();
  });

  it("tolerates rounding on tiny values", () => {
    expect(energyProblem({ kcal: 2, protein_g: 0.3, carbs_g: 0, fat_g: 0 }, "coffee")).toBeNull();
  });

  it("lists only the problem items", () => {
    expect(itemProblems([item(), item({ name: "rice", kcal: 3000 }) as never])).toHaveLength(1);
  });
});

describe("sums", () => {
  it("adds items exactly in tenths", () => {
    const tenth = { name: "x", kcal: 0.1, protein_g: 0.1, carbs_g: 0, fat_g: 0 };
    const total = sumItems(Array.from({ length: 10 }, () => tenth));
    expect(total.kcal).toBe(1);
    expect(total.protein_g).toBe(1);
  });

  it("treats missing fiber and alcohol as zero", () => {
    expect(sumItems([item() as never]).fiber_g).toBe(0);
  });
});

describe("item schema", () => {
  const schema = itemSchema(ENTRY_LIMITS);

  it("rejects negative and absurd values", () => {
    expect(schema.safeParse(item({ kcal: -1 })).success).toBe(false);
    expect(schema.safeParse(item({ kcal: 50_000 })).success).toBe(false);
  });

  it("requires a name", () => {
    expect(schema.safeParse(item({ name: "  " })).success).toBe(false);
  });
});
