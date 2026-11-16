// The summaries table (docs/design/food-dashboard.md, section 3), separate
// from the journal so the summary Lambda, the one component that puts meal
// descriptions in front of a model, can write here and only read the journal.
//
//   PK = USER#<sub>  SK = SUMMARY#<date>   latest summary of that day + the hash it was built from
//                    SK = NOTE#<date>      the model's one-line diary note, written at night
//                    SK = QUOTA#<date>     generations used that day (TTL deletes it)
//   PK = USERS       SK = USER#<sub>       who to summarize at night, without a Scan

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { doc, keys } from "../store/db";

export const SUMMARY_TABLE = process.env.SUMMARY_TABLE_NAME ?? "mcp-food-summaries-local";

const sk = {
  summary: (date: string) => `SUMMARY#${date}`,
  note: (date: string) => `NOTE#${date}`,
  quota: (date: string) => `QUOTA#${date}`,
  user: (sub: string) => `USER#${sub}`,
};

export interface Summary {
  date: string;
  /** Fingerprint of the day's entries and targets this summary was built from. */
  hash: string;
  resume: string;
  conseil: string;
  /** Written by the nightly run: the day is closed. */
  final: boolean;
  generated_at: string;
}

export interface SummaryItem extends Partial<Summary> {
  date: string;
  /** Set when a generation starts, so the page doesn't ask twice for the same state. */
  generating_hash?: string;
  generating_at?: string;
}

export async function getSummary(sub: string, date: string): Promise<SummaryItem | undefined> {
  const res = await doc.send(new GetCommand({ TableName: SUMMARY_TABLE, Key: { PK: keys.pk(sub), SK: sk.summary(date) } }));
  if (!res.Item) return undefined;
  const { PK: _pk, SK: _sk, ...item } = res.Item;
  return item as SummaryItem;
}

/** True when the item holds a summary of exactly this state of the day. */
export function isFresh(item: SummaryItem | undefined, hash: string): item is SummaryItem & Summary {
  return item?.hash === hash && typeof item.resume === "string";
}

/** Marks a generation as started, keeping the previous summary visible meanwhile. */
export async function markGenerating(sub: string, date: string, hash: string, now = new Date()): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: SUMMARY_TABLE,
      Key: { PK: keys.pk(sub), SK: sk.summary(date) },
      UpdateExpression: "SET #date = :date, generating_hash = :hash, generating_at = :at",
      ExpressionAttributeNames: { "#date": "date" },
      ExpressionAttributeValues: { ":date": date, ":hash": hash, ":at": now.toISOString() },
    }),
  );
}

/** Replaces the day's summary (and clears the generating marker). */
export async function putSummary(sub: string, summary: Summary): Promise<void> {
  await doc.send(new PutCommand({ TableName: SUMMARY_TABLE, Item: { PK: keys.pk(sub), SK: sk.summary(summary.date), ...summary } }));
}

export async function putNote(sub: string, date: string, note: string): Promise<void> {
  await doc.send(new PutCommand({ TableName: SUMMARY_TABLE, Item: { PK: keys.pk(sub), SK: sk.note(date), date, note } }));
}

export async function listNotes(sub: string, from: string, to: string): Promise<{ date: string; note: string }[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: SUMMARY_TABLE,
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": keys.pk(sub), ":from": sk.note(from), ":to": sk.note(to) },
    }),
  );
  return (res.Items ?? []).map((i) => ({ date: i.date as string, note: i.note as string }));
}

/**
 * Takes one generation from the day's quota. The check and the increment are
 * one conditional write, so two concurrent calls can't both take the last one.
 * Returns false when the quota is used up.
 */
export async function takeQuota(sub: string, date: string, max: number, now = new Date()): Promise<boolean> {
  try {
    await doc.send(
      new UpdateCommand({
        TableName: SUMMARY_TABLE,
        Key: { PK: keys.pk(sub), SK: sk.quota(date) },
        UpdateExpression: "ADD used :one SET expires_at = :exp",
        ConditionExpression: "attribute_not_exists(used) OR used < :max",
        ExpressionAttributeValues: { ":one": 1, ":max": max, ":exp": Math.floor(now.getTime() / 1000) + 3 * 24 * 3600 },
      }),
    );
    return true;
  } catch (e) {
    if ((e as Error).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** Remembers that this user has summaries, for the nightly run. */
export async function registerUser(sub: string): Promise<void> {
  await doc.send(new PutCommand({ TableName: SUMMARY_TABLE, Item: { PK: "USERS", SK: sk.user(sub), sub } }));
}

export async function listUsers(): Promise<string[]> {
  const subs: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: SUMMARY_TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": "USERS" },
        ExclusiveStartKey: start,
      }),
    );
    for (const i of res.Items ?? []) subs.push(i.sub as string);
    start = res.LastEvaluatedKey;
  } while (start);
  return subs;
}
