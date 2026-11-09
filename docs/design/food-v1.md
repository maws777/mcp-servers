# Food tracker v1: design

Status: draft for review (2026-11-09). Builds on the two spikes
(`spikes/01-claude-auth`, `spikes/02-pwa-login`) and on landing-zone ADRs
0012/0013. Each section marked **ADR** gets a decision record in
`docs/decisions/` when it's built.

## 1. What it is

A remote MCP server I use daily from Claude (claude.ai, desktop, Claude Code)
to track what I eat, including meal-prep batches (cook a pot, eat it over
several days). Later, a read-only dashboard on my phone.

**Principle (ADR): Claude estimates, the server validates and computes.**
Claude turns a description or a photo into numbers (kcal, protein, carbs,
fat, fiber) and calls a tool with them. The server has no food database and
does no estimating. It checks that values are plausible, stores them, and
does every piece of arithmetic itself (fractions of a batch, totals, what's
left, averages). A language model can misdivide 2,400 kcal by 3; code can't.

Consistency between days comes from saved foods: a repeated meal reuses
stored values instead of being re-estimated.

## 2. Build order

1. **Phase 1, journal:** repo skeleton, shared auth package, the food server
   with the journal tools, its table and infrastructure, custom domain.
   Deployed to staging locally, connected in claude.ai, used daily.
