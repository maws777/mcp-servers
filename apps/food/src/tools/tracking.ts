// Saved foods (save_food, find_my_food, delete_food), targets (set_targets),
// trends (get_trends) and body weight (log_weight).

import { requireScopes, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ENTRY_LIMITS, energyProblem, nutritionSchema, type Nutrition } from "../domain/nutrition";
import { localParts, resolveInstant } from "../domain/time";
import { deleteFood, findFoods, saveFood } from "../store/catalog";
import { getProfile, logWeight, updateProfile } from "../store/profile";
import { eachDay, startOf, trends } from "../views";
import { resolveTime, type ToolContext } from "./journal";
import { fail, ok } from "./result";

const round1 = (x: number) => Math.round(x * 10) / 10;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function registerTrackingTools(server: McpServer, ctx: ToolContext) {
  const canRead = requireScopes(ctx.readScope);
  const canWrite = requireScopes(ctx.writeScope);

  // --- Saved foods ---------------------------------------------------------------

  server.registerTool(
    "save_food",
    {
      title: "Save food",
      description:
        "Save a food or meal the user eats often, with its nutrition for one serving, so the same values are reused instead of re-estimated. " +
        "Saving the same name replaces it.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80).describe('e.g. "Whey shake", "Oats with milk"'),
        serving: z.string().trim().min(1).max(60).describe('What one serving is, e.g. "30 g powder + 300 ml water"'),
        ...nutritionSchema(ENTRY_LIMITS).shape,
      }),
      annotations: { idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async (args) => {
      const problem = energyProblem(args, args.name);
      if (problem) return fail(problem);
      return ok(await saveFood(ctx.sub, args));
    },
  );

  server.registerTool(
    "find_my_food",
    {
      title: "Find my food",
      description: "Search the user's saved foods by name (accents and case ignored). Check here before estimating something the user eats often.",
      inputSchema: z.object({ query: z.string().trim().max(80).describe("Words of the name; empty lists everything") }),
      annotations: { readOnlyHint: true },
      scopeChallenge: canRead,
    },
    async (args) => ok({ foods: await findFoods(ctx.sub, args.query) }),
  );

  server.registerTool(
    "delete_food",
    {
      title: "Delete saved food",
      description: "Remove a saved food by its name.",
      inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
      annotations: { destructiveHint: true, idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async (args) => ((await deleteFood(ctx.sub, args.name)) ? ok({ deleted: args.name }) : fail(`no saved food "${args.name}"`)),
  );

  // --- Targets ---------------------------------------------------------------------

  server.registerTool(
    "set_targets",
    {
      title: "Set targets",
      description: "Set daily targets (any subset; the others stay as they are) and optionally the user's time zone (IANA name, e.g. Europe/Paris).",
      inputSchema: z.object({
        kcal: z.number().min(800).max(6000).optional(),
        protein_g: z.number().min(0).max(400).optional(),
        carbs_g: z.number().min(0).max(900).optional(),
        fat_g: z.number().min(0).max(400).optional(),
        fiber_g: z.number().min(0).max(100).optional(),
        time_zone: z.string().max(60).optional(),
      }),
      annotations: { idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async ({ time_zone, ...targets }) => {
      if (time_zone && !validTimeZone(time_zone)) return fail(`unknown time zone "${time_zone}"`);
      const clean = Object.fromEntries(Object.entries(targets).filter(([, v]) => v !== undefined)) as Partial<Nutrition>;
      return ok({ profile: await updateProfile(ctx.sub, { targets: clean, time_zone }) });
    },
  );

  // --- Trends ------------------------------------------------------------------------

  server.registerTool(
    "get_trends",
    {
      title: "Get trends",
      description:
        "Daily totals over the last N days (default 30), averages over logged days, how many days were logged and on target, and the weight trend. " +
        "Use it for questions like 'how was my week'.",
      inputSchema: z.object({ days: z.number().int().min(7).max(90).optional() }),
      annotations: { readOnlyHint: true },
      scopeChallenge: canRead,
    },
    async (args) => ok(await trends(ctx.sub, args.days ?? 30)),
  );

  // --- Weight ------------------------------------------------------------------------

  server.registerTool(
    "log_weight",
    {
      title: "Log weight",
      description: "Record the user's body weight. One per day: a second weighing the same day replaces the first.",
      inputSchema: z.object({
        kg: z.number().min(30).max(300),
        measured_at: z.string().max(40).optional().describe("When. Omit for now."),
      }),
      annotations: { idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async (args) => {
      const { time_zone } = await getProfile(ctx.sub);
      const time = resolveTime(args.measured_at, time_zone);
      if ("error" in time) return fail(time.error);
      const weight = { date: localParts(time.at, time_zone).date, kg: round1(args.kg), measured_at: time.at.toISOString() };
      await logWeight(ctx.sub, weight);
      return ok({ logged: weight });
    },
  );
}

// Re-exported for tests.
export { startOf, eachDay, resolveInstant };
