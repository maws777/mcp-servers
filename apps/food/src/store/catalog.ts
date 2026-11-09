// The user's small reference lists: saved foods and pots. One item each,
// keyed by normalized name, so saving the same name again replaces it.

import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeName, type Nutrition } from "../domain/nutrition";
import { TABLE, doc, keys } from "./db";

async function queryPrefix(sub: string, prefix: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": keys.pk(sub), ":prefix": prefix },
        ExclusiveStartKey: start,
      }),
    );
    out.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

const strip = ({ PK: _p, SK: _s, type: _t, ...rest }: Record<string, unknown>) => rest;

// --- Saved foods ---------------------------------------------------------------

export interface SavedFood extends Partial<Nutrition> {
  name: string;
  serving: string;
  grams?: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  updated_at: string;
}

export async function saveFood(sub: string, food: Omit<SavedFood, "updated_at">): Promise<{ food: SavedFood; replaced: boolean }> {
  const item = { ...food, updated_at: new Date().toISOString() };
  const res = await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: keys.pk(sub), SK: keys.food(normalizeName(food.name)), type: "food", ...item },
      ReturnValues: "ALL_OLD",
    }),
  );
  return { food: item, replaced: Boolean(res.Attributes) };
}

/** Saved foods whose name contains every word of the query (accents and case ignored). Empty query: all. */
export async function findFoods(sub: string, query: string): Promise<SavedFood[]> {
  const words = normalizeName(query).split(" ").filter(Boolean);
  const all = (await queryPrefix(sub, "FOOD#")).map((i) => strip(i) as unknown as SavedFood);
  return all.filter((f) => {
    const name = normalizeName(f.name);
    return words.every((w) => name.includes(w));
  });
}

export async function deleteFood(sub: string, name: string): Promise<boolean> {
  const res = await doc.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: keys.pk(sub), SK: keys.food(normalizeName(name)) }, ReturnValues: "ALL_OLD" }),
  );
  return Boolean(res.Attributes);
}

// --- Pots ------------------------------------------------------------------------

export interface Pot {
  label: string;
  empty_grams: number;
  note?: string;
  updated_at: string;
}

export async function savePot(sub: string, pot: Omit<Pot, "updated_at">): Promise<{ pot: Pot; replaced: boolean }> {
  const item = { ...pot, updated_at: new Date().toISOString() };
  const res = await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: keys.pk(sub), SK: keys.pot(normalizeName(pot.label)), type: "pot", ...item },
      ReturnValues: "ALL_OLD",
    }),
  );
  return { pot: item, replaced: Boolean(res.Attributes) };
}

export async function getPot(sub: string, label: string): Promise<Pot | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: keys.pk(sub), SK: keys.pot(normalizeName(label)) } }));
  return res.Item ? (strip(res.Item) as unknown as Pot) : undefined;
}

export async function listPots(sub: string): Promise<Pot[]> {
  return (await queryPrefix(sub, "POT#")).map((i) => strip(i) as unknown as Pot);
}
