// The food MCP server: one fresh McpServer per request (stateless, fits
// Lambda), bound to the user from the verified token.

import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { userIdFrom } from "@mcp/shared";
import { registerJournalTools } from "./tools/journal";

// Sent to the client with the tool list. These shape the quality of what
// gets logged more than any validation can.
export const INSTRUCTIONS = `
Food tracker. You estimate nutrition; the server checks plausibility, adds things up and stores them.

- Estimate each food or ingredient separately, for the quantity the user gave. Never add up or divide in your head: send the items, the server sums them.
- Before logging, state your estimate in one line (food, kcal, protein/carbs/fat) so the user can correct it; then log right away unless they asked to confirm first.
- If a value is rejected (e.g. kcal not matching the macros), re-check the numbers and try again.
- Use a fresh idempotency_key per meal; reuse it only to retry the very same call.
- Times without an offset are read in the user's time zone. "Yesterday evening" means you pick a sensible time, e.g. 20:00.
- Never suggest eating less to make up for a big day. No moralizing about food.
`.trim();

export interface FoodConfig {
  readScope: string;
  writeScope: string;
}

export function createFoodServerFactory(config: FoodConfig) {
  return (ctx: McpRequestContext) => {
    const sub = userIdFrom(ctx.authInfo);
    const server = new McpServer({ name: "food", version: "0.1.0" }, { instructions: INSTRUCTIONS });
    registerJournalTools(server, { sub, readScope: config.readScope, writeScope: config.writeScope });
    return server;
  };
}
