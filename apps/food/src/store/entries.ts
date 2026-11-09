// Journal entries in DynamoDB.
//
// Layout:
//   ENTRY#<local date>#<local time>#<id>   the entry, sorted by when I ate
//   ENTRYREF#<id>                          points to the entry's sort key
//
// Why the pointer: the sort key holds the date so a day or a range is one
// Query (SK BETWEEN ...). But then an entry's key changes when its time is
// corrected, and Claude needs a stable ID to update or delete it. The ID
// stays the same; the pointer says where the entry currently lives.

import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import type { Item, Nutrition } from "../domain/nutrition";
import { localParts } from "../domain/time";
import { TABLE, doc, fingerprint, firstConditionFailed, idemExpiry, keys } from "./db";

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";

export interface Entry {
  entry_id: string;
  description: string;
  meal?: Meal;
  items: Item[];
  totals: Nutrition;
  eaten_at: string; // ISO UTC
  local_date: string;
  local_time: string;
  created_at: string;
  updated_at: string;
}

interface EntryRecord extends Entry {
  PK: string;
  SK: string;
  type: "entry";
  deleted_at?: string;
}

function toEntry(r: EntryRecord): Entry {
  const { PK: _pk, SK: _sk, type: _t, deleted_at: _d, ...entry } = r;
  return entry;
}

export interface NewEntry {
  description: string;
  meal?: Meal;
  items: Item[];
  totals: Nutrition;
  eatenAt: Date;
}

export class IdempotencyConflict extends Error {}

/**
 * Creates an entry, exactly once per idempotency key.
 *
 * One transaction writes three items: the idempotency record (only if the
 * key is new), the entry and its pointer. If the key was already used, the
 * transaction is cancelled as a whole (nothing written twice) and the first
 * call's result is returned instead. A retried request from the client thus
 * gets the same answer, and the meal is logged once.
 */
export async function createEntry(
  sub: string,
  input: NewEntry,
  timeZone: string,
  idempotency: { key: string; request: unknown },
): Promise<{ entry: Entry; replayed: boolean }> {
  const idempotencyKey = idempotency.key;
  const pk = keys.pk(sub);
  const now = new Date().toISOString();
  const id = ulid();
  const { date, time } = localParts(input.eatenAt, timeZone);
  const entry: Entry = {
    entry_id: id,
    description: input.description,
    meal: input.meal,
    items: input.items,
    totals: input.totals,
    eaten_at: input.eatenAt.toISOString(),
    local_date: date,
    local_time: time,
    created_at: now,
    updated_at: now,
  };
  const sk = keys.entry(date, time, id);
  // Fingerprint of the request as sent (not of the resolved time: without
  // eaten_at, "now" differs between a call and its retry).
  const print = fingerprint(idempotency.request);

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { PK: pk, SK: keys.idem(idempotencyKey), type: "idem", fingerprint: print, result: { entry_id: id }, expires_at: idemExpiry() },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          { Put: { TableName: TABLE, Item: { PK: pk, SK: sk, type: "entry", ...entry } satisfies EntryRecord } },
          { Put: { TableName: TABLE, Item: { PK: pk, SK: keys.entryRef(id), type: "entryref", sk } } },
        ],
      }),
    );
    return { entry, replayed: false };
  } catch (e) {
    if (!firstConditionFailed(e)) throw e;
    const prior = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: keys.idem(idempotencyKey) } }));
    if (prior.Item?.fingerprint !== print) {
      throw new IdempotencyConflict("this idempotency_key was already used for a different entry; generate a new one");
    }
    const existing = await getEntry(sub, prior.Item.result.entry_id);
    if (!existing) throw new Error("the entry logged with this idempotency_key no longer exists");
    return { entry: existing, replayed: true };
  }
}

async function getRecord(sub: string, id: string): Promise<EntryRecord | undefined> {
  const pk = keys.pk(sub);
  const ref = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: keys.entryRef(id) } }));
  if (!ref.Item) return undefined;
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: ref.Item.sk } }));
  return res.Item as EntryRecord | undefined;
}

export async function getEntry(sub: string, id: string): Promise<Entry | undefined> {
  const r = await getRecord(sub, id);
  return r && !r.deleted_at ? toEntry(r) : undefined;
}

/** Entries from `from` to `to` (local dates, inclusive), oldest first, deleted ones left out. */
export async function listEntries(sub: string, from: string, to: string): Promise<Entry[]> {
  const out: Entry[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
        FilterExpression: "attribute_not_exists(deleted_at)",
        ExpressionAttributeValues: { ":pk": keys.pk(sub), ":from": `ENTRY#${from}`, ":to": `ENTRY#${to}#~` },
        ExclusiveStartKey: start,
      }),
    );
    for (const item of res.Items ?? []) out.push(toEntry(item as EntryRecord));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

export interface EntryChanges {
  description?: string;
  meal?: Meal;
  items?: Item[];
  totals?: Nutrition;
  eatenAt?: Date;
}

/**
 * Applies changes. Naturally idempotent: applying the same changes twice
 * gives the same entry, so no idempotency key is needed. If the time moves
 * the entry to another sort key, the old item is deleted, the new one written
 * and the pointer updated, in one transaction.
 */
export async function updateEntry(sub: string, id: string, changes: EntryChanges, timeZone: string): Promise<Entry | undefined> {
  const current = await getRecord(sub, id);
  if (!current || current.deleted_at) return undefined;
  const pk = keys.pk(sub);

  const eatenAt = changes.eatenAt ?? new Date(current.eaten_at);
  const { date, time } = localParts(eatenAt, timeZone);
  const next: EntryRecord = {
    ...current,
    description: changes.description ?? current.description,
    meal: changes.meal ?? current.meal,
    items: changes.items ?? current.items,
    totals: changes.totals ?? current.totals,
    eaten_at: eatenAt.toISOString(),
    local_date: date,
    local_time: time,
    updated_at: new Date().toISOString(),
    SK: keys.entry(date, time, id),
  };

  const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
    { Put: { TableName: TABLE, Item: next } },
  ];
  if (next.SK !== current.SK) {
    writes.push(
      { Delete: { TableName: TABLE, Key: { PK: pk, SK: current.SK } } },
      { Put: { TableName: TABLE, Item: { PK: pk, SK: keys.entryRef(id), type: "entryref", sk: next.SK } } },
    );
  }
  await doc.send(new TransactWriteCommand({ TransactItems: writes }));
  return toEntry(next);
}

/** Soft delete: hidden from every read, still in the table (recoverable). Idempotent. */
export async function deleteEntry(sub: string, id: string): Promise<boolean> {
  const current = await getRecord(sub, id);
  if (!current) return false;
  if (current.deleted_at) return true;
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: keys.pk(sub), SK: current.SK },
      UpdateExpression: "SET deleted_at = :now",
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
    }),
  );
  return true;
}
