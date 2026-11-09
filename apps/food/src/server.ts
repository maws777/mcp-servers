// The food MCP server: one fresh McpServer per request (stateless, fits
// Lambda), bound to the user from the verified token.

import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { userIdFrom } from "@mcp/shared";
import { registerJournalTools } from "./tools/journal";
import { registerMealPrepTools } from "./tools/mealprep";
import { registerTrackingTools } from "./tools/tracking";

// Sent to the client with the tool list. These shape the quality of what
// gets logged more than any validation can.
export const INSTRUCTIONS = `
Food tracker. You estimate nutrition; the server checks plausibility, adds things up and stores them.

Logging
- Estimate each food or ingredient separately, for the quantity the user gave. Never add up or divide in your head: send the items, the server sums them.
- Before logging, state your estimate in one line (food, kcal, protein/carbs/fat) so the user can correct it; then log right away unless they asked to confirm first.
- For something the user eats often, check find_my_food first and reuse the saved values (scaled to the amount). Offer save_food when a meal comes back.
- If a value is rejected (e.g. kcal not matching the macros), re-check the numbers and try again.
- Use a fresh idempotency_key per action; reuse it only to retry the very same call.
- Times without an offset are read in the user's time zone. "Yesterday evening" means you pick a sensible time, e.g. 20:00.

Meal prep
- When the user cooks a dish to eat over several meals, create_batch with its ingredients and quantities (raw values, each estimated). Don't log it as eaten.
- When they eat some, eat_from_batch with a fraction, grams, portions or rest: true. The server computes the nutrition. Never compute a share yourself.
- When they mention leftovers or "the chili", check list_batches first.
- Cooked weight: "2.1 kg in pot 3" is gross_grams 2100 + pot "3" (pots are weighed without lid). Ask for a weight only if the user wants to eat by grams.
- Someone else eating from the dish: eaten_by "other". Recipe correction: update_batch (past portions are recomputed).

Tone
- Never suggest eating less to make up for a big day. No moralizing about food.
`.trim();

export interface FoodConfig {
  readScope: string;
  writeScope: string;
}

export function createFoodServerFactory(config: FoodConfig) {
  return (ctx: McpRequestContext) => {
    const sub = userIdFrom(ctx.authInfo);
    const server = new McpServer({ name: "food", version: "0.2.0" }, { instructions: INSTRUCTIONS });
    const toolContext = { sub, readScope: config.readScope, writeScope: config.writeScope };
    registerJournalTools(server, toolContext);
    registerMealPrepTools(server, toolContext);
    registerTrackingTools(server, toolContext);
    return server;
  };
}
