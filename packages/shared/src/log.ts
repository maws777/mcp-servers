// Structured JSON logs (one object per line, queryable in CloudWatch Logs
// Insights). Rule: never log tokens, and never log what I ate (descriptions,
// ingredients): diet data stays in the table. Log IDs, tool names, outcomes.

export function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}
