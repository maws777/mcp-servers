// The user's profile: time zone now, targets in phase 2 (set_targets).

import { GetCommand } from "@aws-sdk/lib-dynamodb";
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
