// Meal-prep tools: create_batch, list_batches, eat_from_batch, update_batch,
// close_batch, plus save_pot and list_pots (tare weights for cooked weight).

import { requireScopes, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WHOLE, ageInDays, describeRemaining, netWeight, portionOf, scale, type Amount } from "../domain/batch";
import { BATCH_ITEM_LIMITS, MAX_BATCH_KCAL, itemProblems, itemSchema, sumItems, type Item } from "../domain/nutrition";
import { BatchChanged, closeBatch, createBatch, eatFromBatch, getBatch, listBatches, updateBatch, type Batch } from "../store/batches";
import { getPot, listPots, savePot } from "../store/catalog";
import { IdempotencyConflict } from "../store/db";
import { getProfile } from "../store/profile";
import { idempotencyKey, resolveTime, type ToolContext } from "./journal";
import { batchView } from "../views";
import { fail, ok } from "./result";

const batchItems = z
  .array(itemSchema(BATCH_ITEM_LIMITS))
  .min(1)
  .max(30)
  .describe("The ingredients with the quantities the user gave, each estimated separately (raw values). The server sums them.");
const batchId = z.string().min(10).max(40).describe("batch_id from create_batch or list_batches");
const cookedWeight = {
  total_grams: z.number().min(50).max(20_000).optional().describe("Cooked weight of the whole dish (net), if weighed"),
  gross_grams: z.number().min(50).max(30_000).optional().describe("Weight of the dish in a saved pot, pot included (no lid); needs pot"),
  pot: z.string().trim().min(1).max(30).optional().describe("Label of a saved pot (list_pots), with gross_grams"),
};

/** Checks ingredients, returns totals and raw weight, or an error. */
function checkBatchItems(items: Item[]) {
  const problems = itemProblems(items);
  if (problems.length > 0) return { error: problems.join("\n") };
  const totals = sumItems(items);
  if (totals.kcal > MAX_BATCH_KCAL) return { error: `${totals.kcal} kcal for one dish looks wrong; re-check the quantities` };
  const allWeighed = items.every((i) => i.grams !== undefined);
  const raw_grams = allWeighed ? Math.round(items.reduce((s, i) => s + (i.grams ?? 0), 0)) : undefined;
  return { totals, raw_grams };
}

/** Cooked weight from total_grams, or gross_grams in a saved pot. Undefined when neither is given. */
async function resolveCookedWeight(
  sub: string,
  args: { total_grams?: number; gross_grams?: number; pot?: string },
): Promise<{ grams?: number } | { error: string }> {
  if (args.total_grams !== undefined && args.gross_grams !== undefined) return { error: "give total_grams or gross_grams + pot, not both" };
  if (args.gross_grams !== undefined || args.pot !== undefined) {
    if (args.gross_grams === undefined || args.pot === undefined) return { error: "gross_grams and pot go together" };
    const pot = await getPot(sub, args.pot);
    if (!pot) return { error: `no saved pot "${args.pot}"; save it with save_pot (weighed empty, no lid)` };
    return netWeight(args.gross_grams, pot.empty_grams);
  }
  return { grams: args.total_grams };
}

function label(amount: Amount, units: number): string {
  if ("rest" in amount) return "the rest";
  if ("grams" in amount) return `${amount.grams} g`;
  if ("portions" in amount) return `${amount.portions} portion${amount.portions === 1 ? "" : "s"}`;
  return `${Math.round((units / WHOLE) * 1000) / 10}% of the batch`;
}

