// Meal-prep batches in DynamoDB.
//
//   BATCH#<id>                      the dish: ingredients, totals, what's left
//   BATCHLOG#<batch>#<time>#<id>    one line per portion taken (me or someone else)
//   ENTRY#... (entries.ts)          my portions, with batch_id + batch_units
//
// Concurrency: every change to a batch is conditional on the value read
// just before ("remaining is still 6667", "updated_at is still ..."), so two
// requests can't both take the last third (optimistic locking). The loser
// gets BatchChanged and simply retries.

import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { WHOLE, scale } from "../domain/batch";
import type { Item, Nutrition } from "../domain/nutrition";
import { TABLE, conditionFailedAt, doc, keys, writeOnce, type TransactItems } from "./db";
import { getRecord, newEntryRecords, toEntry, type Entry, type EntryRecord, type Meal } from "./entries";

export type BatchStatus = "open" | "finished" | "discarded";

export interface Batch {
  batch_id: string;
  name: string;
  items: Item[];
  totals: Nutrition;
  raw_grams?: number;
  total_grams?: number;
  portions?: number;
  remaining: number; // ten-thousandths of the dish
  status: BatchStatus;
  cooked_at: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

interface BatchRecord extends Batch {
  PK: string;
  SK: string;
  type: "batch";
}

export class BatchChanged extends Error {
  constructor() {
    super("the batch changed at the same time; try again");
  }
}

function toBatch(r: BatchRecord): Batch {
  const { PK: _p, SK: _s, type: _t, ...batch } = r;
  return batch;
}

export interface NewBatch {
  name: string;
  items: Item[];
  totals: Nutrition;
  raw_grams?: number;
  total_grams?: number;
  portions?: number;
  cookedAt: Date;
}

export async function createBatch(sub: string, input: NewBatch, idempotency: { key: string; request: unknown }): Promise<{ batch: Batch; replayed: boolean }> {
  const now = new Date().toISOString();
  const id = ulid();
  const record: BatchRecord = {
    PK: keys.pk(sub),
    SK: keys.batch(id),
    type: "batch",
    batch_id: id,
    name: input.name,
    items: input.items,
    totals: input.totals,
    raw_grams: input.raw_grams,
    total_grams: input.total_grams,
    portions: input.portions,
    remaining: WHOLE,
    status: "open",
    cooked_at: input.cookedAt.toISOString(),
    created_at: now,
    updated_at: now,
  };
  const outcome = await writeOnce(sub, idempotency, { batch_id: id }, [{ Put: { TableName: TABLE, Item: record } }]);
  if (!outcome.replayed) return { batch: toBatch(record), replayed: false };
  const existing = await getBatch(sub, outcome.result.batch_id);
  if (!existing) throw new Error("the batch created with this idempotency_key no longer exists");
  return { batch: existing, replayed: true };
}

export async function getBatch(sub: string, id: string): Promise<Batch | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: keys.pk(sub), SK: keys.batch(id) } }));
  return res.Item ? toBatch(res.Item as BatchRecord) : undefined;
}

export async function listBatches(sub: string, includeClosed: boolean): Promise<Batch[]> {
  const out: Batch[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": keys.pk(sub), ":prefix": "BATCH#" },
        ExclusiveStartKey: start,
      }),
    );
    for (const item of res.Items ?? []) {
      const b = toBatch(item as BatchRecord);
      if (includeClosed || b.status === "open") out.push(b);
    }
    start = res.LastEvaluatedKey;
  } while (start);
  return out.sort((a, b) => b.cooked_at.localeCompare(a.cooked_at));
}

export interface Portion {
  units: number;
  eatenBy: "me" | "other";
  eatenAt: Date;
  meal?: Meal;
  /** How the portion was asked for, kept in the entry ("350 g", "1/3"). */
  label: string;
  grams?: number;
}

