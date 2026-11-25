// Runs the eval set against real models on Bedrock and writes the report to
// eval/results/. Calls real models, so it costs a little (cents) and is run
// by hand or weekly, never on every pull request:
//
//   npm run eval:summary                                   all models, 5 runs
//   EVAL_MODELS=deepseek EVAL_RUNS=1 npm run eval:summary  one quick pass
//
// Locally it needs AWS credentials allowed to call the models (AWS_PROFILE).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { bedrockModel } from "../../src/summary/model";
import { runChecks } from "./checks";
import { DAYS } from "./days";
import { MODELS } from "./models";
import { renderReport, type RunRecord } from "./report";

const runs = Number(process.env.EVAL_RUNS ?? "5");
const concurrency = Number(process.env.EVAL_CONCURRENCY ?? "3");
const wanted = process.env.EVAL_MODELS ? process.env.EVAL_MODELS.split(",") : MODELS.map((m) => m.key);
const models = MODELS.filter((m) => wanted.includes(m.key));
const days = process.env.EVAL_DAYS ? DAYS.filter((d) => process.env.EVAL_DAYS!.split(",").includes(d.id)) : DAYS;

/** Runs the tasks a few at a time: Bedrock's on-demand quotas are per minute. */
async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]!();
      }
    }),
  );
  return out;
}

const ACCESS = /AccessDenied|not available for this account|ValidationException.*model identifier/i;

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

interface Saved {
  runs: number;
  unavailable: Record<string, string>;
  records: RunRecord[];
}

const load = (date: string): Saved | null => {
  const file = join(resultsDir, `summary-${date}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Saved) : null;
};

/**
 * Writes the day's report. A run of some models adds to what that day already
 * has for the others (adding a model doesn't mean re-running every model).
 */
function write(date: string, records: RunRecord[], unavailable: Record<string, string>, runsPerDay: number, merge: boolean) {
  const previous = merge ? load(date) : null;
  if (previous) {
    const rerun = new Set([...records.map((r) => r.model), ...Object.keys(unavailable)]);
    records = [...previous.records.filter((r) => !rerun.has(r.model)), ...records];
    unavailable = { ...Object.fromEntries(Object.entries(previous.unavailable).filter(([k]) => !rerun.has(k))), ...unavailable };
  }
  // A model whose every call was refused for access is unavailable, not failing
  // (the probe can miss it, e.g. when it was itself throttled).
  for (const key of new Set(records.map((r) => r.model))) {
    const mine = records.filter((r) => r.model === key);
    if (mine.every((r) => r.error && ACCESS.test(r.error))) {
      unavailable = { ...unavailable, [key]: mine[0]!.error!.slice(0, 160) };
      records = records.filter((r) => r.model !== key);
    }
  }
  const present = new Set([...records.map((r) => r.model), ...Object.keys(unavailable)]);
  const shown = MODELS.filter((m) => present.has(m.key));
  mkdirSync(resultsDir, { recursive: true });
  const report = renderReport({ date, runs: runsPerDay, days, models: shown, records, unavailable });
  writeFileSync(join(resultsDir, `summary-${date}.md`), report + "\n");
  writeFileSync(join(resultsDir, `summary-${date}.json`), JSON.stringify({ date, runs: runsPerDay, models: shown, unavailable, records }, null, 1) + "\n");
  console.log(report);
}

// EVAL_RESCORE=2026-11-25: the checks again on that run's saved answers, no
// model call. For when a check is fixed: the numbers then come from the same
// answers, not from a new (and different) sample.
const rescore = process.env.EVAL_RESCORE;

it.runIf(rescore)("rescore a saved run", () => {
  const saved = load(rescore!);
  if (!saved) throw new Error(`no saved run for ${rescore}`);
  const byId = new Map(days.map((d) => [d.id, d]));
  const records = saved.records.map((r) => (r.error ? r : { ...r, checks: runChecks(r, byId.get(r.day)!) }));
  write(rescore!, records, saved.unavailable, saved.runs, false);
  expect(records.length).toBeGreaterThan(0);
});

it.skipIf(rescore)("daily summary eval", { timeout: 3 * 60 * 60 * 1000 }, async () => {
  const records: RunRecord[] = [];
  const unavailable: Record<string, string> = {};

  await Promise.all(
    models.map(async (m) => {
      const call = bedrockModel(m.modelId, m.region);

      // One probe first: a model the account can't use is reported, not run 125 times.
      try {
        await call(days[0]!.ctx);
      } catch (e) {
        const msg = `${(e as Error).name}: ${(e as Error).message}`;
        if (ACCESS.test(msg)) {
          unavailable[m.key] = msg.slice(0, 160);
          return;
        }
      }

      const tasks = days.flatMap((day) =>
        Array.from({ length: runs }, (_, run) => async (): Promise<RunRecord> => {
          let started = Date.now();
          try {
            // Throttling says nothing about the model: wait and retry, and time only the call that answered.
            let result;
            for (let attempt = 1; ; attempt++) {
              try {
                started = Date.now();
                result = await call(day.ctx);
                break;
              } catch (e) {
                if (!/Throttling|TooManyRequests|ServiceUnavailable/i.test((e as Error).name) || attempt === 5) throw e;
                await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
              }
            }
            return { model: m.key, day: day.id, run: run + 1, ms: Date.now() - started, ...result, checks: runChecks(result, day) };
          } catch (e) {
            const error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 200);
            return { model: m.key, day: day.id, run: run + 1, ms: Date.now() - started, input_tokens: 0, output_tokens: 0, stop_reason: null, output: null, error, checks: [] };
          }
        }),
      );
      records.push(...(await pool(tasks, concurrency)));
    }),
  );

  write(new Date().toISOString().slice(0, 10), records, unavailable, runs, true);
  expect(records.length).toBeGreaterThan(0);
});
