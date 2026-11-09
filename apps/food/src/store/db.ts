// DynamoDB client and key helpers. Single table per environment
// (docs/design/food-v1.md, section 4): every item of a user is under
// PK = USER#<sub>, so every read is one Query on one partition, and the
// partition comes from the verified token.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE = process.env.TABLE_NAME ?? "mcp-food-local";

export const keys = {
  pk: (sub: string) => `USER#${sub}`,
  entry: (date: string, time: string, id: string) => `ENTRY#${date}#${time}#${id}`,
  entryRef: (id: string) => `ENTRYREF#${id}`,
  batch: (id: string) => `BATCH#${id}`,
  batchLog: (batchId: string, at: string, id: string) => `BATCHLOG#${batchId}#${at}#${id}`,
  food: (normalized: string) => `FOOD#${normalized}`,
  pot: (normalized: string) => `POT#${normalized}`,
  weight: (date: string) => `WEIGHT#${date}`,
  idem: (key: string) => `IDEM#${key}`,
  profile: () => "PROFILE",
};

export type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>;

export class IdempotencyConflict extends Error {}

/**
 * Runs a transaction exactly once per idempotency key.
 *
 * The transaction gets one more write in front: the idempotency record,
 * conditional on the key being new. If the key was already used, the whole
 * transaction is cancelled (nothing is written twice) and the first call's
 * stored result comes back with replayed = true. The same key with a
 * different request is refused: that's a client bug, not a retry.
 */
export async function writeOnce<R extends Record<string, unknown>>(
  sub: string,
  idempotency: { key: string; request: unknown },
  result: R,
  writes: TransactItems,
): Promise<{ replayed: false; result: R } | { replayed: true; result: R }> {
  const pk = keys.pk(sub);
  const print = fingerprint(idempotency.request);
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { PK: pk, SK: keys.idem(idempotency.key), type: "idem", fingerprint: print, result, expires_at: idemExpiry() },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          ...writes,
        ],
      }),
    );
    return { replayed: false, result };
  } catch (e) {
    if (!firstConditionFailed(e)) throw e;
    const prior = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: keys.idem(idempotency.key) } }));
    if (prior.Item?.fingerprint !== print) {
      throw new IdempotencyConflict("this idempotency_key was already used for a different request; generate a new one");
    }
    return { replayed: true, result: prior.Item.result as R };
  }
}

/** True when a transaction failed because of the condition on the item at `index`. */
export function conditionFailedAt(e: unknown, index: number): boolean {
  const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return (e as Error).name === "TransactionCanceledException" && reasons?.[index]?.Code === "ConditionalCheckFailed";
}

/** Idempotency records live 24 h, then DynamoDB's TTL deletes them. */
export function idemExpiry(now = new Date()): number {
  return Math.floor(now.getTime() / 1000) + 24 * 3600;
}

/** Fingerprint of a request, to spot an idempotency key reused for different content. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** True when a TransactWriteItems failed because of the condition on its first item. */
export function firstConditionFailed(e: unknown): boolean {
  const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return (e as Error).name === "TransactionCanceledException" && reasons?.[0]?.Code === "ConditionalCheckFailed";
}
