# Schei

*Schei* (dialect for "money") — a local-first envelope-budgeting app in the
spirit of YNAB: month-by-month assigning, Ready to Assign, cash/credit
overspend handling — plus an AI assistant, reports, a calendar and import
automation. Single-user, **all local**, no cloud, no subscription.

- **Frontend:** React + TypeScript + Vite + Tailwind v4 (`frontend/`)
- **Backend:** Fastify + Prisma + SQLite, REST API (`backend/`)
- **Money:** integer **milliunits** (1 unit = 1000), no floats

## Quick start

Prerequisite: [Node.js 20+](https://nodejs.org).

```bash
git clone https://github.com/andbbus/schei.git
cd schei
npm run setup     # installs backend + frontend deps, creates the SQLite DB
npm start         # starts both servers and opens http://localhost:5173
```

**First launch opens a welcome wizard** that walks you through:

1. **Create your budget** — name, currency, number format, optional starter
   categories (Bills / Everyday / Fun / Savings — rename or delete later).
2. **Add your first account** — its current balance becomes **Ready to
   Assign**, the money waiting for a job.
3. **Set up the AI assistant** *(optional)* — pick a provider, paste an API
   key, hit *Test connection*. Any OpenAI-compatible provider works
   (OpenCode Zen, OpenAI, OpenRouter, Groq, a local Ollama, …). The key is
   stored locally in `backend/.env` and never leaves your machine except to
   call the provider you chose.

Stop with `Ctrl-C`.

**Setup also adds a "Schei" icon to your Desktop** (a real `.app` on
macOS, a shortcut on Windows/Linux, with the app's piggy-bank icon from
`assets/`). Double-click it to start everything; drag it to your Dock
(macOS), taskbar (Windows) or app menu (Linux) to pin it. Missing or moved the
repo? Recreate it anytime with `npm run icon`.

> Migrating from YNAB (or another budgeting app)? You can import your real
> budget instead of the wizard — see [Importing](#importing) below.

## What's inside

**Budget** — per-month assign + Ready to Assign, available carryover with
strict cash/credit overspend rules, credit-card payment categories,
targets (monthly / needed-by / balance / by-date), **Auto-assign** dropdown
(underfunded capped at RTA, average spent, …), move money, undo history.

**Register** — inflow/outflow/transfer/cleared, running balance, flags, payee
autocomplete, reconciliation, scheduled/recurring transactions, full filter
bar, bulk edit, CSV export, print/PDF.

**Reflect** — Spending, Net Worth (with a 12-month projection line), Income v
Expense, Age of Money, Budget vs Actual, Cash Flow projection, Debt &
Savings, **Anomalies** (flags charges that deviate sharply from the same
payee's history — price hikes, double charges, unusual drops).

**Calendar** — month grid of everything happening per day: scheduled
occurrences and real transactions; add, edit and delete transactions right
from the day rail.

**AI assistant** — chats about *your* budget (ready to assign, category
state, upcoming bills, unusual charges) and can **act** on it: assign or move
money, cover overspending, create transactions — every AI action is logged
and undoable from the History menu. Voice dictation included (Chrome).
Sessions persist locally.

**Automation** — payee rules (auto-categorize + rename + notes, applied on
entry, on import and retroactively), payee rename/merge, recurring-pattern
suggestions, duplicates finder, debt & goal plans, CSV auto-import with
dialect sniffing (any bank), shopping lists with email, weekly digest email,
Cmd+K command palette, 4 themes.

## The AI assistant

Configure it in the first-run wizard or later from the **Assistant page → ⚙**.

| Provider | Base URL (pre-filled) | Needs |
|---|---|---|
| OpenCode Zen *(default)* | `https://opencode.ai/zen/go/v1` | an opencode key |
| OpenAI | `https://api.openai.com/v1` | `sk-…` key |
| OpenRouter | `https://openrouter.ai/api/v1` | `sk-or-…` key |
| Groq | `https://api.groq.com/openai/v1` | `gsk_…` key |
| Ollama (local) | `http://localhost:11434/v1` | nothing — install [Ollama](https://ollama.com) and `ollama pull llama3.1` |

Model and key land in `backend/.env` (`CHAT_BASE_URL`, `CHAT_MODEL`,
`CHAT_API_KEY`) — the same place the rest of the optional config lives (see
[`backend/.env.example`](backend/.env.example)).

## Optional automations

All configured in `backend/.env` (restart the backend after editing):

- **Folder watcher** — `IMPORT_WATCH_DIR=/path/to/csv/inbox`: drop a bank CSV
  in the folder and it's sniffed, deduped and imported automatically. The
  filename must start with the account name (e.g. `Account_2026-08.csv`).
  Processed files move to `imported/`, dubious ones to `review/`.
- **Weekly digest** — `DIGEST_ENABLED=1` + `DIGEST_TO=you@example.com`: an
  email every Monday 08:00 with Ready to Assign, overspent/underfunded
  categories, the next 7 days of bills, unusual charges and a 3-month trend.
- **Shopping email / digest delivery** — AgentMail (`AGENTMAIL_API_KEY`) or
  plain SMTP (`SMTP_HOST`, …).

## Importing

Coming from real YNAB? Export your budget
([File → Export](https://support.ynab.com/en/us/ynab-export-a-guide)) and:

```bash
cd backend
npm run db:push
npm run import "/path/to/your-export-folder"   # Register.tsv + Plan.tsv
npm run dev
```

The engine is validated against a real export two ways: an **oracle** that
compares every `Available` cell to YNAB's own `Plan.tsv` (**594/594 — 100%**)
and a **cash-conservation identity** (Σ categories + RTA = Σ on-budget
balances, to the cent).

Bank CSVs merge in-app from any account page (⋯ menu → Import CSV): the BVR
and Trade Republic formats are built-in, anything else goes through
**auto-detect** (delimiter, header, columns, date format and decimal
separator are sniffed; you can override the mapping before importing).
Duplicates are skipped, payee rules apply.

More: [`docs/IMPORTING-AND-MERGING.md`](docs/IMPORTING-AND-MERGING.md).

## Development

| command | what |
|---|---|
| `npm test --prefix backend` | all backend suites (engine + routes, ~25 files) |
| `npm test --prefix frontend` | frontend unit tests (vitest) |
| `npm run dev` (in `backend/` / `frontend/`) | the two servers individually |
| `npm run build --prefix frontend` | typecheck + production build |

The engine lives in `backend/src/engine/` as pure functions; the database
stores only inputs (transactions + monthly assigned) — everything else is
derived on read. See [`CLAUDE.md`](CLAUDE.md) for the architecture tour.

## Troubleshooting

- **`Environment variable not found: DATABASE_URL`** — a fresh clone has no
  `backend/.env` (it's gitignored because it holds API keys). Fixed in the
  current version: every npm script that needs it seeds `.env` from
  `.env.example` first (`backend/scripts/ensure-env.mjs`). If you're on an
  older checkout, run `cp backend/.env.example backend/.env`.
- **npm warns about install scripts** (`allowScripts`, npm ≥ 11.16) — the
  repo ships an `allowScripts` allowlist in both `package.json`s covering
  Prisma, esbuild and fsevents, so this is informational only. If npm ever
  blocks a script on a future major, run `npm install-scripts approve --all`
  after reviewing.
- **Windows: `spawn EINVAL` on `npm start`** — fixed in the current version
  (Node refuses to launch `npm.cmd` without a shell). Update with
  `git pull`; no local action needed.
- **`npm audit` shows high-severity findings** — run `npm audit fix` inside
  `backend/` and `frontend/`; current versions install clean (0 findings).
  (The backend pins `deepmerge-ts` via an `overrides` field because its
  vulnerable version comes in through Prisma's own dependency.)

## Privacy

Your budget stays in a local SQLite file (`backend/prisma/dev.db`). The only
outbound calls are the ones you configure: the AI provider you choose, the
email delivery you set up, and the supermarket flyer sync. Backups land in
`backups/`.