/**
 * Takes a portion out of a batch, in one transaction (behind the
 * idempotency record): decrease what's left (only if it's still what we
 * read), write the batch log line, and for "me" write the journal entry and
 * its pointer. All of it or none of it.
 */
export async function eatFromBatch(
  sub: string,
  batch: Batch,
  portion: Portion,
  timeZone: string,
  idempotency: { key: string; request: unknown },
): Promise<{ entry?: Entry; batch: Batch; replayed: boolean }> {
  const now = new Date().toISOString();
  const left = batch.remaining - portion.units;
  const status: BatchStatus = left <= 0 ? "finished" : "open";
  const logId = ulid();

  let entryRecords: ReturnType<typeof newEntryRecords> | undefined;
  if (portion.eatenBy === "me") {
    const totals = scale(batch.totals, portion.units);
    entryRecords = newEntryRecords(
      sub,
      {
        description: batch.name,
        meal: portion.meal,
        items: [{ name: batch.name, quantity: portion.label, grams: portion.grams, ...totals }],
        totals,
        eatenAt: portion.eatenAt,
        batch_id: batch.batch_id,
        batch_units: portion.units,
      },
      timeZone,
    );
  }

  const writes: TransactItems = [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: keys.pk(sub), SK: keys.batch(batch.batch_id) },
        UpdateExpression: "SET remaining = :left, #status = :status, updated_at = :now" + (status === "finished" ? ", closed_at = :now" : ""),
        ConditionExpression: "remaining = :expected AND #status = :open",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":left": Math.max(left, 0), ":status": status, ":now": now, ":expected": batch.remaining, ":open": "open" },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: {
          PK: keys.pk(sub),
          SK: keys.batchLog(batch.batch_id, now, logId),
          type: "batchlog",
          batch_id: batch.batch_id,
          eaten_by: portion.eatenBy,
          units: portion.units,
          entry_id: entryRecords?.record.entry_id,
          at: portion.eatenAt.toISOString(),
        },
      },
    },
  ];
  if (entryRecords) {
    writes.push({ Put: { TableName: TABLE, Item: entryRecords.record } }, { Put: { TableName: TABLE, Item: entryRecords.ref } });
  }

  try {
    const outcome = await writeOnce(sub, idempotency, { batch_id: batch.batch_id, entry_id: entryRecords?.record.entry_id ?? null }, writes);
    if (outcome.replayed) {
      const entryId = outcome.result.entry_id;
      const record = entryId ? await getRecord(sub, entryId) : undefined;
      const current = await getBatch(sub, batch.batch_id);
      return { entry: record ? toEntry(record) : undefined, batch: current ?? batch, replayed: true };
    }
  } catch (e) {
    if (conditionFailedAt(e, 1)) throw new BatchChanged();
    throw e;
  }
  return {
    entry: entryRecords ? toEntry(entryRecords.record) : undefined,
    batch: { ...batch, remaining: Math.max(left, 0), status, updated_at: now, closed_at: status === "finished" ? now : undefined },
    replayed: false,
  };
}

export interface BatchChanges {
  name?: string;
  items?: Item[];
  totals?: Nutrition;
  raw_grams?: number;
  total_grams?: number;
  portions?: number;
}

/**
 * Corrects a batch. When the recipe (items) changes, every entry already
 * eaten from it is recomputed in the same transaction: it's the same pot,
 * so "it was 20% fat mince" also applies to what I already ate. Portions
 * keep their share of the dish (batch_units); only the content changes.
 */
