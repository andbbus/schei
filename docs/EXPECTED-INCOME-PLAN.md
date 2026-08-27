# Plan: Future-income visibility (Budget screen)

**Goal:** make future incomes visible and countable in the app without leaving the
Budget screen. Two features:

1. **Expected-income strip** on the Budget screen — under the Ready-to-Assign strip,
   list *known* future inflows (scheduled + upcoming) for the coming months, so the
   user sees what is coming in while assigning.
2. **Future-month preview** — when viewing a *future* month in the Budget, show the
   scheduled/upcoming transactions that will hit that month.

Status of this document: it is the canonical resumable task list. If work is
interrupted/crashes, pick up from the next unchecked `[ ]` step and re-read the
referenced files.

---

## Resumable task list

### Phase 0 — Context (already done, re-read on resume)
- [x] Read `backend/src/routes/register.ts` (scheduled serialization at ~line 790),
      `backend/src/routes/reports.ts` + `backend/src/engine/cashflow.ts` (how
      "known schedules" and "upcoming" are computed today), `frontend/src/api.ts`,
      `frontend/src/components/BudgetView.tsx`.
- [x] Confirmed helpers: `addMonths|listMonths|monthOf` in `engine/budget.ts`;
      `nextOccurrence(frequency, date, anchorDay?)` in `engine/schedule.ts`;
      `today()` from `engineLoad`. Server route registration in `backend/src/server.ts`.

### Phase 1 — Backend: `GET /api/expected` endpoint
- [x] Create `backend/src/routes/expected.ts` (Fastify plugin, `prefix` handled at register).
- [x] `GET /api/expected` with query `months` (int, default 6, clamp 1..36 — mirror
      cashflow validation). Compute:
      - `currentMonth = monthOf(today())`, `horizonEnd = addMonths(currentMonth, months)`,
        window = `listMonths(currentMonth, horizonEnd)`.
      - Load: `budget = getBudgetOrThrow()`; `scheduledTransaction` (deleted:false,
        include `payee`); `account` (id+onBudget) to skip internal transfers; real
        `transaction` rows with `date > today()` (upcoming), include `payee`;
        budget categories (id+name+isInflow) for names — note: ScheduledTransaction
        has NO `category` relation, resolve via the category map.
      - **Scheduled:** for each schedule, skip internal transfers
        (`transferAccountId` set AND target account `onBudget`). Walk occurrences
        starting from `nextDate` if `> today` else from `today`; `nextOccurrence`
        loop up to 120 iterations, break when `> horizonEnd` or null. Bucket each
        occurrence into its month.
      - **Upcoming:** each real txn with `date > today` and `monthOf(date) <=
        horizonEnd`; skip internal transfers the same way.
      - **Income flag:** income = `amount > 0` (frontend strips by this). Inflow
        category is authoritative where set; amount sign covers the rest.
      - Response shape:
        ```ts
        {
          months: {
            month: string;               // "YYYY-MM-01"
            items: {
              date: string; payee: string; category: string | null;
              categoryId: string | null; amount: number /* signed milliunits */;
              source: 'scheduled' | 'upcoming'; frequency: string | null;
            }[];
            net: number;                 // sum of item amounts
          }[];
        }
        ```
      - Sort each month's items by date. Empty months still included.
- [x] Register in `server.ts`: `import expectedRoutes from './routes/expected'` +
      `await app.register(expectedRoutes, { prefix: '/api' })`.
- [x] Add `backend/src/routes/expected.test.ts` (temp SQLite, Fastify instance,
      prefix `/api`, mirror `tools.test.ts`): cover
      - scheduled one-off inflow in a future month appears with right month+amount;
      - recurring monthly schedule generates occurrences across months;
      - real future-dated (upcoming) inflow appears as `source:'upcoming'`;
      - internal on-budget transfer is skipped; tracking-account transfer kept;
      - `months` clamp (400 → 400).
- [x] Wire test into `backend/package.json` test script (append
      `&& tsx src/routes/expected.test.ts`).

### Phase 2 — Frontend: api layer
- [x] `frontend/src/api.ts`: add `ExpectedItem`/`ExpectedMonth`/`ExpectedData` types
      (mirror above) and `expected: (months: number) => get<ExpectedData>(`/expected?months=${months}`)`.

### Phase 3 — Frontend: expected-income strip (BudgetView)
- [x] Implemented: `useQuery(['expected'], () => api.expected(24))`, chip strip under RTA.
- [x] **REVERTED on user review (2026-08-22):** the expected-income strip was removed —
      user found it "not nice". The `expected` query stays (the Known Transactions
      preview consumes it). Removed `incoming` derivation + strip JSX + `shortMonth`
      import. Decision recorded: strip is NOT to be re-added.

### Phase 4 — Frontend: future-month preview (BudgetView)
- [x] `const isFuture = month > meta.currentMonth` (string compare works on ISO
      `YYYY-MM-01`).
- [x] When `isFuture`, look up the selected month in the same `expected` query data
      (`data.months.find(m => m.month === month)`).
- [x] Render a card above the budget table (inside the same padded container):
      title `Known transactions in <monthLabel>`; rows
      `date · payee · category · +/−amount`; footer `Net +€X`. Uses design card
      classes (`rounded-[10px] border bg-white shadow`, `text-[13px]`, `tnum`).
      Show "(none)" state when the month has no items.
- [x] KEPT — this is the feature the user wants to keep.

### Phase 5 — Verify
- [x] `cd backend && npm test` (all suites incl. new expected.test.ts).
- [x] `cd frontend && npm run build && npm test && npm run lint`.
- [x] Manual smoke via headless Chrome (pattern already used):
      `chrome --headless=new --remote-debugging-port=9222 http://localhost:5173/`
      + CDP evaluate to confirm the strip renders and a future month's preview shows
      the December grant item. Verified: strip shows `Dec '26 · Income · +€1.208,00`;
      December 2026 preview lists Claude Code, Student loan −€2.995 (once),
      MainBank, Charity, OpenCode, Univ. Frankfurt, and the grant +€1.208
      (upcoming); net −€1.833,90. (Both dev servers must be running.)

---

## Reference notes / gotchas (read before resuming)
- **Money is milliunits** (1 unit = 1000); amounts in the API are signed integer milliunits.
- **`today()`** must come from `engineLoad`, not a raw `new Date()`, to keep tests deterministic.
- **Internal transfers** (transferAccountId → on-budget account) are NOT cash flow —
  skip them exactly like `cashflow.ts:158`. Transfers to tracking accounts ARE outflows.
- The schedule walk must start at `nextDate` when it is `> today`, otherwise roll
  forward from `today` (see `cashflow.ts:164-173`).
- The register already renders scheduled ghost rows + upcoming (italic) rows
  (`AccountView.tsx`); this feature does not change the register — only BudgetView.
- After touching any query key the app refetches via React Query invalidation; no
  cache wiring needed beyond `useQuery`.

## Files touched (expected)
- `backend/src/routes/expected.ts` (new)
- `backend/src/routes/expected.test.ts` (new)
- `backend/src/server.ts`
- `backend/package.json`
- `frontend/src/api.ts`
- `frontend/src/components/BudgetView.tsx`