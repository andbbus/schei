# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Schei ("money" in the author's dialect) — a local-first envelope-budgeting app modeled on YNAB's engine and UX. Single user, no auth. Optionally seeded from a YNAB TSV export.

## Commands

```bash
# one-click launch (installs deps + creates the DB on first run, starts both, opens browser)
./start.command            # macOS double-click; same flow cross-platform via:
npm start                  # root scripts/start-all.mjs (spawn + health-wait + browser open)
npm run setup              # root: install deps + prisma db push, then exit (no seed)
npm run icon               # root: (re)create the Desktop "Schei" launcher (auto on setup/first run)

# backend (cwd: backend/) — Fastify + Prisma + SQLite on :3001
npm run dev          # tsx watch src/server.ts
npm test             # ALL suites: engine/* + routes/{ops,tools,debts,bulk,payees,goals,setup,...}.test.ts (assert-based, tsx, no framework)
npm run oracle       # validate engine vs the real YNAB export's Plan.tsv (expect 100%)
npm run db:push      # create/sync SQLite schema (no migrations; seeds .env from .env.example via scripts/ensure-env.mjs — dev/start/db:* scripts all do, fresh clones have no .env)
npm run seed         # WIPE all budgets + re-import the export (idempotent; needs the export files — fresh clones don't have them, the in-app wizard takes that path)
npm run import "/path/to/export dir"   # import a specific export
npx tsc --noEmit -p .                  # typecheck

# frontend (cwd: frontend/) — React + Vite + Tailwind v4 on :5173
npm run dev
npm test             # vitest: filters.ts, csv.ts, lib/bva.ts, payoff.ts (+ new pure modules)
npm run build        # tsc -b + vite build (typechecks; .test.ts files are excluded from the build)
npx tsc --noEmit -p tsconfig.app.json  # typecheck
```

**Tests**: backend suites are plain `node:assert` scripts run via `tsx` — each
test file calls `test()` and logs `ok`/`PASSED`; `npm test` chains them with
`&&`. Route tests (`routes/ops.test.ts`, `routes/debts.test.ts`) boot Fastify
with `app.inject()` against a **temp SQLite DB** (`/tmp/schei-*-test-*.db` +
`prisma db push --skip-generate`) — never touch `dev.db`. Frontend tests use
**vitest**; import `describe/it/expect` explicitly from `'vitest'` (no globals).

## The engine is the whole point

