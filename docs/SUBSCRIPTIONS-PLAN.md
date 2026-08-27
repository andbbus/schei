# Plan: Subscriptions management section

**Goal:** a "Subscriptions" view to manage recurring fees — payee, category, frequency,
start month, end month, amount. Built ON the existing ScheduledTransaction engine (which
already materializes into the register and feeds Cash Flow), extended with optional
`startMonth` + `endMonth`. The user's existing recurring schedules (Claude, Spotify,
OpenCode, …) appear here automatically.

## Design (as presented)
- New sidebar item **Subscriptions** → route `/subscriptions`, a management table over
  scheduled transactions: `Payee | Category | Amount | Frequency | Started | Until | Next charge | actions`.
- "+ Add subscription" modal: payee autocomplete, category select, fee amount, frequency,
  start month, end month (optional → ongoing). Creating/editing maps to ScheduledTransaction.
- Subscriptions stay consistent everywhere: register ghost rows, Budget forecast panel
  known transactions, Reflect Cash Flow (all read the schedule engine).

## Resumable task list

### Phase 1 — Backend
- [x] `schema.prisma`: add `startMonth String?` + `endMonth String?` to `ScheduledTransaction`;
      `npx prisma db push`.
- [x] `register.ts`:
      - `materializeDue`: stop creating occurrences once `monthOf(date) > endMonth` → mark deleted.
        (import `monthOf` from `../engine/budget`).
      - `POST /scheduled`: accept `startMonth`/`endMonth`; if no `nextDate`, derive
        `nextDate = max("${startMonth}-01", today)` and `anchorDay = 1` for monthly.
      - `PATCH /scheduled/:id`: accept `startMonth`/`endMonth`.
      - `GET /scheduled`: list non-deleted schedules with payee/category names
        `{id, payeeId, payee, categoryId, category, amount, frequency, nextDate, anchorDay, startMonth, endMonth, memo}`.
- [x] `cashflow.ts` + `expected.ts`: `ScheduledLike` gains `endMonth`; occurrence walk breaks
      when `monthOf(n) > endMonth`; bucket skips occurrences beyond `endMonth`.
- [x] `reports.ts`: nothing extra (schedules already loaded) — but pass `endMonth` in the
      `ScheduledLike` mapping in the cashflow call.
- [x] Tests: extend `tools.test.ts` (has scheduled setup) — create schedule with endMonth,
      materialize past end → schedule deleted; GET /scheduled returns names; POST derives nextDate
      from startMonth. Add `endMonth` to `cashflow.test.ts` sched fixture + a walk-stops assertion.

### Phase 2 — Frontend
- [x] `api.ts`: `ScheduledRow` type + `scheduledList()`. Extend `createScheduled`/`updateScheduled`
      bodies with `startMonth`/`endMonth` (already generic `Record<string, unknown>`).
- [x] `SubscriptionsView.tsx` (new): table card + add/edit modal + skip/delete. Use the
      redesign tokens (card, tnum, inputs, buttons). Frequencies labelled
      (once/weekly/every-2-wks/monthly/yearly).
- [x] `main.tsx`: add route `subscriptions` → `SubscriptionsView`.
- [x] `Sidebar.tsx`: add nav item `Subscriptions` (icon `🔁`).

### Phase 3 — verify
- [x] `cd backend && npm test`.
- [x] `cd frontend && npm run build && npm test && npm run lint`.
- [x] Live smoke: list shows real subscriptions (Claude, OpenCode, …); add one with an end date;
      edit amount; skip next; delete; a past-end subscription stops materializing.

### Phase 4 — link subscriptions to budgeted money (2026-08-22)
- [x] `SubscriptionsView.tsx`: fetch `api.month(meta.currentMonth)`, build `categoryId → assigned` map.
- [x] Add a **Budgeted** column: the category's assigned amount this month, colored by coverage
      (`emerald` if budgeted ≥ fee, `amber` if 0 < budgeted < fee, `red` if nothing assigned), with a
      small `Covered / Partial / Unfunded` pill. No category → `—`.
- [x] Grid grows to 9 columns; rows two-line for the budgeted cell.
- [x] Ready-to-Assign (inflow) subscriptions are exempt from the coverage badge — income is not a
      budgeted spending category (user feedback).

### Phase 5 — category filter + summary footer (2026-08-22)
- [x] `SubscriptionsView.tsx`: category multi-filter (toggle chips for distinct categories; empty = all).
- [x] `visible` rows = subscriptions matching the filter; summary footer recomputes on the visible set:
      count (N / M), **Fees/Income/Net per month, Fees/year, One-off, and Budgeted (all frequency-normalized via `monthlyEq`:
      monthly×1, weekly×52/12, everyOtherWeek×26/12, yearly/12, once=0), and **Budgeted** total.
- [x] Sticky footer row (`bg-slate-50`) below the rows inside the card.

## Gotchas
- Money = signed milliunits; a fee is negative (`−parseAmount`).
- `endMonth` is inclusive: occurrences with `monthOf(date) > endMonth` stop.
- `nextDate` derives from `startMonth` only for NEW schedules; existing ones keep theirs.
- The schedule walk lives in THREE places (register.ts materialize, cashflow.ts, expected.ts) — keep all in sync.
- **Derived first charge is never "now"** (2026-08-27): creating a subscription mid-month with
  `startMonth` = current month used to derive `nextDate = today` and `materializeDue` spawned a
  real charge immediately — the budget demanded the money and deleting the subscription left the
  orphan behind. Now derived dates land strictly after today; explicit `nextDate` may still
  backfill past charges deliberately.
- **Spawn marker**: auto-materialized transactions carry `importId = sched:<scheduleId>:<date>`
  (distinct from the `bvr-csv:`/`tr-csv:` bank prefixes). `DELETE /scheduled/:id` soft-deletes
  marked spawns dated ≥ today (today's = phantom; history stays) plus their transfer legs, and
  returns `removedUpcoming` for the UI notice.
- Pre-marker orphans (created before 2026-08-27) aren't auto-detectable — remove them by hand in
  the register (dated today, the subscription's payee, category untouched).

## Files touched (expected)
- `backend/prisma/schema.prisma`
- `backend/src/routes/register.ts`
- `backend/src/engine/cashflow.ts`
- `backend/src/routes/expected.ts`
- `backend/src/routes/reports.ts`
- `backend/src/routes/tools.test.ts`
- `backend/src/engine/cashflow.test.ts`
- `frontend/src/api.ts`
- `frontend/src/components/SubscriptionsView.tsx` (new)
- `frontend/src/main.tsx`
- `frontend/src/components/Sidebar.tsx`