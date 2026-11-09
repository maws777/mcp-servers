// Journal tools: log_food, list_entries, update_entry, delete_entry,
// daily_summary. Each one: a Zod schema (what Claude sees and what is
// validated before the handler runs), a required scope, a handler that
// checks plausibility, does the arithmetic, and calls the store.

import { requireScopes, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ENTRY_LIMITS, ZERO, addNutrition, itemProblems, itemSchema, sumItems, type Nutrition } from "../domain/nutrition";
import { DATE_RE, daysBetween, resolveInstant, timeProblem, today } from "../domain/time";
import { IdempotencyConflict, createEntry, deleteEntry, listEntries, updateEntry, type Entry } from "../store/entries";
import { getProfile } from "../store/profile";
import { fail, ok } from "./result";

export interface ToolContext {
  sub: string; // from the verified token, never from arguments
  readScope: string;
  writeScope: string;
}

const MAX_ENTRY_KCAL = 8000;

const items = z
  .array(itemSchema(ENTRY_LIMITS))
  .min(1)
  .max(30)
  .describe("What was eaten, one element per food or ingredient, each estimated separately for its quantity. A single food is a list of one.");
const meal = z.enum(["breakfast", "lunch", "dinner", "snack"]);
const eatenAt = z
  .string()
  .max(40)
  .describe('When it was eaten. "2026-11-09T19:30" is read in the user\'s time zone. Omit for now.');
const date = z.string().regex(DATE_RE, "use YYYY-MM-DD");
const entryId = z.string().min(10).max(40).describe("entry_id returned by log_food or list_entries");

/** Checks items, returns totals or an error message. */
function checkItems(list: z.infer<typeof items>): { totals: Nutrition } | { error: string } {
  const problems = itemProblems(list);
  if (problems.length > 0) return { error: problems.join("\n") };
  const totals = sumItems(list);
  if (totals.kcal > MAX_ENTRY_KCAL) return { error: `${totals.kcal} kcal in one entry looks wrong; split it or re-check` };
  return { totals };
}

