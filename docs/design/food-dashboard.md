# Food dashboard (phase 4)

Status: design, agreed 2026-11-09. Builds on `food-v1.md` (server, data
model) and spike 2 (`spikes/02-pwa-login`: iPhone home-screen login works).

A read-only website, installed on my iPhone's home screen, that shows what
the MCP server stores: today's meals against my targets, trends, what's left
in the fridge, a history calendar, and later an AI summary of the day.
Claude stays the only way to write; the dashboard only reads.

## 1. Decisions

| Question | Decision |
|---|---|
| Address | `https://food.staging.lab.michaelteplov.com` (prod later: `food.lab.michaelteplov.com`). The MCP endpoint keeps its own name, `food.mcp.…` |
| How the page reaches its data | **Same origin.** CloudFront serves the site and forwards `/api/*` to the existing API Gateway. No CORS, CSP `connect-src` stays `'self'` + Cognito |
| Token storage | Access token in memory, refresh token in `localStorage`, strict CSP. [ADR 0001](../decisions/0001-dashboard-token-storage.md) |
| Split | **4a** dashboard, **4b** AI summaries, **4c** web push (alarms, evening nudge). One PR each, each usable on its own |

## 2. Phase 4a: the dashboard

```
iPhone (home-screen PWA)
  │  https://food.staging.lab.michaelteplov.com
  ▼
CloudFront ── default ──► S3 mcp-food-staging-site-<account id> (private, OAC)
  │           (hashed assets cached a year, index.html never)
  └── /api/* ──► food.mcp.staging.lab.michaelteplov.com (API Gateway, same HTTP API)
                    └── GET /api/{proxy+} ──► Lambda mcp-food-staging-dashboard
                                                 └── DynamoDB mcp-food-staging (read only)
login: Cognito managed login (michaelteplov-mcp-staging), client mcp-food-staging-dashboard
```

### Pieces

