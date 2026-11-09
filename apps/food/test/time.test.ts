import { describe, expect, it } from "vitest";
import { daysBetween, localParts, resolveInstant, timeProblem, today } from "../src/domain/time";

const TZ = "Europe/Paris";

describe("local days", () => {
  it("puts 00:30 Paris time on the new day although it's still the previous day in UTC", () => {
    const instant = new Date("2026-11-08T23:30:00Z"); // 00:30 in Paris (UTC+1 in winter)
    expect(localParts(instant, TZ)).toEqual({ date: "2026-11-09", time: "00:30:00" });
    expect(today(TZ, instant)).toBe("2026-11-09");
  });
});

describe("resolveInstant", () => {
  const now = new Date("2026-11-09T12:00:00Z");

  it("defaults to now", () => {
    expect(resolveInstant(undefined, TZ, now)).toBe(now);
  });

  it("reads a time without offset as Paris wall-clock time (winter, UTC+1)", () => {
    expect(resolveInstant("2026-11-09T19:30", TZ, now).toISOString()).toBe("2026-11-09T18:30:00.000Z");
  });

  it("handles summer time (UTC+2)", () => {
    expect(resolveInstant("2026-07-14T12:00", TZ, now).toISOString()).toBe("2026-07-14T10:00:00.000Z");
  });

  it("reads a bare date as noon", () => {
    expect(resolveInstant("2026-11-08", TZ, now).toISOString()).toBe("2026-11-08T11:00:00.000Z");
  });

  it("keeps an explicit offset", () => {
    expect(resolveInstant("2026-11-09T19:30:00+01:00", TZ, now).toISOString()).toBe("2026-11-09T18:30:00.000Z");
  });

  it("rejects garbage", () => {
    expect(() => resolveInstant("yesterday", TZ, now)).toThrow();
  });
});

describe("plausible times", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  it("refuses the future and the distant past", () => {
    expect(timeProblem(new Date("2026-11-09T13:00:00Z"), now)).toMatch(/future/);
    expect(timeProblem(new Date("2025-01-01T00:00:00Z"), now)).toMatch(/year/);
    expect(timeProblem(new Date("2026-11-09T08:00:00Z"), now)).toBeNull();
  });

  it("counts days between dates", () => {
    expect(daysBetween("2026-11-01", "2026-11-09")).toBe(8);
  });
});
