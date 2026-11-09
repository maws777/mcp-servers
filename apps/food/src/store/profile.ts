// The user's profile (time zone, daily targets) and body weight.

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Nutrition } from "../domain/nutrition";
import { TABLE, doc, keys } from "./db";

export interface Profile {
  time_zone: string;
  targets?: Partial<Nutrition>;
}

export const DEFAULT_TIME_ZONE = process.env.DEFAULT_TIME_ZONE ?? "Europe/Paris";

export async function getProfile(sub: string): Promise<Profile> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: keys.pk(sub), SK: keys.profile() } }));
  return {
    time_zone: (res.Item?.time_zone as string | undefined) ?? DEFAULT_TIME_ZONE,
    targets: res.Item?.targets as Partial<Nutrition> | undefined,
  };
}

/** Merges new targets into the existing ones (unspecified targets stay), and sets the time zone if given. */
export async function updateProfile(sub: string, changes: { targets?: Partial<Nutrition>; time_zone?: string }): Promise<Profile> {
  const current = await getProfile(sub);
  const next: Profile = {
    time_zone: changes.time_zone ?? current.time_zone,
    targets: { ...current.targets, ...changes.targets },
  };
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: keys.pk(sub), SK: keys.profile() },
      UpdateExpression: "SET #type = :type, time_zone = :tz, targets = :targets, updated_at = :now",
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: { ":type": "profile", ":tz": next.time_zone, ":targets": next.targets, ":now": new Date().toISOString() },
    }),
  );
  return next;
}

export interface Weight {
  date: string; // local date
  kg: number;
  measured_at: string;
}

/** One weight per day: a second weighing the same day replaces the first. */
export async function logWeight(sub: string, weight: Weight): Promise<void> {
  await doc.send(
    new PutCommand({ TableName: TABLE, Item: { PK: keys.pk(sub), SK: keys.weight(weight.date), type: "weight", ...weight } }),
  );
}

export async function listWeights(sub: string, from: string, to: string): Promise<Weight[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": keys.pk(sub), ":from": keys.weight(from), ":to": keys.weight(to) },
    }),
  );
  return (res.Items ?? []).map((i) => ({ date: i.date, kg: i.kg, measured_at: i.measured_at }) as Weight);
}
