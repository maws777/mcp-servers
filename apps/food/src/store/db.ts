// DynamoDB client and key helpers. Single table per environment
// (docs/design/food-v1.md, section 4): every item of a user is under
// PK = USER#<sub>, so every read is one Query on one partition, and the
// partition comes from the verified token.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE = process.env.TABLE_NAME ?? "mcp-food-local";

export const keys = {
  pk: (sub: string) => `USER#${sub}`,
  entry: (date: string, time: string, id: string) => `ENTRY#${date}#${time}#${id}`,
  entryRef: (id: string) => `ENTRYREF#${id}`,
  idem: (key: string) => `IDEM#${key}`,
  profile: () => "PROFILE",
};

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
