# mcp-servers

MCP servers for my personal apps, deployed on my own AWS landing zone
([maws777/landing-zone](https://github.com/maws777/landing-zone)).

The first one is a **food tracker**: I tell Claude what I ate, Claude
estimates the nutrition, and the server checks the estimate, does the
arithmetic and stores it. A phone dashboard (PWA) shows the day, the trends
and a short daily summary written by a model on Amazon Bedrock.

| | |
|---|---|
| `apps/food/src` | The MCP server (18 tools), the dashboard API, the summary Lambda |
| `apps/food/infra` | Terraform: Lambda, API Gateway, DynamoDB, Cognito, Bedrock access |
| `apps/food/web` | The dashboard (TypeScript, no framework, strict CSP) |
| `apps/food/eval` | Evals of the daily summary against real models |
| `packages/shared` | Auth (Cognito tokens, OAuth metadata) and the Lambda entry for every MCP server |
| `docs/` | Design docs, ADRs, and explainers (in French) for each phase |

## How it's tested

Four layers, from milliseconds to real models:

| Layer | What it checks | When |
|---|---|---|
| **Unit** (61 tests, Vitest) | Nutrition checks and sums, meal-prep portions, time zones, the summary prompt's output validation and injection escaping, the eval's own checks | Every pull request |
| **Store** (39 tests, DynamoDB Local) | Idempotent logging (a retried call stores the meal once), concurrent portions, user isolation, the dashboard API, and the **MCP server through a real MCP client**: the tool list Claude reads, and errors it can act on (« 2480 kcal doesn't match its macros… Re-check ») | Every pull request |
| **Smoke** (after deploy) | Unauthenticated calls refused (401), dashboard served with its CSP | Every deploy |
| **Eval** ([apps/food/eval](apps/food/eval/README.md)) | The daily summary written by real models: 25 made-up days × 5 runs, 10 automatic checks (numbers grounded in the server's stats, no unsafe advice, prompt injection resisted…), pass rate, stability across runs, latency, cost | By hand or weekly (calls real models) |

Latest eval, 2026-11-25: 11 models, 1,375 calls ([analysis](apps/food/eval/README.md#results-2026-11-25), [full report](apps/food/eval/results/summary-2026-11-25.md)). Top of the table:

| Model | Every check | Safety rules only | p50 latency | Cost per summary |
|---|---|---|---|---|
| Amazon Nova 2 Lite | 92 % | 98 % | 1.1 s | $0.0015 |
| Amazon Nova Pro | 90 % | 98 % | 1.0 s | $0.0025 |
| Qwen3 235B 2507 | 87 % | 100 % | 1.6 s | $0.0004 |
| DeepSeek V3.2 (in production) | 86 % | 98 % | 2.5 s | $0.0014 |
| Claude Sonnet 4.6 | 52 % | 100 % | 2.7 s | $0.0106 |

```powershell
npm ci
npm test                                                     # unit
docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2     # then, in another terminal:
npm run test:store                                           # store + MCP
$env:AWS_PROFILE = "staging-admin"; npm run eval:summary     # eval (real models, ~$3 for all 11)
```