function resolveTime(input: string | undefined, timeZone: string): { at: Date } | { error: string } {
  try {
    const at = resolveInstant(input, timeZone);
    const problem = timeProblem(at);
    return problem ? { error: problem } : { at };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function dayTotals(entries: Entry[]) {
  const byDay = new Map<string, Nutrition>();
  for (const e of entries) byDay.set(e.local_date, addNutrition(byDay.get(e.local_date) ?? ZERO, e.totals));
  return Object.fromEntries(byDay);
}

export function registerJournalTools(server: McpServer, ctx: ToolContext) {
  const canRead = requireScopes(ctx.readScope);
  const canWrite = requireScopes(ctx.writeScope);

  server.registerTool(
    "log_food",
    {
      title: "Log food",
      description:
        "Log something the user ate. Estimate each food or ingredient separately for the quantity given; the server adds them up. " +
        "Pass a fresh idempotency_key (a UUID) per meal; reuse it only when retrying the same call.",
      inputSchema: z.object({
        description: z.string().trim().min(1).max(200).describe('Short label for the meal, e.g. "Chili with rice"'),
        items,
        eaten_at: eatenAt.optional(),
        meal: meal.optional(),
        idempotency_key: z.string().min(8).max(64),
      }),
      scopeChallenge: canWrite,
    },
    async (args) => {
      const checked = checkItems(args.items);
      if ("error" in checked) return fail(checked.error);
      const { time_zone } = await getProfile(ctx.sub);
      const time = resolveTime(args.eaten_at, time_zone);
      if ("error" in time) return fail(time.error);
      try {
        const { idempotency_key, ...request } = args;
        const { entry, replayed } = await createEntry(
          ctx.sub,
          { description: args.description, meal: args.meal, items: args.items, totals: checked.totals, eatenAt: time.at },
          time_zone,
          { key: idempotency_key, request },
        );
        return ok({ logged: entry, replayed });
      } catch (e) {
        if (e instanceof IdempotencyConflict) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "list_entries",
    {
      title: "List entries",
      description: "List logged entries for a day or a range of days (up to 31), with daily totals. Dates are in the user's time zone.",
      inputSchema: z.object({
        from: date.optional().describe("First day, YYYY-MM-DD. Default: today"),
        to: date.optional().describe("Last day, YYYY-MM-DD, inclusive. Default: same as from"),
      }),
      annotations: { readOnlyHint: true },
      scopeChallenge: canRead,
    },
    async (args) => {
      const { time_zone } = await getProfile(ctx.sub);
      const from = args.from ?? today(time_zone);
      const to = args.to ?? from;
      const span = daysBetween(from, to);
      if (span < 0) return fail("to is before from");
      if (span > 30) return fail("at most 31 days at a time");
      const entries = await listEntries(ctx.sub, from, to);
      return ok({ from, to, time_zone, daily_totals: dayTotals(entries), entries });
    },
  );

  server.registerTool(
    "update_entry",
    {
      title: "Update entry",
      description: "Correct a logged entry. items, when given, replace the whole list; totals are recomputed.",
      inputSchema: z.object({
        entry_id: entryId,
        description: z.string().trim().min(1).max(200).optional(),
        items: items.optional(),
        eaten_at: eatenAt.optional(),
        meal: meal.optional(),
      }),
      annotations: { idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async (args) => {
      let totals: Nutrition | undefined;
      if (args.items) {
        const checked = checkItems(args.items);
        if ("error" in checked) return fail(checked.error);
        totals = checked.totals;
      }
      const { time_zone } = await getProfile(ctx.sub);
      let at: Date | undefined;
      if (args.eaten_at) {
        const time = resolveTime(args.eaten_at, time_zone);
        if ("error" in time) return fail(time.error);
        at = time.at;
      }
      const entry = await updateEntry(
        ctx.sub,
        args.entry_id,
        { description: args.description, meal: args.meal, items: args.items, totals, eatenAt: at },
        time_zone,
      );
      return entry ? ok({ updated: entry }) : fail(`no entry ${args.entry_id}`);
    },
  );

  server.registerTool(
    "delete_entry",
    {
      title: "Delete entry",
      description: "Delete a logged entry (hidden from every view; recoverable by the owner).",
      inputSchema: z.object({ entry_id: entryId }),
      annotations: { destructiveHint: true, idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async (args) => {
      const done = await deleteEntry(ctx.sub, args.entry_id);
      return done ? ok({ deleted: args.entry_id }) : fail(`no entry ${args.entry_id}`);
    },
  );

  server.registerTool(
    "daily_summary",
    {
      title: "Daily summary",
      description: "Totals for one day, by meal, compared with the user's targets when set.",
      inputSchema: z.object({ date: date.optional().describe("YYYY-MM-DD. Default: today") }),
      annotations: { readOnlyHint: true },
      scopeChallenge: canRead,
    },
    async (args) => {
      const profile = await getProfile(ctx.sub);
      const day = args.date ?? today(profile.time_zone);
      const entries = await listEntries(ctx.sub, day, day);
      const totals = entries.reduce((acc, e) => addNutrition(acc, e.totals), ZERO);
      const byMeal: Record<string, Nutrition> = {};
      for (const e of entries) {
        const key = e.meal ?? "unspecified";
        byMeal[key] = addNutrition(byMeal[key] ?? ZERO, e.totals);
      }
      const remaining = profile.targets
        ? Object.fromEntries(
            Object.entries(profile.targets).map(([k, target]) => [k, Math.round(((target ?? 0) - totals[k as keyof Nutrition]) * 10) / 10]),
          )
        : null;
      return ok({ date: day, entries_count: entries.length, totals, by_meal: byMeal, targets: profile.targets ?? null, remaining_to_target: remaining });
    },
  );
}
