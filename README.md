# ynab-clone

A faithful replica of [YNAB](https://www.ynab.com/) (nYNAB): same UI/UX and the same
budgeting engine. Single-user, local. Seeded from a real YNAB TSV export.

- **Frontend:** React + TypeScript + Vite + Tailwind v4 (`frontend/`)
- **Backend:** Fastify + Prisma + SQLite, REST API shaped like YNAB's own (`backend/`)
- **Money:** integer **milliunits** (1 unit = 1000), no floats — exactly like YNAB.

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
from activity until their date, Age of Money, targets (Monthly / Needed / Have-a-balance
/ By-date), auto-assign, reconciliation with balance adjustments, scheduled/recurring
transactions, tracking (off-budget) accounts.

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

### Other commands (backend)

| command | what |
|---|---|
| `npm test` | engine self-tests (assert-based, no framework) |
| `npm run oracle` | validate engine vs the YNAB export's `Plan.tsv` |
| `npm run seed` | wipe + re-import the export (idempotent) |
| `npm run import "/path/to/export dir"` | import a specific export |

The export location defaults to the one in `backend/src/seed.ts`; override with the
`YNAB_EXPORT_DIR` env var or by passing a path to `npm run import`.

## Account on/off-budget

The TSV export does not carry account types, so tracking (off-budget) accounts are
listed in `DEFAULT_TRACKING` in `backend/src/importYnab.ts`. Edit that map (or set the
type via the UI) if a classification is wrong.

## Scope

**Included:** accounts (incl. credit cards with payment categories), register
(inflow/outflow/transfer/cleared, running balance, search, flags, payee autocomplete),
category groups/categories CRUD, assign + Ready-to-Assign, available carryover,
credit-card overspend rules, month navigation, inspector, targets, auto-assign,
move money, reconciliation with balance adjustments, scheduled/recurring
transactions, the four Reflect reports.

**Deferred:** file import UI, split-transaction editor, multi-budget, auth /
multi-device, bank sync.
