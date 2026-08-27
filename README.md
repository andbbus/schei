# ynab-clone

A faithful replica of [YNAB](https://www.ynab.com/) (nYNAB): same UI/UX and the same
budgeting engine. Single-user, local. Seeded from a real YNAB TSV export.

- **Frontend:** React + TypeScript + Vite + Tailwind v4 (`frontend/`)
- **Backend:** Fastify + Prisma + SQLite, REST API shaped like YNAB's own (`backend/`)
- **Money:** integer **milliunits** (1 unit = 1000), no floats — exactly like YNAB.

## Features

**Budget** — category groups/categories CRUD (rename, hide, delete), per-month
assign + Ready-to-Assign, available carryover (cash overspend → next month's
RTA; credit overspend carries negative without touching RTA), targets
(Monthly / Needed / Have-a-balance / By-date), 7 auto-assign modes, move money,
inspector with notes, month navigation.

**Register** — inflow/outflow/transfer/cleared, running balance, flags, payee
autocomplete, reconciliation with balance adjustments, scheduled/recurring
transactions (ghost rows, materialized when due), **full filter bar** (text,
date range, category, payee, amount min/max, cleared state, flag), **bulk
edit** (multi-select rows → reassign category/flag, delete — undoable), **CSV
export** (locale-aware `;`/`,` delimiters, BOM) and **Print / Save-as-PDF**
(print tables).

**Shopping** — weekly supermarket offers with product thumbnails (Aldi Nord
synced automatically from the angebote page — 234 products/week incl. images;
Lidl's flyer is image-only and Netto is bot-protected, so import their weekly
offers as CSV), catalog search, shopping lists with live cost estimates
(price snapshots per item, quantity steppers, per-store totals) and emailing
the list via SMTP (config in `backend/.env`). **Planned:** switch email
delivery to **Agent Mail** (alternative to direct SMTP) — see
`docs/IMPLEMENTATION-PLAN.md`.  

**Reflect** — 7 tabs: Spending (donut + breakdown, account filter, click a
category for its transactions), Net Worth, Income v Expense, Age of Money,
**Budget vs Actual** (per-category assigned vs spent with utilization),
**Cash Flow** (projected RTA from known schedules + trailing averages),
**Debt & Savings** (money-weighted savings rate + loan payoff simulator).

**Automation & safety** — **payee rules** (auto-categorize on entry and on
import; apply to existing transactions), **payee management** (rename or merge
payees to repair history — merge is undoable), **recurring-pattern
suggestions** (detects monthly/weekly/biannual subscriptions and proposes
schedules), **undo history** (one-click undo of assigns, moves, transactions,
reconciles, deletes, merges — delta-based, composes in any order), **Debt
plans** (persisted amortization plans with balance sync from tracking accounts
and one-click payment schedules), **Goal plans** (savings targets with progress
sync, required-contribution math and contribution schedules — both feed the
Cash Flow projection).

## Engine fidelity

The budget engine is validated two independent ways against a real export:

1. **Oracle** (`npm run oracle`): runs the engine on the export's transactions + assigned
   amounts and compares **every** `Available` cell to YNAB's own `Plan.tsv` →
   **594/594 cells match (100%)** across 22 months / 407 transactions.
2. **Cash conservation:** Σ(category available) + Ready-to-Assign = Σ(on-budget account
   balances), to the cent — which proves Ready-to-Assign is correct too.

Key behaviours replicated: per-month/per-category available with positive carryover,
cash overspend → next-month Ready-to-Assign (no negative carry), credit-card handling
(funded card spending fills the card's payment category, unfunded card spending carries
forward negative without touching RTA), future-dated ("upcoming") transactions excluded
from activity until their date, Age of Money, targets, auto-assign, reconciliation with
balance adjustments, scheduled/recurring transactions, tracking (off-budget) accounts.

## Run it

**One click:** double-click **`start.command`** in Finder. First run installs deps + seeds
the DB, then starts both servers and opens the browser. Ctrl-C (or close the window) stops it.

Or manually, two terminals:

```bash
# 1. backend  (http://localhost:3001)
cd backend
npm install
npm run db:push      # create the SQLite schema (first time only)
npm run seed         # import the YNAB export → ./prisma/dev.db
npm run dev

# 2. frontend (http://localhost:5173)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

### Commands

| command | what |
|---|---|
| `backend npm test` | all backend test suites (engine + routes, assert-based) |
| `frontend npm test` | frontend unit tests (vitest: filters, csv, bva, payoff) |
| `backend npm run oracle` | validate engine vs the YNAB export's `Plan.tsv` |
| `backend npm run seed` | wipe + re-import the export (idempotent) |
| `backend npm run import "/path/to/export dir"` | import a specific YNAB export |
| `backend npx tsx src/importCsv.ts "<file>" BVR` | merge an MainBank/BVR bank CSV |
| `backend npx tsx src/importTradeRepublic.ts "<file>"` | merge a TR statement CSV |
| `frontend npm run build` | typecheck (`tsc -b`) + production build |

More on importing and merging: [`docs/IMPORTING-AND-MERGING.md`](docs/IMPORTING-AND-MERGING.md).
The feature-batch plan (and the debt-plans follow-up) is archived in
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md).

## Account on/off-budget

The TSV export does not carry account types, so tracking (off-budget) accounts are
listed in `DEFAULT_TRACKING` in `backend/src/importYnab.ts`. Edit that map (or set the
type via the UI) if a classification is wrong.

## Scope

**Included:** accounts (incl. credit cards with payment categories), register
(filters, flags, payee autocomplete, CSV/PDF export), categories CRUD, assign +
Ready-to-Assign, targets, auto-assign, move money, reconciliation, schedules,
payee rules, pattern suggestions, undo history, the seven Reflect reports,
debt plans.

**Deferred:** file-import UI, split-transaction editor, multi-budget, auth /
multi-device, bank sync.