- **Bucket** `mcp-food-staging-site-<account id>`: matches the CI role's app
  bucket pattern `mcp-*-<env>-*` (landing-zone PR #21). Public access
  blocked; only the distribution reads it (origin access control).
- **Distribution**: certificate in `us-east-1` (CloudFront only takes
  certificates from there; a second `aws` provider alias), alias records in
  the network zone through the DNS role. Two behaviors:
  - default → S3. Hashed file names (`app.3f9c1a.js`) get a long cache;
    `index.html`, `manifest.webmanifest` and `config.json` are served
    `no-cache`, so a deploy shows up at the next app open, without
    invalidations.
  - `/api/*` → API Gateway's custom domain. Managed policies
    `CachingDisabled` + `AllViewerExceptHostHeader` (API Gateway needs its
    own host name; the page's `Authorization` header must get through).
    **Check during the build** that `Authorization` reaches the Lambda with
    these managed policies; fallback: a cache policy with `Authorization` in
    the key and TTL 0.
- **Response headers policy** (as tested in spike 2): `Content-Security-
  Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src
  'self' data:; connect-src 'self' https://michaelteplov-mcp-staging.auth.eu-west-3.amazoncognito.com;
  manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  plus HSTS, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`.
- **Cognito client** `mcp-food-staging-dashboard`: public, PKCE, `food:read`
  only, callback `https://food.staging.lab.michaelteplov.com/`, refresh
  token rotation, access token 60 min, refresh token 30 days. Requests the
  token with `resource = https://food.mcp.staging.lab.michaelteplov.com/mcp`,
  so it carries the same `aud` as claude.ai's.
- **Dashboard Lambda** `mcp-food-staging-dashboard`, its own role:
  `dynamodb:GetItem` + `Query` on the table, nothing else. A bug or an
  injected request in the dashboard path can't write. Token check from
  `packages/shared`: client allow-list = the dashboard client only, scope
  `food:read`, `aud` = the MCP URL. Separately, the MCP Lambda keeps
  accepting only claude.ai's client, so a dashboard token can't call tools.

### API (all `GET`, `food:read`, JSON)

| Route | Returns | Built from |
|---|---|---|
| `/api/day?date=` | Entries of the day, totals, targets, what's left | `listEntries`, `getProfile` |
| `/api/trends?days=7\|30` | Daily totals, averages, weights | `listEntries`, `listWeights` |
| `/api/fridge` | Open batches: name, what's left (portions, grams), age in days | `listBatches` |
| `/api/history?month=YYYY-MM` | kcal per day, for the calendar | `listEntries` |

Dates are local dates in the profile's time zone, like the tools. The
routes reuse the store and domain code the MCP tools use: one source of truth
for the numbers Claude reports and the numbers the page shows.

### Front end

- Plain TypeScript bundled by esbuild, no framework: fewer dependencies in
  the page that holds a token, and nothing that needs inline scripts or
  `eval` (the CSP forbids both).
- **Everything from the API is rendered as text** (`textContent`, never
  `innerHTML`): meal descriptions are written by Claude from what I typed or
  photographed, so they're untrusted. A CI check fails the build if
  `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` appear
  in the front-end code.
- Charts as SVG elements built in code (no chart library).
- `manifest.webmanifest` (`display: standalone`) + `apple-touch-icon`. No
  service worker in 4a (it would add a second cache to reason about); 4c
  adds one for push.
- `config.json`, written by Terraform: Cognito domain, client ID, resource.
  The same bundle runs in staging and prod.

### Deploy

Same workflow as the server: the PR plans, `main` applies. The site files are
`aws_s3_object`s, so the plan lists which files change. Smoke test: the page
answers 200 with the CSP header, `/api/day` without a token answers 401.

### Cost

No fixed cost. CloudFront's always-free tier (1 TB, 10 M requests a month),
S3 cents, the certificate free, alias records free.

### Threats handled in 4a

| Threat | Control |
|---|---|
| Stored XSS (a meal named `<script>…`) | Text-only rendering + CI check, CSP `script-src 'self'` with no inline |
| Stolen dashboard token | `food:read` only, 60-minute access token, rotation (a reused refresh token is refused), dashboard client not accepted by the MCP Lambda |
| Reading another user's data | User ID from the token's `sub`, never from the request (as in the tools) |
| Clickjacking | `frame-ancestors 'none'` |
| Abuse of `/api` | API Gateway throttling (same stage limits as `/mcp`); read-only routes, no Bedrock in 4a |

## 3. Phase 4b: AI summaries (outline)

- `GET /api/summary?date=` returns the cached `SUMMARY#<date>` at once. If
  the hash of that day's entries changed since, the dashboard Lambda starts
  the summary Lambda asynchronously (`lambda:InvokeFunction`, allowed by the
  boundary since landing-zone PR #21); the page polls once.
- Summary Lambda, its own role: read the day, write `SUMMARY#` / `NOTE#`,
  `bedrock:InvokeModel` on the `eu.anthropic.claude-haiku-5-5` profile and
  its six EU destinations (allowed by landing-zone ADR 0014).
- Nightly EventBridge Scheduler run in `Europe/Paris`: the "day closed"
  summary and the one-line diary note.
- Prompt injection: meal text goes in as quoted data, the model has no
  tools, its output is length-capped and rendered as text.
- Cost control: regenerate only on change, a per-user daily cap, the
  budget alarm. Price per summary to measure on real calls before enabling
  the nightly run.

## 4. Phase 4c: web push (outline)

- Service worker + Push API (iOS 16.4+, home-screen apps only).
- The VAPID signing key in SSM Parameter Store (SecureString, free), its
  value set by hand, never in Terraform state. Needs a landing-zone PR (CI
  and boundary permissions on `parameter/mcp/*`).
- Registering the phone is a write, and the dashboard's token is read-only:
  a narrow new scope `food:devices` (manage push subscriptions, nothing
  else).
- Alarms (Lambda errors, API 5xx, DynamoDB throttles) → the alarm calls a
  push Lambda directly, no SNS or email. Then the evening nudge.