2. **Phase 2:** meal prep (with pots), saved foods, targets, trends, weight.
3. **Phase 3:** CI (GitHub Actions, the landing zone's `ci/mcp-ci-*` roles).
4. **Phase 4:** dashboard (S3 + CloudFront PWA) and AI summaries (Bedrock).
   Needs two landing-zone PRs first: CloudFront/S3 permissions for the CI
   apply role, and the Bedrock region exception in the region SCP.
5. **Phase 5:** prod (same module, tagged releases, approval gate).

## 3. Tools

Units: energy in kcal, macros and fiber in grams, weight in kg. Times are
ISO 8601; a time without offset is read in my time zone (`Europe/Paris`,
stored in the profile). A "day" is a calendar day in that time zone.

Every tool that **creates** something (`log_food`, `create_batch`,
`eat_from_batch`) takes an `idempotency_key` (a UUID Claude generates per
action). The same key within 24 hours returns the first result instead of
writing again, so a retried request can't log a meal twice; the same key with
different content is refused. Updates, deletes and "set" tools don't need
one: applying them twice gives the same result (they're naturally
idempotent).

The user is always the token's `sub`. No tool has a user parameter.

### Nutrition values (shared shape)

| Field | Type | Range per entry | Range per batch |
|---|---|---|---|
| `kcal` | number | 0-5,000 | 0-30,000 |
| `protein_g`, `carbs_g`, `fat_g` | number | 0-500 | 0-3,000 |
| `fiber_g` | number, optional | 0-150 | 0-1,000 |
| `alcohol_g` | number, optional | 0-200 | 0-1,000 |

Plus a consistency check: `4 × protein + 4 × carbs + 9 × fat + 7 × alcohol` must be within
±25 % of `kcal` (with fiber and rounding, real foods land well inside). A
value outside it is rejected with a message Claude can act on. This catches
a misplaced digit, the commonest estimation slip.

### Items: a meal or a dish is a list of ingredients

I usually describe what went in ("500 g beef mince 5 %, 2 cans of kidney
beans, 400 g crushed tomatoes, an onion, 1 tbsp oil"), not just "a chili".
So `log_food` and `create_batch` take a list of **items**, and Claude
estimates each one separately:

| Field | Type | Notes |
|---|---|---|
| `name` | string, 1-80 chars | "beef mince 5 % fat" |
| `quantity` | string, optional, 1-40 chars | As I said it: "500 g", "2 cans", "1 tbsp" |
| `grams` | number, optional, 0-10,000 | When known or estimable: raw weight |
| nutrition | shape above | For this quantity of this item |

The server checks each item, then **sums them itself** into the totals (1 to
30 items). Why this is better than one number for the whole dish:

- **More accurate:** Claude estimates 500 g of beef mince more reliably than
  "a pot of chili", and errors on separate items tend not to stack the same
  way.
- **Visible and fixable:** the breakdown is stored, so "actually it was 20 %
  fat mince" changes one item; the server recomputes the totals.
- **Reusable:** an ingredient I use often can become a saved food ("beef
  mince 5 %, per 100 g") and be scaled by Claude next time.
- **Math stays in code:** Claude never adds up 6 ingredients in its head.

A one-thing meal ("a banana") is simply a list of one item.

### Journal

| Tool | Input | Result |
|---|---|---|
| `log_food` | `description` (1-200 chars), `items` (1-30), `eaten_at`?, `meal`? (`breakfast`/`lunch`/`dinner`/`snack`), `idempotency_key` | The stored entry with its `entry_id` and computed totals |
| `list_entries` | `from`, `to` (dates, max 31 days) | Entries, newest first, with daily totals |
| `update_entry` | `entry_id`, any of description / `items` (full replacement) / `eaten_at` / `meal`, `idempotency_key` | The updated entry, totals recomputed |
| `delete_entry` | `entry_id`, `idempotency_key` | Soft delete (hidden, recoverable) |
| `daily_summary` | `date`? (default today) | Totals vs targets, remaining to target, entries count, open batches count |

### Meal prep (ADR)

A **batch** is a cooked dish, described by its ingredients with quantities
(the items above); the server sums them into the whole dish's nutrition.
Optionally its cooked weight and roughly how many portions it makes.

**Cooked weight is not the sum of the raw weights.** Cooking loses water
(meat, simmering) or gains it (rice, pasta), so a chili made from 1.6 kg of
raw ingredients can weigh 1.3 kg. Nutrition comes from the raw items; eating
"350 g" needs the **cooked** weight (`total_grams`), which only a scale gives.
Without it, the server refuses gram amounts and Claude asks, or uses a
fraction or portions instead. The sum of the items' raw grams is stored
separately (`raw_grams`) for information only.

**Pots (tare weights).** Weighing food out of a hot pot is impractical;
weighing the whole pot is easy. Each of my pots is weighed empty once and
saved with a label ("3", "big wok"). Then "2.1 kg in pot 3" is enough: the
server subtracts pot 3's empty weight (say 700 g) and stores 1,400 g of
cooked food. The cooked weight can be given three ways, all optional:

- `gross_grams` + `pot`: weighed in a saved pot, the server subtracts the tare;
- `total_grams`: net weight, if I weighed it another way;
- nothing: the batch is eaten by fractions or portions only.

It can be added later too (`update_batch`), e.g. weighed the next day.
Convention: pots are weighed **without lid**, both empty and full.

| Tool | Input | Result |
|---|---|---|
| `save_pot` | `label` (1-30 chars), `empty_grams` (50-10,000), `note`? ("with lid") | Created or replaced |
| `list_pots` | - | Saved pots and their empty weights |

| Tool | Input | Result |
|---|---|---|
| `create_batch` | `name`, `items` (1-30), cooked weight? (`total_grams`, or `gross_grams` + `pot`), `portions`?, `cooked_at`?, `idempotency_key` | The batch with its `batch_id` and computed totals |
| `list_batches` | `include_closed`? (default false) | Each batch: remaining fraction, and when known remaining grams/portions, remaining nutrition, age in days |
| `eat_from_batch` | `batch_id`, exactly one of `fraction` (0-1], `grams`, `portions`, `rest: true`; `eaten_by` (`me` default, or `other`), `eaten_at`?, `idempotency_key` | What was taken, the journal entry (when `me`), what's left |
| `update_batch` | `batch_id`, any of name / `items` (full replacement) / cooked weight (`total_grams`, or `gross_grams` + `pot`) / `portions` | The updated batch, totals recomputed, and the entries already eaten from it recomputed too (see 6. below) |
| `close_batch` | `batch_id`, `reason` (`finished` / `discarded`) | Closed batch |

How `eat_from_batch` works:

1. The amount becomes a fraction of the whole dish: `grams / total_grams`,
   `portions / portions`, `fraction` as given, or everything left for `rest`.
   Grams need `total_grams` on the batch, portions need `portions`; otherwise
   the tool says what's missing (Claude can call `update_batch` first).
2. If the fraction is within 0.01 of what remains, it counts as the rest
   (three "thirds" finish the dish instead of leaving 0.0001).
3. For `me`, the entry's nutrition is the batch's totals × the fraction,
   rounded to 0.1. For `other`, nothing is logged; the portion just leaves the
   pot.
4. One DynamoDB transaction: decrease `remaining` on the condition
   `remaining >= fraction`, write the journal entry, write the batch log line,
   write the idempotency record. All or nothing: no entry without the
   decrement, no double decrement. Eating more than is left is refused.
5. When `remaining` reaches 0 the batch closes itself (`finished`).
6. An entry eaten from a batch stores its `batch_id` and its fraction, not
   just numbers. If I later correct the recipe ("it was 20 % fat mince"),
   `update_batch` recomputes the batch totals **and** every entry eaten from
   it (fraction × new totals), in the same transaction: it's the same pot, so
   the correction applies to what I already ate. (A transaction holds up to
   100 writes; a batch is eaten a handful of times.)

DynamoDB stores numbers as exact decimals (up to 38 digits), not binary
floats, so `1 - 1/3 - 1/3` doesn't drift. Fractions are kept to 4 decimals.

Batches are never deleted; closed ones stay for history. A batch shared with
another *user* of the app is out of scope.

### Saved foods

| Tool | Input | Result |
|---|---|---|
| `save_food` | `name` (1-80 chars), nutrition per serving, `serving` (free text, e.g. "1 bowl, 250 g") | Created or replaced |
| `find_my_food` | `query` | Saved foods whose name matches (case and accent insensitive) |
| `delete_food` | `name` | Removed |

`log_food` stays the way to log; Claude finds the saved food first, then logs
its values (scaled if I ate two servings).

### Targets, trends, weight

| Tool | Input | Result |
|---|---|---|
| `set_targets` | any of daily `kcal`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`; `time_zone`? | The profile |
| `get_trends` | `days` (7-90, default 30) | Daily totals, averages, days on target, days logged, weight trend if any |
| `log_weight` | `kg` (30-300), `measured_at`?, `idempotency_key` | Stored (one per day; a second the same day replaces it) |

### Server instructions

MCP lets the server send instructions to the client. They shape data quality
more than any validation, so they're part of the design:

- Before logging, say the estimate in one line (food, kcal, macros) so I can
  correct it; log right away unless I asked to confirm first.
- Check `find_my_food` before estimating something I eat often.
- Estimate each ingredient separately, with the quantity I gave; never add
  up or divide in your head (the server sums items and splits batches).
- For a batch, ask for the cooked weight only if I want to eat by grams.
- When I mention leftovers, check `list_batches` before creating anything.
- Never advise eating less to make up for a big day.

## 4. Data model (ADR)

DynamoDB, on demand, one table per environment: `mcp-food-<env>`. Single
table: every item of a user sits under one partition key, so each read is one
`Query` on one partition, and a user can't reach another's items without a
different key (the key comes from the token).

| Item | `PK` | `SK` | Notes |
|---|---|---|---|
| Journal entry | `USER#<sub>` | `ENTRY#<yyyy-mm-dd>#<hh:mm:ss>#<id>` | `items` and computed totals, or `batch_id` + `fraction` for a batch portion. Local date in the SK: a day or a range is one `Query` with `BETWEEN`. Changing `eaten_at` moves the item (delete + put in one transaction) |
| Batch | `USER#<sub>` | `BATCH#<id>` | `items`, computed totals, `raw_grams`, `total_grams` (cooked), `portions`, `remaining`, `status`, `cooked_at` |
| Batch log | `USER#<sub>` | `BATCHLOG#<batch id>#<timestamp>` | Who ate what, for history and the dashboard |
| Saved food | `USER#<sub>` | `FOOD#<normalized name>` | Normalized: lowercase, no accents |
| Pot | `USER#<sub>` | `POT#<normalized label>` | `empty_grams`, `note` |
| Weight | `USER#<sub>` | `WEIGHT#<yyyy-mm-dd>` | One per day |
| Profile | `USER#<sub>` | `PROFILE` | Targets, time zone |
| Idempotency | `USER#<sub>` | `IDEM#<key>` | Stored result, expires after 24 h (DynamoDB TTL) |
| Later (phase 4) | `USER#<sub>` | `SUMMARY#<date>`, `NOTE#<date>` | AI summaries and diary notes |

IDs are ULIDs (sortable by creation time). Totals and trends are computed on
read: a 30-day trend is about 150 entries, one `Query`, no stored aggregates
to keep in sync.

Table settings: point-in-time recovery on (restore to any second of the last
35 days; cents at this size), deletion protection on, encryption at rest
(AWS-owned key, free). Diet data may be GDPR Article 9 health data: one table
and one IAM role for this app only, nothing else reads it, the CI pipeline
can't read items (landing-zone ADR 0013).

Why DynamoDB and not Aurora Serverless v2: scale-to-zero means a ~15 s resume
on the first call of the day, and an always-on Aurora is far over budget.

## 5. Architecture

```
claude.ai ──HTTPS──> food.mcp.staging.lab.michaelteplov.com
                     (Route 53 alias, ACM certificate in eu-west-3)
                          │
                     API Gateway HTTP API (throttling: the rate limit)
                          │
                     Lambda mcp-food-staging (Node 22, arm64)
                       ├─ token check (shared package)
                       └─ MCP SDK v2, createMcpHandler (both protocol eras)
                          │
                     DynamoDB mcp-food-staging
```

- **Custom domain from day one.** The spikes showed the MCP URL is the
  Cognito resource server identifier and the prefix of every scope; changing
  it later would break every client's sign-in.
- **Packaging: zip now, container image with CI (phase 3).** The server
  code is written against web-standard `Request`/`Response` (only a thin
  entry adapts API Gateway events), so moving to a container image with the
  Lambda Web Adapter, and to Fargate for the optional demo stack, changes the
  entry point, not the server. Building arm64 images belongs in CI (GitHub's
  arm64 runners), not on my Windows laptop. ECR repository `mcp/food` then.
- **Auth (ADR)**, from spike 1: shared pool `mcp-staging`; resource server
  identifier = `https://food.mcp.staging.lab.michaelteplov.com/mcp`, scopes
  `<that>/food:read` and `<that>/food:write`; one pre-registered public client
  per caller (claude.ai now, a Claude Code client with a `localhost` callback
  if wanted, the dashboard later with `food:read` only). Token check:
  signature, `iss`, `exp`, `token_use = access`, `client_id` allow-list,
  scope, **and `aud` required** (present thanks to resource binding).
  Read tools need `food:read`, write tools `food:write`; a token missing the
  scope gets 403 `insufficient_scope`.
- **No VPC.** Lambda reaches DynamoDB over AWS's public endpoints with IAM
  auth; a VPC would add NAT cost for nothing.
- **Logs:** structured JSON, 14-day retention, never tokens, never meal
  descriptions (only IDs, tool names, durations, outcomes).

Cost estimate at my usage: Lambda, API Gateway, DynamoDB and Cognito inside
free tiers or cents; ECR a few cents for the image; the Route 53 hosted zone
already exists (landing zone). Expect under €0.50/month for staging.

## 6. Repository layout

```
mcp-servers/
├── packages/
│   └── shared/            # token check, API Gateway ↔ Request adapter, logging
├── apps/
│   └── food/
│       ├── src/
│       │   ├── tools/     # one file per tool group: schemas (Zod) + handlers
│       │   ├── domain/    # pure logic: nutrition checks, batch math, dates
│       │   ├── store/     # DynamoDB access
│       │   └── server.ts  # McpServer factory, instructions
│       ├── test/          # unit tests (domain), store tests on DynamoDB Local
│       ├── Dockerfile
│       └── infra/         # table, ECR, Lambda, API, domain, Cognito resource server + clients
├── infra/staging/shared/  # user pool (exists)
├── docs/{design,decisions,explained}/
└── spikes/                # done, kept for reference
```

npm workspaces, TypeScript, Vitest. The domain folder has no AWS imports, so
the batch math is tested in milliseconds.

## 7. Open questions

- Dashboard token storage (localStorage + strict CSP, or memory + refresh
  token only): decided in phase 4.
- Claude Code as a second client (needs a `localhost` callback client): when
  wanted.
- Prod account: phase 5.
