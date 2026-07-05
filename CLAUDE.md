# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A faithful local replica of YNAB (nYNAB): same UI/UX, same budgeting engine. Single user, no auth. Seeded from a real YNAB TSV export.

## Commands

```bash
# one-click launch (installs deps + seeds on first run, starts both, opens browser)
./start.command

# backend (cwd: backend/) — Fastify + Prisma + SQLite on :3001
npm run dev          # tsx watch src/server.ts
npm test             # engine self-tests (assert-based, no framework)
npm run oracle       # validate engine vs the real YNAB export's Plan.tsv (expect 100%)
npm run db:push      # create/sync SQLite schema (no migrations)
npm run seed         # WIPE all budgets + re-import the export (idempotent)
npm run import "/path/to/export dir"   # import a specific export
npx tsc --noEmit -p .                  # typecheck

# frontend (cwd: frontend/) — React + Vite + Tailwind v4 on :5173
npm run dev
npx tsc --noEmit -p tsconfig.app.json  # typecheck
```

There is no single-test runner — `npm test` runs `src/engine/budget.test.ts` as one script (plain `node:assert`). Add cases there.

## The engine is the whole point

All budgeting logic lives in **`backend/src/engine/`** as **pure functions** operating on plain objects (decoupled from Prisma so they're testable and runnable against raw TSV). The database stores only **inputs** — transactions and per-month `assigned` amounts. Everything else (`activity`, `available`, Ready-to-Assign, age of money, target state) is **derived on read**, never stored. Do not add denormalized balance columns; recompute instead.

- `engine/budget.ts` — `computeBudget()` is the core: per-(month,category) activity/available, carryover, Ready-to-Assign, cash-overspend. Also `accountBalances()`, month helpers.
- `engine/targets.ts`, `engine/ageOfMoney.ts`, `engine/autoAssign.ts` — the other derived pieces.
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

## YNAB TSV import (`importYnab.ts` + `ynabFormat.ts`)

The seed is a real export (`Register.tsv` + `Plan.tsv`), Italian/European format. Parsers handle: **UTF-8 BOM**, tab-delimited quoted fields, **€ comma-decimal** (`-€17,99`, `€1.208,00`), **DD/MM/YYYY** dates, `"Jul 2025"` month labels. Two non-obvious things the importer must do:

- **`Plan.tsv` omits "Inflow: Ready to Assign"** (you never assign to it). The importer also scans `Register.tsv` for categories, or income gets a null category and RTA breaks.
- **Account types aren't in the TSV.** Off-budget (tracking) accounts are listed in `DEFAULT_TRACKING` in `importYnab.ts`. Confirmed for this budget: `Rent` + `MainAccount` = `otherLiability` (debts), `TradeRepublic` = `otherAsset` (investments). The cash-conservation identity only reconciles with these off-budget.

`oracle.ts` reuses the same parsers but runs the engine in memory (no DB), so it's the fastest way to test engine changes against real numbers.

## Frontend data flow

- Single budget assumed throughout (`getBudgetOrThrow()` → `findFirst`). Budget meta is fetched once in `App.tsx` and passed to routed views via React Router **Outlet context**.
- Server state via TanStack Query. Mutations (assign, auto-assign, txn CRUD) return/invalidate `['month', m]` + `['budget']`; the backend returns the recomputed month payload so the table, RTA pill, and inspector update together — mirrors YNAB's instant recalc.
- Vite proxies `/api` → `:3001` (`vite.config.ts`); the API client uses relative `/api`.
- **Recharts gotcha:** `ResponsiveContainer` measures 0 width inside a CSS-grid cell, so the spending donut uses a fixed-size `PieChart` (see `ReflectView.tsx`). The block-context charts keep `ResponsiveContainer`.
- `pills.tsx` owns the YNAB available/RTA colour rules; reuse it rather than re-deriving pill colours.

## Scope

Core loop + targets + reports + credit-card engine + reconciliation (adjustment txns via `POST /accounts/:id/reconcile`; cash accounts categorize the adjustment to Inflow:RTA, cards/tracking leave it uncategorized) + scheduled transactions (`ScheduledTransaction` model, `engine/schedule.ts` date math, materialized on `GET /budget`, ghost rows in the register) + move money / transfers / payee autocomplete / flags / category CRUD in the UI. Still deferred: file-import UI, multi-budget, auth, bank sync, split-transaction editor.

`*.sqlite` and YNAB exports are gitignored — never commit the DB or financial data.
