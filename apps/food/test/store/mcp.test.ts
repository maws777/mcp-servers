// The food server as Claude sees it: a real MCP client talking to the same
// handler the Lambda uses (createMcpHandler, JSON responses), with the store
// on DynamoDB Local. The unit tests check the arithmetic; these check the
// loop that makes it work with a model: the tool list it reads, and errors it
// can act on (a rejected estimate says what's wrong and nothing is stored).

import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { INSTRUCTIONS, createFoodServerFactory } from "../../src/server";

const RESOURCE = "https://food.test/mcp";
const READ = `${RESOURCE}/food:read`;
const WRITE = `${RESOURCE}/food:write`;

const handler = createMcpHandler(createFoodServerFactory({ readScope: READ, writeScope: WRITE }), { responseMode: "json" });

const open: Client[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

/** A connected client for one user, with the scopes a token would carry. */
async function connect(sub = `test-${randomUUID()}`, scopes = [READ, WRITE]) {
  const authInfo = { token: "test", clientId: "test", scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: new URL(RESOURCE), extra: { sub } };
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: (url, init) => handler.fetch(new Request(url, init), { authInfo }),
  });
  const client = new Client({ name: "food-test", version: "0.0.0" });
  await client.connect(transport);
  open.push(client);
  return { client, sub };
}

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: unknown };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

const rice = { name: "cooked rice", quantity: "200 g", kcal: 260, protein_g: 5, carbs_g: 57, fat_g: 0.6 };
const chicken = { name: "chicken breast", quantity: "150 g", kcal: 248, protein_g: 46, carbs_g: 0, fat_g: 5.4 };

describe("MCP: what the client sees", () => {
  it("lists every tool, each argument described, with the server instructions", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "close_batch", "create_batch", "daily_summary", "delete_entry", "delete_food", "eat_from_batch",
      "find_my_food", "get_trends", "list_batches", "list_entries", "list_pots", "log_food",
      "log_weight", "save_food", "save_pot", "set_targets", "update_batch", "update_entry",
    ]);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      // The model only knows what an argument means from its description.
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [arg, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${arg}`).toBeTruthy();
      }
    }
  });

  it("read tools say they're read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual(expect.arrayContaining(["list_entries", "daily_summary", "get_trends", "list_batches", "find_my_food"]));
    expect(readOnly).not.toContain("log_food");
  });
});

describe("MCP: log_food, the correction loop", () => {
  it("refuses kcal that don't match the macros, says why, and stores nothing", async () => {
    const { client } = await connect();
    // A misplaced digit: 2480 instead of 248.
    const res = await call(client, "log_food", { description: "Rice and chicken", items: [rice, { ...chicken, kcal: 2480 }], idempotency_key: randomUUID() });

    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toContain("chicken breast"); // which item
    expect(msg).toContain("2480 kcal"); // what was sent
    expect(msg).toMatch(/= 2\d\d kcal/); // what the macros give
    expect(msg).toContain("Re-check"); // what to do
    expect(msg).not.toContain("cooked rice"); // the good item isn't blamed

    const listed = await call(client, "list_entries", {});
    expect((listed.structuredContent as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("accepts the corrected call, and the server does the sum", async () => {
    const { client } = await connect();
    const res = await call(client, "log_food", { description: "Rice and chicken", meal: "lunch", items: [rice, chicken], idempotency_key: randomUUID() });

    expect(res.isError).toBeFalsy();
    const { logged } = res.structuredContent as { logged: { totals: { kcal: number; protein_g: number; fat_g: number } } };
    expect(logged.totals).toMatchObject({ kcal: 508, protein_g: 51, fat_g: 6 });
  });

  it("a retried call (same idempotency_key) logs the meal once", async () => {
    const { client } = await connect();
    const args = { description: "Rice", items: [rice], idempotency_key: randomUUID() };
    await call(client, "log_food", args);
    const again = await call(client, "log_food", args);

    expect((again.structuredContent as { replayed: boolean }).replayed).toBe(true);
    const listed = await call(client, "list_entries", {});
    expect((listed.structuredContent as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("an out-of-range value is refused before the handler, with a readable reason", async () => {
    const { client } = await connect();
    const res = await call(client, "log_food", { description: "Rice", items: [{ ...rice, kcal: -260 }], idempotency_key: randomUUID() }).catch(
      (e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }) as ToolResult,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("can't be negative");
  });
});

describe("MCP: who can do what", () => {
  it("a read-only token can't log", async () => {
    const { client } = await connect(undefined, [READ]);
    const res = await call(client, "log_food", { description: "Rice", items: [rice], idempotency_key: randomUUID() }).catch(
      (e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }) as ToolResult,
    );
    expect(res.isError).toBe(true);
    const listed = await call(client, "list_entries", {});
    expect((listed.structuredContent as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("one user never sees another's entries", async () => {
    const a = await connect();
    const b = await connect();
    await call(a.client, "log_food", { description: "A's lunch", items: [rice], idempotency_key: randomUUID() });

    const listed = await call(b.client, "list_entries", {});
    expect((listed.structuredContent as { entries: unknown[] }).entries).toHaveLength(0);
  });
});
