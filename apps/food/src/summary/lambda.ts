// Lambda entry for the AI summaries, mcp-food-<env>-summary.
//
// Two callers, both inside the account, neither reachable from the internet:
//   the dashboard Lambda, asynchronously:  { mode: "day", sub, date }
//   the nightly schedule (23:30 Paris):    { mode: "close-day" }
//
// Trusting `sub` from the event is safe because nothing public can invoke
// this function: it has no API route and no resource policy, so only IAM
// principals of this account allowed lambda:InvokeFunction on it can, which
// are the dashboard role (it took `sub` from a verified token) and the
// schedule's role (infra/summary.tf). The CI roles are denied invoking.
//
// Its role reads the journal and writes only the summaries table: a prompt
// injection that went all the way could at worst write an odd summary.

import { log } from "@mcp/shared";
import { getProfile } from "../store/profile";
import { DATE_RE, today } from "../domain/time";
import { generateSummary } from "./generate";
import { bedrockModel } from "./model";
import { listUsers } from "./store";

type SummaryEvent = { mode: "day"; sub: string; date: string } | { mode: "close-day" };

// Which model, and the region its endpoint is in (not always this function's).
const model = bedrockModel(process.env.MODEL_ID ?? "qwen.qwen3-235b-a22b-2507-v1:0", process.env.MODEL_REGION ?? "eu-north-1");

export async function handler(event: SummaryEvent): Promise<void> {
  if (event.mode === "day") {
    if (typeof event.sub !== "string" || !event.sub || !DATE_RE.test(event.date)) {
      log("summary_bad_event");
      return;
    }
    const outcome = await run(event.sub, event.date, false);
    log("summary", { mode: "day", outcome });
    return;
  }

  if (event.mode === "close-day") {
    const subs = await listUsers();
    const outcomes: Record<string, number> = {};
    for (const sub of subs) {
      const date = today((await getProfile(sub)).time_zone);
      const outcome = await run(sub, date, true);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    log("summary", { mode: "close-day", users: subs.length, outcomes });
    return;
  }

  log("summary_bad_event");
}

async function run(sub: string, date: string, final: boolean) {
  try {
    return await generateSummary(sub, date, { final, model });
  } catch (e) {
    log("summary_error", { name: (e as Error).name, message: (e as Error).message });
    return "error" as const;
  }
}
