// One summary for one user and one day: skip if nothing changed, take one
// from the quota, call the model, check its answer, store it.

import { listEntries } from "../store/entries";
import { getProfile } from "../store/profile";
import { today } from "../domain/time";
import { log } from "@mcp/shared";
import { buildContext, dayHash } from "./context";
import type { InvokeModel } from "./model";
import { validateOutput } from "./prompt";
import { getSummary, isFresh, markGenerating, putNote, putSummary, registerUser, takeQuota } from "./store";

export const MAX_PER_DAY = Number(process.env.SUMMARIES_PER_DAY ?? "20");

export type Outcome = "generated" | "fresh" | "empty" | "not_today" | "quota" | "invalid";

export async function generateSummary(
  sub: string,
  date: string,
  opts: { final: boolean; model: InvokeModel; now?: Date },
): Promise<Outcome> {
  const now = opts.now ?? new Date();
  const profile = await getProfile(sub);
  // Only today is summarized: past days keep what they had. Stops a caller
  // from paying for summaries of a whole year of history.
  if (date !== today(profile.time_zone, now)) return "not_today";

  const entries = await listEntries(sub, date, date);
  if (entries.length === 0) return "empty";

  const hash = dayHash(entries, profile);
  const existing = await getSummary(sub, date);
  if (isFresh(existing, hash) && (existing.final || !opts.final)) return "fresh";

  if (!(await takeQuota(sub, date, MAX_PER_DAY, now))) return "quota";
  await markGenerating(sub, date, hash, now);
  await registerUser(sub);

  const ctx = await buildContext(sub, date, entries, profile, opts.final, now);
  const started = Date.now();
  const result = await opts.model(ctx);
  // Token counts and timing only: never the prompt, never the answer.
  log("model_call", {
    final: opts.final,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    stop_reason: result.stop_reason,
    ms: Date.now() - started,
  });

  const out = validateOutput(result.output, opts.final);
  if (!out) return "invalid";

  await putSummary(sub, { date, hash, resume: out.resume, conseil: out.conseil, final: opts.final, generated_at: now.toISOString() });
  if (opts.final && out.note) await putNote(sub, date, out.note);
  return "generated";
}
