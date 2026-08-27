# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A faithful local replica of YNAB (nYNAB): same UI/UX, same budgeting engine. Single user, no auth. Seeded from a real YNAB TSV export.

## Commands

```bash
# one-click launch (installs deps + seeds on first run, starts both, opens browser)
./start.command

# backend (cwd: backend/) — Fastify + Prisma + SQLite on :3001
npm run dev          # tsx watch src/server.ts
npm test             # ALL suites: engine/* + routes/{ops,tools,debts,bulk,payees,goals}.test.ts (assert-based, tsx, no framework)
npm run oracle       # validate engine vs the real YNAB export's Plan.tsv (expect 100%)
npm run db:push      # create/sync SQLite schema (no migrations)
npm run seed         # WIPE all budgets + re-import the export (idempotent)
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
with `app.inject()` against a **temp SQLite DB** (`/tmp/ynab-*-test-*.db` +
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
- `engineLoad.ts` — the **only** bridge from DB → engine: loads a budget's rows, runs the engine, returns records + computation. Routes call this; they never reimplement math.

### Rules that must stay correct (verified against real YNAB data)

- **Money is integer milliunits everywhere** (1 unit = 1000). Floats only at parse/format edges (`money.ts`, frontend `format.ts`).
- **available = carryover + assigned + activity.** Positive carries forward; negative **cash** overspend resets to 0 and instead reduces **next month's** Ready-to-Assign; negative **credit** overspend (unfunded card spending) carries forward negative and never touches RTA. `carryForward()` in `budget.ts` implements both rules.
- **Credit cards:** funded spending on a `creditCard`/`lineOfCredit` on-budget account moves that money into the card's payment category (`Category.paymentAccountId` → the card, lives in the system "Credit Card Payments" group, auto-created with the account). Transfers into the card are payments and drain the payment category; overpaying it is cash overspend. All derived in `computeBudget()` pass 2 — nothing stored.
- **Ready to Assign = Σ income(≤month) − Σ assigned(≤month) − Σ cash-overspend(months < month).**
- **`asOf` cutoff:** transactions dated after `asOf` (default = today) are "upcoming" and excluded from activity/RTA until their date. This is real YNAB behavior — pre-entered future subscriptions must not count yet. Account balances split them into `upcoming`.
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
- **`routes/budget.ts`** — months, assign, auto-assign, move, categories/groups CRUD.
- **`routes/reports.ts`** — spending / income-expense / net-worth / age-of-money (all take `from`/`to`, spending also `accountId`) + cash-flow (`?months=1..36`, calls `materializeDue` first).
- **`routes/ops.ts` + `routes/ops-helpers.ts`** — the undo system. Every logged mutation wraps **mutation + prev-value reads + op insert + prune (200)** in ONE `prisma.$transaction` (`logOps(tx, ...)`); undo applies the inverse + deletes the op in one transaction. **Delta payloads** (`{categoryId, month, prev, next}`) so any undo order composes — never absolute restores. `createTransaction`/`resolvePayee`/`transferPayee` accept an optional `tx` client; anything called inside a transaction MUST use it (SQLite busy otherwise). 4xx errors use the `{ error: string }` JSON shape so the frontend `errMsg` parser surfaces them.
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
  format) + `POST /import/tr-csv` (TR format), sharing parsers/dedup with the
  CLI importers (`importBankCsv` / `importTradeRepublicCsv` in the script
  files — their `main()` runs only under is-main, never on import). Each
  import takes an automatic timestamped DB backup (`backend/src/backup.ts`,
  pruned to 30; also before `seed --force`) — no manual backup step anymore.
- **Register tooling** — `GET /transactions/duplicates` (same account/date/
  |amount|/payee groups), `GET /payees/similar` (`engine/similarity.ts`:
  levenshtein + containment), `POST /suggestions/dismiss` +
  `GET/DELETE /suggestions/dismissed` (persisted `SuggestionDismissal`),
  `POST /scheduled/:id/skip` (advance nextDate, never materializes), split
  transactions (`subtransactions` on POST/PATCH, validated sum, undo restores
  `prevSubs`). UI: Import CSV / Duplicates / Split toggle / Skip next /
  multi-select filters (URL-persisted) / one-click similar-merge.
- **Soft vs hard delete:** transactions/categories/groups are **soft** (`deleted` flag). `PayeeRule` and `DebtPlan` are **hard-deleted** (transactions store `categoryId`, not rule ids; plans are not financial data) — say so when touching them. `OpLog` uses an **autoincrement** id (stable order + one-query prune).

## YNAB TSV import (`importYnab.ts` + `ynabFormat.ts`)

The seed is a real export (`Register.tsv` + `Plan.tsv`), Italian/European format. Parsers handle: **UTF-8 BOM**, tab-delimited quoted fields, **€ comma-decimal** (`-€17,99`, `€1.208,00`), **DD/MM/YYYY** dates, `"Jul 2025"` month labels. Two non-obvious things the importer must do:

- **`Plan.tsv` omits "Inflow: Ready to Assign"** (you never assign to it). The importer also scans `Register.tsv` for categories, or income gets a null category and RTA breaks.
- **Account types aren't in the TSV.** Off-budget (tracking) accounts are listed in `DEFAULT_TRACKING` in `importYnab.ts`. Confirmed for this budget: `Rent` + `MainAccount` = `otherLiability` (debts), `TradeRepublic` = `otherAsset` (investments). The cash-conservation identity only reconciles with these off-budget.

`oracle.ts` reuses the same parsers but runs the engine in memory (no DB), so it's the fastest way to test engine changes against real numbers.

Incremental bank imports (`importCsv.ts`, `importTradeRepublic.ts`) **apply payee rules per row**: a matching rule beats the inflow fallback (`pickCategory(payeeName, rules, live, null) ?? inflow`), explicit categories from the YNAB TSV are never overridden. See `docs/IMPORTING-AND-MERGING.md`.

## Frontend data flow

- Single budget assumed throughout (`getBudgetOrThrow()` → `findFirst`). Budget meta is fetched once in `App.tsx` and passed to routed views via React Router **Outlet context**. Views: `/` (Budget), `/accounts/:id` (register), `/reflect`, `/debts`, `/goals`, `/shopping`.
- Server state via TanStack Query. Mutation refreshes invalidate `['month', m]` + `['budget']` (+ `['categories']`, `['txns', id]` where relevant) and — since logged ops exist — **`['ops']`** (three refresh sites: `BudgetView.refresh`, `Inspector.refresh`, `AccountView.invalidate`). Undo invalidates prefixes: `['ops']`, `['budget']`, `['month']`, `['categories']`, `['txns']`. Other keys: `['payee-rules']`, `['payees-manage']`, `['suggestions', accountId]`, `['debt-plans']`, `['goal-plans']`, `['drill', ...]`, `['rep', 'cashflow', n]`.
- Vite proxies `/api` → `:3001` (`vite.config.ts`); the API client uses relative `/api`.
- **Pure logic lives in dedicated modules with vitest coverage**: `frontend/src/filters.ts` (register filters — multi-select, URL-persisted via `filtersToQuery`/`filtersFromQuery`), `csv.ts` (locale-aware CSV export + download), `lib/bva.ts` (Budget vs Actual rows/colors), `payoff.ts` (amortization + savings-rate math, shared by Debt plans and the Debt & Savings tab), `lib/dates.ts` (schedule occurrence preview, mirrors engine/schedule.ts). Keep new derived math there, tested, rather than inline in components.
- **Recharts gotcha:** `ResponsiveContainer` measures 0 width inside a CSS-grid cell, so the spending donut uses a fixed-size `PieChart` (see `ReflectView.tsx`). The block-context charts keep `ResponsiveContainer`. Print: charts are `print:hidden`; each view ships an always-mounted `hidden print:block` data table.
- `pills.tsx` owns the YNAB available/RTA colour rules; reuse it rather than re-deriving pill colours.
- The register header's `⋯` menu hosts Export CSV / Print / Import CSV / Possible duplicates / Payee Rules / Payees (rename & merge) / Schedule Suggestions; a floating `HistoryMenu` (top-right, below the header) hosts undo. The register rows carry checkboxes for multi-select bulk actions (category/flag/delete bar appears above the register).

## Scope

Core loop + targets + 7 Reflect reports + credit-card engine + reconciliation + scheduled transactions + move money / transfers / payee autocomplete / flags / category CRUD + register filters (multi-select, URL-persisted) + CSV/PDF export + bulk edit + payee rules + payee rename/merge + pattern suggestions (dismissible) + undo history + debt plans + goal plans + split-transaction editing + in-app CSV imports (auto-backed-up). Still deferred: multi-budget, auth, bank sync, filter URL presets, targets-aware auto-assign.

`*.sqlite` and YNAB exports are gitignored — never commit the DB or financial data. Backups live in `backups/` (daily via `start.command`, automatic before imports/`seed --force` via `backend/src/backup.ts`, manual before schema changes).