export async function updateBatch(sub: string, batch: Batch, changes: BatchChanges): Promise<{ batch: Batch; recomputed: number }> {
  const now = new Date().toISOString();
  const next: Batch = {
    ...batch,
    name: changes.name ?? batch.name,
    items: changes.items ?? batch.items,
    totals: changes.totals ?? batch.totals,
    raw_grams: changes.items ? changes.raw_grams : batch.raw_grams,
    total_grams: changes.total_grams ?? batch.total_grams,
    portions: changes.portions ?? batch.portions,
    updated_at: now,
  };

  const writes: TransactItems = [
    {
      Put: {
        TableName: TABLE,
        Item: { PK: keys.pk(sub), SK: keys.batch(batch.batch_id), type: "batch", ...next } satisfies BatchRecord,
        ConditionExpression: "updated_at = :seen",
        ExpressionAttributeValues: { ":seen": batch.updated_at },
      },
    },
  ];

  let recomputed = 0;
  if (changes.totals || changes.name) {
    for (const record of await portionEntries(sub, batch.batch_id)) {
      const units = record.batch_units ?? 0;
      const totals = scale(next.totals, units);
      const item = record.items[0];
      writes.push({
        Put: {
          TableName: TABLE,
          Item: {
            ...record,
            description: next.name,
            items: [{ name: next.name, quantity: item?.quantity, grams: item?.grams, ...totals }],
            totals,
            updated_at: now,
          } satisfies EntryRecord,
        },
      });
      recomputed++;
    }
  }
  if (writes.length > 100) throw new Error("too many portions to recompute in one go");

  try {
    await doc.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (e) {
    if (conditionFailedAt(e, 0)) throw new BatchChanged();
    throw e;
  }
  return { batch: next, recomputed };
}

/** My live (not deleted) entries eaten from a batch, found through its log lines. */
async function portionEntries(sub: string, batchId: string): Promise<EntryRecord[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": keys.pk(sub), ":prefix": `BATCHLOG#${batchId}#` },
    }),
  );
  const records: EntryRecord[] = [];
  for (const log of res.Items ?? []) {
    if (!log.entry_id) continue;
    const record = await getRecord(sub, log.entry_id as string);
    if (record && !record.deleted_at) records.push(record);
  }
  return records;
}

export async function closeBatch(sub: string, batch: Batch, reason: "finished" | "discarded"): Promise<Batch> {
  const now = new Date().toISOString();
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: keys.pk(sub), SK: keys.batch(batch.batch_id) },
              UpdateExpression: "SET #status = :status, closed_at = :now, updated_at = :now",
              ConditionExpression: "updated_at = :seen",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":status": reason, ":now": now, ":seen": batch.updated_at },
            },
          },
        ],
      }),
    );
  } catch (e) {
    if (conditionFailedAt(e, 0)) throw new BatchChanged();
    throw e;
  }
  return { ...batch, status: reason, closed_at: now, updated_at: now };
}

/**
 * Deleting an entry that was a batch portion puts the portion back in the
 * pot (a mistaken "I ate a third" shouldn't empty the batch), reopening it
 * if that portion had finished it. A discarded batch stays discarded.
 */
export async function deletePortionEntry(sub: string, record: EntryRecord): Promise<void> {
  const now = new Date().toISOString();
  const batch = record.batch_id ? await getBatch(sub, record.batch_id) : undefined;
  const writes: TransactItems = [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: keys.pk(sub), SK: record.SK },
        UpdateExpression: "SET deleted_at = :now",
        ConditionExpression: "attribute_not_exists(deleted_at)",
        ExpressionAttributeValues: { ":now": now },
      },
    },
  ];
  if (batch && batch.status !== "discarded" && record.batch_units) {
    writes.push({
      Update: {
        TableName: TABLE,
        Key: { PK: keys.pk(sub), SK: keys.batch(batch.batch_id) },
        UpdateExpression: "SET remaining = :back, #status = :open, updated_at = :now REMOVE closed_at",
        ConditionExpression: "updated_at = :seen",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":back": Math.min(batch.remaining + record.batch_units, WHOLE),
          ":open": "open",
          ":now": now,
          ":seen": batch.updated_at,
        },
      },
    });
  }
  try {
    await doc.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (e) {
    if (conditionFailedAt(e, 0)) return; // already deleted: nothing to do
    if (conditionFailedAt(e, 1)) throw new BatchChanged();
    throw e;
  }
}