export function registerMealPrepTools(server: McpServer, ctx: ToolContext) {
  const canRead = requireScopes(ctx.readScope);
  const canWrite = requireScopes(ctx.writeScope);

  server.registerTool(
    "create_batch",
    {
      title: "Create meal-prep batch",
      description:
        "Record a cooked dish that will be eaten over several meals. List its ingredients with quantities (raw), each estimated separately; " +
        "the server sums them. Optionally the cooked weight (total_grams, or gross_grams in a saved pot) and roughly how many portions. " +
        "Nothing is logged as eaten: use eat_from_batch for that.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(80).describe('e.g. "Chili con carne"'),
        items: batchItems,
        ...cookedWeight,
        portions: z.number().min(0.5).max(50).optional().describe("Roughly how many portions the dish makes"),
        cooked_at: z.string().max(40).optional().describe("When it was cooked. Omit for now."),
        idempotency_key: idempotencyKey,
      }),
      scopeChallenge: canWrite,
    },
    async (args) => {
      const checked = checkBatchItems(args.items);
      if ("error" in checked) return fail(checked.error as string);
      const weight = await resolveCookedWeight(ctx.sub, args);
      if ("error" in weight) return fail(weight.error);
      const { time_zone } = await getProfile(ctx.sub);
      const time = resolveTime(args.cooked_at, time_zone);
      if ("error" in time) return fail(time.error);
      try {
        const { idempotency_key, ...request } = args;
        const { batch, replayed } = await createBatch(
          ctx.sub,
          {
            name: args.name,
            items: args.items,
            totals: checked.totals,
            raw_grams: checked.raw_grams,
            total_grams: weight.grams,
            portions: args.portions,
            cookedAt: time.at,
          },
          { key: idempotency_key, request },
        );
        return ok({ batch: batchView(batch), replayed });
      } catch (e) {
        if (e instanceof IdempotencyConflict) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "list_batches",
    {
      title: "List meal-prep batches",
      description: "What's left in the fridge: open batches with remaining share, weight, portions, nutrition and age in days. Check this when the user mentions leftovers.",
      inputSchema: z.object({ include_closed: z.boolean().optional().describe("Also finished and discarded batches. Default false.") }),
      annotations: { readOnlyHint: true },
      scopeChallenge: canRead,
    },
    async (args) => {
      const batches = await listBatches(ctx.sub, args.include_closed ?? false);
      return ok({ batches: batches.map((b) => batchView(b)) });
    },
  );

  server.registerTool(
    "eat_from_batch",
    {
      title: "Eat from batch",
      description:
        "Take a portion of a batch. Give exactly one of: fraction (0-1, e.g. 0.333 for a third), grams (needs the batch's cooked weight), " +
        "portions (needs its portion count), or rest: true. For the user (eaten_by 'me', default) it is logged in the journal with the " +
        "batch's nutrition times that share, computed by the server. For someone else ('other') it only leaves the pot. Never divide yourself.",
      inputSchema: z.object({
        batch_id: batchId,
        fraction: z.number().gt(0).max(1).optional(),
        grams: z.number().gt(0).max(20_000).optional(),
        portions: z.number().gt(0).max(50).optional(),
        rest: z.literal(true).optional(),
        eaten_by: z.enum(["me", "other"]).optional(),
        eaten_at: z.string().max(40).optional().describe("When. Omit for now."),
        meal: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
        idempotency_key: idempotencyKey,
      }),
      scopeChallenge: canWrite,
    },
    async (args) => {
      const given = (["fraction", "grams", "portions", "rest"] as const).filter((k) => args[k] !== undefined);
      if (given.length !== 1) return fail("give exactly one of fraction, grams, portions or rest");
      const amount = (given[0] === "rest" ? { rest: true } : { [given[0]!]: args[given[0]!] }) as Amount;

      const { time_zone } = await getProfile(ctx.sub);
      const time = resolveTime(args.eaten_at, time_zone);
      if ("error" in time) return fail(time.error);
      const { idempotency_key, ...request } = args;

      // Two attempts: if the batch changed between our read and our write
      // (another request took a portion), read it again and redo the math.
      for (let attempt = 0; attempt < 2; attempt++) {
        const batch = await getBatch(ctx.sub, args.batch_id);
        if (!batch) return fail(`no batch ${args.batch_id}`);
        if (batch.status !== "open") return fail(`this batch is ${batch.status}`);
        const portion = portionOf(amount, batch);
        if ("error" in portion) return fail(portion.error);
        try {
          const result = await eatFromBatch(
            ctx.sub,
            batch,
            {
              units: portion.units,
              eatenBy: args.eaten_by ?? "me",
              eatenAt: time.at,
              meal: args.meal,
              label: label(amount, portion.units),
              grams: batch.total_grams ? Math.round((portion.units / WHOLE) * batch.total_grams) : undefined,
            },
            time_zone,
            { key: idempotency_key, request },
          );
          return ok({
            taken: { share: portion.units / WHOLE, eaten_by: args.eaten_by ?? "me" },
            logged: result.entry ?? null,
            batch: batchView(result.batch),
            replayed: result.replayed,
          });
        } catch (e) {
          if (e instanceof IdempotencyConflict) return fail(e.message);
          if (e instanceof BatchChanged && attempt === 0) continue;
          if (e instanceof BatchChanged) return fail(e.message);
          throw e;
        }
      }
      return fail("could not take the portion; try again");
    },
  );

  server.registerTool(
    "update_batch",
    {
      title: "Update batch",
      description:
        "Correct a batch: name, ingredients (full replacement; totals recomputed, and portions already eaten are recomputed too, " +
        "keeping their share), cooked weight (total_grams, or gross_grams in a saved pot), or portion count.",
      inputSchema: z.object({
        batch_id: batchId,
        name: z.string().trim().min(1).max(80).optional(),
        items: batchItems.optional(),
        ...cookedWeight,
        portions: z.number().min(0.5).max(50).optional(),
      }),
      annotations: { idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async (args) => {
      const batch = await getBatch(ctx.sub, args.batch_id);
      if (!batch) return fail(`no batch ${args.batch_id}`);
      let totals;
      let raw_grams;
      if (args.items) {
        const checked = checkBatchItems(args.items);
        if ("error" in checked) return fail(checked.error as string);
        totals = checked.totals;
        raw_grams = checked.raw_grams;
      }
      const weight = await resolveCookedWeight(ctx.sub, args);
      if ("error" in weight) return fail(weight.error);
      try {
        const result = await updateBatch(ctx.sub, batch, {
          name: args.name,
          items: args.items,
          totals,
          raw_grams,
          total_grams: weight.grams,
          portions: args.portions,
        });
        return ok({ batch: batchView(result.batch), portions_recomputed: result.recomputed });
      } catch (e) {
        if (e instanceof BatchChanged) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "close_batch",
    {
      title: "Close batch",
      description: "Mark a batch as finished (eaten without being logged here) or discarded (thrown away). Closed batches stay in history.",
      inputSchema: z.object({ batch_id: batchId, reason: z.enum(["finished", "discarded"]) }),
      annotations: { idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async (args) => {
      const batch = await getBatch(ctx.sub, args.batch_id);
      if (!batch) return fail(`no batch ${args.batch_id}`);
      if (batch.status === args.reason) return ok({ batch: batchView(batch) });
      try {
        return ok({ batch: batchView(await closeBatch(ctx.sub, batch, args.reason)) });
      } catch (e) {
        if (e instanceof BatchChanged) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "save_pot",
    {
      title: "Save pot",
      description: "Save a pot's empty weight (weighed without lid) under a label, so a dish weighed in it gives its cooked weight. Saving the same label replaces it.",
      inputSchema: z.object({
        label: z.string().trim().min(1).max(30).describe('e.g. "3", "big wok"'),
        empty_grams: z.number().min(50).max(10_000),
        note: z.string().trim().max(80).optional(),
      }),
      annotations: { idempotentHint: true },
      scopeChallenge: canWrite,
    },
    async (args) => ok(await savePot(ctx.sub, args)),
  );

  server.registerTool(
    "list_pots",
    {
      title: "List pots",
      description: "Saved pots and their empty weights.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      scopeChallenge: canRead,
    },
    async () => ok({ pots: await listPots(ctx.sub) }),
  );
}