All budgeting logic lives in **`backend/src/engine/`** as **pure functions** operating on plain objects (decoupled from Prisma so they're testable and runnable against raw TSV). The database stores only **inputs** — transactions and per-month `assigned` amounts (plus plan/rule inputs). Everything else (`activity`, `available`, Ready-to-Assign, age of money, target state, amortization schedules, payee-rule matches, cash-flow projections) is **derived on read**, never stored. Do not add denormalized balance columns; recompute instead.

- `engine/budget.ts` — `computeBudget()` is the core: per-(month,category) activity/available, carryover, Ready-to-Assign, cash-overspend. Also `accountBalances()`, month helpers (`monthOf`, `addMonths`, `listMonths`).
- `engine/targets.ts`, `engine/ageOfMoney.ts`, `engine/autoAssign.ts` — the other derived pieces.
- `engine/schedule.ts` — recurrence date math; `nextOccurrence(frequency, date, anchorDay?)` (anchorDay pins monthly day-of-month, avoiding 31st→28th drift).
- `engine/postings.ts` — shared **posting predicate** (`categoryPostings`): on-budget only, sub-postings authoritative, future-dated excluded. Consumed by the spending report and the drill-down route so report totals, drill-down footers and budget activity can never drift apart.
- `engine/rules.ts` — **general rules engine** (modeled on Actual Budget): one condition (`field: payeeName|memo|account`, `op: is/isNot/oneOf/notOneOf/contains/doesNotContain/regex`) + one action (`category | payeeName-rename | prependNotes | appendNotes`) per rule; `rankRules()` orders least→most specific per stage (`pre`→`default`→`post`, Actual's op-score ranking, id tie-break) and `applyRules()` runs them cumulatively — **last (most-specific) write wins**. Unicode case-folded, regex capped at 200 chars, invalid regex never matches.
- `engine/payeeRules.ts` — bridge from Prisma `PayeeRule` rows to the engine (`liveRules` drops disabled rows + dead category targets; legacy `=` pattern prefix = exact-op; `SYSTEM_PAYEES`/transfer payees excluded via `matchablePayee`). Callers use `derivePatch(input, rows, liveCats)` → `{categoryId?, payeeName?, memo?, matchedRuleIds}` or the thin `pickCategory`. One condition + one action stored per row (`field/op/stage/enabled/action/actionText` columns); matching is always JS, never SQL LIKE.
- **Category auto-learning** (`routes/register.ts`): `GET /rules/learning-offer?payee=` gates server-side (global `Budget.categoryLearning`, `Payee.learnDisabled`, no existing covering rule, modal category ≥3 rows & ≥60%) → UI offers "Always categorize X as Y?" → standard rule create with `op:"is"`. `POST /rules/auto-rename {pattern,toName}` creates a `pre`-stage rename rule after orphaning renames. Per-payee toggle: `POST /payees/:id/learn-toggle`; global: `POST /settings/category-learning`.
- **Retro-apply is undoable**: `POST /payee-rules/apply` runs the full pipeline over eligible existing transactions inside ONE `$transaction` and logs a single `applyRules` delta op (`rows:[{id, prev:{categoryId,payeeId,memo}, next}]`) — undo restores exact prev values per row. `POST /payee-rules/preview` powers the editor's live match list. Frontend mirror for prefill lives in `frontend/src/lib/rules.ts` (tested in vitest).
- `engine/suggestions.ts` — recurring-pattern detection (`detectSuggestions`): groups by (payeeId, accountId), scores regularity/amount/recency → proposed schedules.
- `engine/cashflow.ts` — cash-flow projection (`projectCashflow`): trailing averages + scheduled occurrences, hybrid per-category spending, projected RTA chain.
- `engine/autoAssign.ts` — quick-fund math (`autoAssignAmount` per category) + `planUnderfunded` (month-level underfunded fill, largest shortfall first, capped at RTA). Backs `POST /months/:month/quick-budget` (toolbar Auto-assign dropdown) and the assistant's `cover_overspending` tool via the shared `runQuickBudget()` in `routes/budget.ts`.
- `engine/anomalies.ts` — `detectAnomalies`: per-payee absolute z-score over past outflow sizes (posting-aware callers expand splits), flags spikes AND unusual drops (z ≥ 3, min €0.50 delta, ≥4 prior samples; zero-variance history → any ≥minDelta change flags). `recentFrom` limits what's *reported* while all history feeds stats. Backs `GET /reports/anomalies` (Reflect → Anomalies tab) and the assistant snapshot's "unusual charges" section.
- `engine/schedule.ts` — recurrence date math; `nextOccurrence(frequency, date, anchorDay?)` (anchorDay pins monthly day-of-month, avoiding 31st→28th drift) + `occurrencesInRange(...)` (forward expansion within [from,to], `endMonth`-bounded) used by the calendar and digest.
- `csvSniff.ts` — **generic CSV dialect sniffer** (pure, tested): delimiter, header row (multi-language keyword scoring), column roles (date/payee/amount or outflow+inflow/memo; positional fallback when headerless), date order (DMY/MDY/ISO), decimal separator; `parseCsvRows` normalizes to `{date, payee, amount(milli), memo}`. Backs `POST /import/auto` (preview+commit with UI-overrideable mapping) and the folder watcher. `importGeneric.ts` creates the transactions (rules + dedup `gen-csv:` importIds + inflow fallback).
- `watcher.ts` — poor man's bank sync: when `IMPORT_WATCH_DIR` is set, watches the folder for new `.csv` files, sniffs, dedups, imports into the account whose NAME the filename starts with (else `IMPORT_WATCH_ACCOUNT`); processed files move to `<dir>/imported/`, low-confidence/no-account to `<dir>/review/`.
- `digest.ts` — weekly budget digest: pure `buildDigest(data)` (RTA, overspent, underfunded targets, next-7-days schedules, 7-day anomalies, 3-month trend, net worth, AoM) → text+HTML; `sendDigestEmail` via AgentMail (`DIGEST_TO`/`SHOPPING_EMAIL_TO`) or SMTP; `startDigestScheduler()` sends Mondays 08:00 when `DIGEST_ENABLED=1`. Routes: `GET /digest/preview`, `POST /digest/send`.
- `engineLoad.ts` — the **only** bridge from DB → engine: loads a budget's rows, runs the engine, returns records + computation. Routes call this; they never reimplement math.

### Rules that must stay correct (verified against the reference export)

- **Money is integer milliunits everywhere** (1 unit = 1000). Floats only at parse/format edges (`money.ts`, frontend `format.ts`).
- **available = carryover + assigned + activity.** Positive carries forward; negative **cash** overspend resets to 0 and instead reduces **next month's** Ready-to-Assign; negative **credit** overspend (unfunded card spending) carries forward negative and never touches RTA. `carryForward()` in `budget.ts` implements both rules.
- **Credit cards:** funded spending on a `creditCard`/`lineOfCredit` on-budget account moves that money into the card's payment category (`Category.paymentAccountId` → the card, lives in the system "Credit Card Payments" group, auto-created with the account). Transfers into the card are payments and drain the payment category; overpaying it is cash overspend. All derived in `computeBudget()` pass 2 — nothing stored.
- **Ready to Assign = Σ income(≤month) − Σ assigned(≤month) − Σ cash-overspend(months < month).**
- **`asOf` cutoff:** transactions dated after `asOf` (default = today) are "upcoming" and excluded from activity/RTA until their date. This mirrors the reference app's behavior — pre-entered future subscriptions must not count yet. Account balances split them into `upcoming`.
- **Income** = inflows to the category with `isInflow = true` ("Inflow: Ready to Assign").

### How correctness is checked

Two independent validations, both must hold:
1. `npm run oracle` — runs `computeBudget()` on the export's transactions + assigned and asserts **every** `available` cell equals YNAB's own `Plan.tsv` `Available` column. Currently **594/594 (100%)**.
2. **Cash conservation** — Σ(category available) + Ready-to-Assign + outstanding credit overspend must equal Σ(on-budget **non-credit-card** account balances), to the cent, evaluated at the **last** month (future-month assigns skew mid-range checks) with everything categorized. With no card accounts the credit terms are 0 and this is the classic identity. This is what proves RTA correct (the oracle can't check RTA because `Plan.tsv` omits the Inflow row). Asserted in `budget.test.ts` (`assertConservation`).

If you change engine math, re-run both.

## Route-layer conventions

- **`routes/register.ts`** — transactions (incl. `POST /transactions/bulk`:
  category/flag/delete on many rows, transfers + split parents skipped for
  category changes, per-row undo ops), payees (manage counts, rename, merge —
  moves txns/subs/schedules then deletes the source; `mergePayees` undo op),
  scheduled transactions, payee rules, category drill-down
  (`GET /transactions?categoryId=&from=&to=&accountId=`, posting-aware),
  reconcile. `serializeTxn()` is the shared register-row serializer.
- **`routes/budget.ts`** — months, assign, auto-assign, move, categories/groups CRUD + `POST /months/:month/quick-budget` (toolbar Auto-assign dropdown; `runQuickBudget()` shared with the assistant's `cover_overspending` tool).
- **`routes/reports.ts`** — spending / income-expense / net-worth / age-of-money (all take `from`/`to`, spending also `accountId`) + cash-flow (`?months=1..36`, calls `materializeDue` first) + `GET /reports/anomalies?days=` + `GET /reports/networth-forecast?months=` (actual series + cashflow-pace dashed projection; `runProjection()` shared input assembly).
- **`routes/ops.ts` + `routes/ops-helpers.ts`** — the undo system. Every logged mutation wraps **mutation + prev-value reads + op insert + prune (200)** in ONE `prisma.$transaction` (`logOps(tx, ...)`); undo applies the inverse + deletes the op in one transaction. **Delta payloads** (`{categoryId, month, prev, next}`) so any undo order composes — never absolute restores. `createTransaction`/`resolvePayee`/`transferPayee` accept an optional `tx` client; anything called inside a transaction MUST use it (SQLite busy otherwise). 4xx errors use the `{ error: string }` JSON shape so the frontend `errMsg` parser surfaces them.
- **`routes/chat.ts`** — AI assistant backed by the **opencode-go gateway** (OpenAI-compatible
  `POST {CHAT_BASE_URL:-https://opencode.ai/zen/go/v1}/chat/completions`; key from `CHAT_API_KEY` /
  `CHAT_API_KEY_FILE` — same key-file pattern as AgentMail). `ChatSession`/`ChatMessage` are chat
  data → **hard-deleted** (messages cascade). Every turn injects a derived budget snapshot
  (`buildBudgetContext`: accounts, RTA, per-category assigned/activity/available, upcoming
  schedules, last 15 txns, top-5 anomalies) as the system prompt — never persisted. Default model
  `deepseek-v4-flash` (`CHAT_MODEL`; the user's "-0731" id isn't on the gateway). Upstream errors →
  502 `{ error }`, user message kept for retry. **Tool loop** (max 6 rounds): the model can call
  `get_rta` / `assign_money` / `move_money` / `cover_overspending` / `create_transaction` /
  `search_transactions` — every mutation runs through `logOps` so AI actions are undoable;
  `role:'tool'` messages are ephemeral (never persisted); a 400/404/422 with tools → one retry
  without tools (read-only fallback). Response carries `toolCalls:[{name,summary}]` for the UI
  chips; the frontend invalidates budget/month/txns/ops when non-empty. Sessions
  list/rename/delete; first exchange names the session. UI: `/assistant` (`AssistantView.tsx`,
  sidebar 🤖) with sessions rail, thread, optimistic user bubble, 🎙 dictation (Web Speech API,
  hidden when unsupported), delete-forever.
- **`routes/setup.ts`** — first-run wizard backend: `GET /setup/status` (hasBudget + chat config state,
  key only as last-4 tail), `POST /setup/budget` (creates the Budget with firstMonth = current month,
  **always** the structural Inflow category, optional starter groups/categories; 409 when a budget
  exists), `POST /setup/chat` (validates + `upsertEnv` writes CHAT_* into `backend/.env` — path from
  `new URL('../.env', import.meta.url)`, `SETUP_ENV_FILE` overrides for tests — AND sets
  `process.env` live, so no restart), `POST /setup/chat/test` (1-token probe against the provider,
  applies body overrides first). chat.ts reads base/model via `chatBaseUrl()`/`defaultModel()` at
  call time so live config changes take effect without restart. Frontend: `Welcome.tsx` wizard
  (App.tsx renders it whenever `['setup'].hasBudget === false` and gates the budget query on it —
  do NOT flip the setup cache mid-wizard, it unmounts the flow), provider form shared as
  `AssistantConfigForm.tsx` (also the ⚙ modal in AssistantView). Scratch-port E2E:
  `frontend/scripts/welcome-wizard-check.mjs` (VITE_API_TARGET/VITE_PORT proxy override).
- **`routes/debts.ts`** — DebtPlan CRUD + `POST /debt-plans/:id/payment-schedule` (memo marker `Piano ammortamento: <planId>` for idempotency / `hasPaymentSchedule`; `frequency: monthly|once`). Schedule inputs are stored, amortization is derived client-side (`frontend/src/payoff.ts`).
- **`routes/goals.ts`** — GoalPlan CRUD (mirror of DebtPlan: target/current,
  optional account + category link) + `POST /goal-plans/:id/contribution-schedule`
  (memo `Piano risparmio: <planId>`, monthly, categorized to the plan's funding
  category). Required-contribution math is client-side (`payoff.ts`).
- **`routes/shopping.ts` + `engine/groceries.ts`** — weekly grocery catalog:
  `POST /shopping/sync` (Aldi Nord parsed server-side from the angebote page's
  `__NEXT_DATA__` — incl. `imageUrl` from the `primary` asset; Lidl's flyer is
  raster images (no product data anywhere) and Netto is bot-protected → both
  use `POST /shopping/import-csv` `name;price;unit`), catalog search
  (`GET /shopping/catalog?q=&store=`), lists
  CRUD + item qty endpoints (price snapshots at add time; `store` snapshot for
  the email grouping), `POST /shopping/lists/:id/email` via **AgentMail**
  (`AGENTMAIL_API_KEY` or `AGENTMAIL_API_KEY_FILE` + `AGENTMAIL_INBOX`; key-file
  pattern shared with the desktop email agent) with direct SMTP fallback
  (`SMTP_HOST/...`, `SHOPPING_EMAIL_TO`); 409 with a friendly message when
  unconfigured. Parsers + email builder are pure (`engine/groceries.ts`,
  tested).
- **`routes/imports.ts`** — in-app file imports: `POST /import/csv` (BVR
  format) + `POST /import/tr-csv` (TR format) + `POST /import/auto`
  (sniffed dialect: `mode:'preview'` returns spec + first 10 normalized rows,
  `mode:'commit'` imports with UI-overrideable column mapping), sharing
  parsers/dedup with the CLI importers (`importBankCsv` /
  `importTradeRepublicCsv` in the script files — their `main()` runs only
  under is-main, never on import). Each import takes an automatic timestamped
  DB backup (`backend/src/backup.ts`, pruned to 30; also before `seed
  --force`) — no manual backup step anymore.
- **Register tooling** — `GET /transactions/duplicates` (same account/date/
  |amount|/payee groups), `GET /payees/similar` (`engine/similarity.ts`:
  levenshtein + containment), `POST /suggestions/dismiss` +
  `GET/DELETE /suggestions/dismissed` (persisted `SuggestionDismissal`),
  `POST /scheduled/:id/skip` (advance nextDate, never materializes), split
  transactions (`subtransactions` on POST/PATCH, validated sum, undo restores
  `prevSubs`). UI: Import CSV / Duplicates / Split toggle / Skip next /
  multi-select filters (URL-persisted) / one-click similar-merge.
- **Soft vs hard delete:** transactions/categories/groups are **soft** (`deleted` flag). `PayeeRule` and `DebtPlan` are **hard-deleted** (transactions store `categoryId`, not rule ids; plans are not financial data) — say so when touching them. `OpLog` uses an **autoincrement** id (stable order + one-query prune).

## Budget TSV import — YNAB export format (`importTsv.ts` + `tsvFormat.ts`)

The seed is a real export (`Register.tsv` + `Plan.tsv`), Italian/European format. Parsers handle: **UTF-8 BOM**, tab-delimited quoted fields, **€ comma-decimal** (`-€17,99`, `€1.208,00`), **DD/MM/YYYY** dates, `"Jul 2025"` month labels. Two non-obvious things the importer must do:

- **`Plan.tsv` omits "Inflow: Ready to Assign"** (you never assign to it). The importer also scans `Register.tsv` for categories, or income gets a null category and RTA breaks.
- **Account types aren't in the TSV.** Which accounts are tracking (off-budget)
  comes from `TRACKING_ACCOUNTS` (JSON, in `backend/.env`) — read via
  `DEFAULT_TRACKING` in `importTsv.ts`; never hardcode the author's accounts in
  the repo. The cash-conservation identity only reconciles with the right set.

`oracle.ts` reuses the same parsers but runs the engine in memory (no DB), so it's the fastest way to test engine changes against real numbers.

Incremental bank imports (`importCsv.ts`, `importTradeRepublic.ts`) **apply payee rules per row**: a matching rule beats the inflow fallback (`pickCategory(payeeName, rules, live, null) ?? inflow`), explicit categories from the TSV are never overridden.

## Frontend data flow

- Single budget assumed throughout (`getBudgetOrThrow()` → `findFirst`). Budget meta is fetched once in `App.tsx` and passed to routed views via React Router **Outlet context**. Views: `/` (Budget), `/accounts/:id` (register), `/reflect`, `/debts`, `/goals`, `/shopping`, `/subscriptions`, `/calendar`, `/assistant`.
- Server state via TanStack Query. Mutation refreshes invalidate `['month', m]` + `['budget']` (+ `['categories']`, `['txns', id]` where relevant) and — since logged ops exist — **`['ops']`** (three refresh sites: `BudgetView.refresh`, `Inspector.refresh`, `AccountView.invalidate`). Undo invalidates prefixes: `['ops']`, `['budget']`, `['month']`, `['categories']`, `['txns']`. Other keys: `['payee-rules']`, `['payees-manage']`, `['suggestions', accountId]`, `['debt-plans']`, `['goal-plans']`, `['drill', ...]`, `['rep', 'cashflow', n]`, `['calendar', m]`, `['rep', 'anomalies', days]`, `['rep', 'networth-forecast']`.
- Vite proxies `/api` → `:3001` (`vite.config.ts`); the API client uses relative `/api`.
- **Cmd+K palette** (`CommandPalette.tsx`, mounted in `App`): fuzzy-filtered navigation (views + accounts), all 4 themes, undo-last-change, send digest. `api.sendDigest` → `POST /digest/send`.
- **Pure logic lives in dedicated modules with vitest coverage**: `frontend/src/filters.ts` (register filters — multi-select, URL-persisted via `filtersToQuery`/`filtersFromQuery`), `csv.ts` (locale-aware CSV export + download), `lib/bva.ts` (Budget vs Actual rows/colors), `payoff.ts` (amortization + savings-rate math, shared by Debt plans and the Debt & Savings tab), `lib/dates.ts` (schedule occurrence preview, mirrors engine/schedule.ts). Keep new derived math there, tested, rather than inline in components.
- **Recharts gotcha:** `ResponsiveContainer` measures 0 width inside a CSS-grid cell, so the spending donut uses a fixed-size `PieChart` (see `ReflectView.tsx`). The block-context charts keep `ResponsiveContainer`. Print: charts are `print:hidden`; each view ships an always-mounted `hidden print:block` data table.
- `pills.tsx` owns the available/RTA colour rules; reuse it rather than re-deriving pill colours.
- The register header's `⋯` menu hosts Export CSV / Print / Import CSV / Possible duplicates / Payee Rules / Payees (rename & merge) / Schedule Suggestions; a floating `HistoryMenu` (top-right, below the header) hosts undo. The register rows carry checkboxes for multi-select bulk actions (category/flag/delete bar appears above the register).

## Scope

Core loop + targets + targets-aware quick budget (Auto-assign dropdown) + Reflect reports incl. Anomalies + net-worth forecast + credit-card engine + reconciliation + scheduled transactions + calendar view + move money / transfers / payee autocomplete / flags / category CRUD + register filters (multi-select, URL-persisted) + CSV/PDF export + bulk edit + payee rules + payee rename/merge + pattern suggestions (dismissible) + undo history + debt plans + goal plans + split-transaction editing + in-app CSV imports (auto-detect + auto-backed-up) + folder-watcher imports (`IMPORT_WATCH_DIR`) + weekly digest email (`DIGEST_ENABLED=1`) + AI assistant with undoable budget-mutating tools + Cmd+K palette + voice dictation. Still deferred: multi-budget, auth, bank sync (the watcher + auto-import stand in), filter URL presets.

`*`*.sqlite` and budget-app exports are gitignored — never commit the DB or financial data. Backups live in `backups/` (daily via `start.command`, automatic before imports/`seed --force` via `backend/src/backup.ts`, manual before schema changes).
