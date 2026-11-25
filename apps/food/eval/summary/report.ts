// From raw runs to numbers: pass rates, stability across runs, latency, cost.
// Pure functions, unit-tested (test/eval-summary.test.ts).

import { CHECKS, type CheckId, type CheckResult } from "./checks";
import type { EvalDay } from "./days";
import type { EvalModel } from "./models";

export interface RunRecord {
  model: string;
  day: string;
  run: number;
  ms: number;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string | null;
  output: unknown;
  /** The call itself failed (throttling, timeout, access): counted as a failed run. */
  error?: string;
  checks: CheckResult[];
}

export const passed = (r: RunRecord) => !r.error && r.checks.length > 0 && r.checks.every((c) => c.pass);

/** The rules about what the summary may tell me, as opposed to its form (lengths, numbers, note). */
export const SAFETY: CheckId[] = ["stale_dish", "forbidden_advice", "no_praise_over", "injection"];

/** No valid answer counts as a failure here too. */
export const safe = (r: RunRecord) => !r.error && r.checks.some((c) => c.id === "format" && c.pass) && r.checks.every((c) => c.pass || !SAFETY.includes(c.id));

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface ModelStats {
  runs: number;
  errors: number;
  /** Share of runs where every applicable check passed. */
  passRate: number;
  /** Share of runs where every applicable safety rule (SAFETY) held. */
  safeRate: number;
  /** Share of days where every run passed (pass^k: the model gets it right every time). */
  allRunsPass: number;
  /** Share of days where all runs agree (all pass or all fail): how reproducible a verdict is. */
  stable: number;
  perCheck: Partial<Record<CheckId, { pass: number; total: number }>>;
  latencyP50: number | null;
  latencyP95: number | null;
  inputTokens: number;
  outputTokens: number;
  /** US dollars per summary, from mean tokens and list price. */
  costPerSummary: number;
}

export function modelStats(records: RunRecord[], model: EvalModel): ModelStats {
  const mine = records.filter((r) => r.model === model.key);
  const ok = mine.filter((r) => !r.error);
  const byDay = new Map<string, RunRecord[]>();
  for (const r of mine) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const days = [...byDay.values()];

  const perCheck: ModelStats["perCheck"] = {};
  for (const r of ok) {
    for (const c of r.checks) {
      const s = (perCheck[c.id] ??= { pass: 0, total: 0 });
      s.total++;
      if (c.pass) s.pass++;
    }
  }

  const inputTokens = mean(ok.map((r) => r.input_tokens));
  const outputTokens = mean(ok.map((r) => r.output_tokens));
  return {
    runs: mine.length,
    errors: mine.length - ok.length,
    passRate: mine.length ? mine.filter(passed).length / mine.length : 0,
    safeRate: mine.length ? mine.filter(safe).length / mine.length : 0,
    allRunsPass: days.length ? days.filter((d) => d.every(passed)).length / days.length : 0,
    stable: days.length ? days.filter((d) => d.every(passed) || !d.some(passed)).length / days.length : 0,
    perCheck,
    latencyP50: percentile(ok.map((r) => r.ms), 50),
    latencyP95: percentile(ok.map((r) => r.ms), 95),
    inputTokens,
    outputTokens,
    costPerSummary: (inputTokens * model.price.input + outputTokens * model.price.output) / 1e6,
  };
}

// --- Markdown ------------------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 100)} %`;
const sec = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);

export function renderReport(opts: { date: string; runs: number; days: EvalDay[]; models: EvalModel[]; records: RunRecord[]; unavailable: Record<string, string> }): string {
  const { date, runs, days, models, records, unavailable } = opts;
  const ran = models.filter((m) => !unavailable[m.key]);
  const stats = new Map(ran.map((m) => [m.key, modelStats(records, m)]));
  const s = (m: EvalModel) => stats.get(m.key)!;
  const lines: string[] = [];

  lines.push(`# Daily summary eval, ${date}`, "");
  lines.push(
    `${days.length} made-up days × ${runs} runs per model, same prompt and call as production ` +
      "(Bedrock Converse, forced tool call). Checks are automatic, no human judge. Protocol: [eval/README.md](../README.md).",
    "",
  );
  for (const [key, why] of Object.entries(unavailable)) {
    lines.push(`Not run: **${models.find((m) => m.key === key)?.label ?? key}** (${why}).`, "");
  }

  lines.push("## Results", "");
  lines.push("| Model | Runs passing every check | Safety rules only | Days passing all runs | Stable verdict across runs | Latency p50 / p95 | Tokens in / out | Cost per summary | Call errors |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const m of ran) {
    const x = s(m);
    lines.push(
      `| ${m.label} | ${pct(x.passRate)} | ${pct(x.safeRate)} | ${pct(x.allRunsPass)} | ${pct(x.stable)} | ${sec(x.latencyP50)} / ${sec(x.latencyP95)} | ` +
        `${Math.round(x.inputTokens)} / ${Math.round(x.outputTokens)} | $${x.costPerSummary.toFixed(5)} | ${x.errors} / ${x.runs} |`,
    );
  }
  lines.push("");

  lines.push("## By check", "", `| Check | ${ran.map((m) => m.label).join(" | ")} |`, `|---|${ran.map(() => "---").join("|")}|`);
  for (const [id, what] of Object.entries(CHECKS) as [CheckId, string][]) {
    const cells = ran.map((m) => {
      const c = s(m).perCheck[id];
      return c ? `${pct(c.pass / c.total)} (${c.pass}/${c.total})` : "–";
    });
    lines.push(`| ${what} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## By day", "", "Runs passing every check, out of the runs made.", "");
  lines.push(`| Day | ${ran.map((m) => m.label).join(" | ")} |`, `|---|${ran.map(() => "---").join("|")}|`);
  for (const d of days) {
    const cells = ran.map((m) => {
      const mine = records.filter((r) => r.model === m.key && r.day === d.id);
      return `${mine.filter(passed).length}/${mine.length}`;
    });
    lines.push(`| ${d.label} (\`${d.id}\`) | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Failures, examples", "", "Up to three per model and check, with what the check saw.", "");
  for (const m of ran) {
    const failures = records.filter((r) => r.model === m.key && !passed(r));
    if (!failures.length) continue;
    lines.push(`### ${m.label}`, "");
    const shown: Partial<Record<string, number>> = {};
    for (const r of failures) {
      const reasons = r.error ? [{ id: "call", detail: r.error }] : r.checks.filter((c) => !c.pass);
      for (const c of reasons) {
        if ((shown[c.id] = (shown[c.id] ?? 0) + 1) > 3) continue;
        const o = r.output as { resume?: string; conseil?: string } | null;
        const text = o?.resume ? ` Summary: « ${o.resume.slice(0, 220)}${o.resume.length > 220 ? "…" : ""} » Tip: « ${o.conseil ?? ""} »` : "";
        lines.push(`- \`${r.day}\` run ${r.run}, **${c.id}**: ${c.detail ?? ""}.${text}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
