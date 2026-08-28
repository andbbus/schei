# Implementation Plan — Schei Feature Batch (H1–H5, M6–M9)

Finalized after two rounds of adversarial review (9 reviewer agents, one per feature,
round-2 confirmations folded in). Implementation order below; each feature is a
complete, verified slice. Money is integer milliunits everywhere.

---

## Phase 0 — Foundations

1. Manual DB backup before schema changes: copy `backend/prisma/dev.db` → `backups/`.
2. One `prisma db push` adding three schema pieces (no destructive changes):
   - `PayeeRule { id cuid, budgetId, pattern String, categoryId String, createdAt }`
     with `@@unique([budgetId, pattern])`, `@@index([budgetId])`, relations on
     Budget and Category. Pattern is stored normalized (trim, collapse whitespace,
     lowercase; `=` prefix = exact match). Rules are hard-deleted (no soft delete).
   - `OpLog { id Int @id @default(autoincrement()), budgetId, kind String,
     payload String (JSON), createdAt }` with `@@index([budgetId, id])`, cascade.
   - `ScheduledTransaction.anchorDay Int?` (persists the monthly anchor day so
     schedules don't drift after materialization; null = current behavior).
3. Frontend test infra: add `vitest` devDependency + `"test": "vitest run"` script.
   Test files import `describe/it/expect` explicitly from `'vitest'` (no globals).
   Add `"exclude": ["src/**/*.test.ts"]` to `tsconfig.app.json` so tests never ship
   through `tsc -b`.
4. Backend test wiring: `"test"` becomes
   `tsx src/engine/budget.test.ts && tsx src/engine/suggestions.test.ts && tsx src/routes/ops.test.ts`
   (tsx executes only the first file per invocation).
5. Refactors that unblock multiple features:
   - Extract `serializeTxn(...)` from `GET /accounts/:id/transactions` (register.ts)
     for reuse by the H4 drill-down route.
   - Shared posting predicate in the engine (mirrors `collectPostings`: on-budget
     only, sub-postings authoritative, future-dated excluded, `asOf` cutoff) with
     consumer-side post-filters (report: amount<0 + exclude inflow; drill-down:
     signed rows). Fixes the split-blind/tracking-account bugs in the spending report.
   - `nextOccurrence` (engine/schedule.ts) gains optional `anchorDay`:
     monthly → `clampDay(addMonths(base, 1), anchorDay)`; default behavior unchanged
     (existing tests stay green).

---

## Feature order

### 1. H1 — Register search & filters (frontend-only)

- `frontend/src/filters.ts` (pure, vitest-tested):
  - `Filters { q, from, to, categoryId, payeeId, min, max, cleared, flag }`
    with defaults + `EMPTY_FILTERS` + `activeCount(f)`.
  - `applyFilters(txns, f)`: AND-composition; text search on payee/category/memo
    only (no amount term); inclusive ISO date range; category/payee match null-aware;
    min/max via `parseAmount` with empty string = unbounded (signed amounts);
    `cleared === 'cleared'` pill means `cleared !== 'uncleared'` (matches header
    balance semantics); flag match incl. null.
- `AccountView.tsx`: one `filters` state object; `visible = useMemo(...)`.
  Editing row pinned: `TxnEditor` renders from the unfiltered list when
  `editingId` set, and that id is skipped in `visible.map` (no double render).
  Ghost ids (`sched:...`) work since ghosts live in `txns`.
- Filter bar (second row under the header): date from/to, category select
  (groups + distinct categoryIds from loaded txns + "—"), payee select
  (payees + `Transfer : <account>` options + "(no payee)"), amount min/max
  (`type="text"` + `inputMode="decimal"`, hint "negative = outflow"),
  cleared pills (All/Uncleared/Cleared/Reconciled), flag select
  (Any/No flag/6 colors), "Clear filters (N)" button, empty-state row.
- Tests: date bounds, cleared semantics, empty-string unbounded, min>max, flag
  null, ghost pass-through, transfer payees, split parents under "—".

### 2. H5 — Export CSV/PDF (frontend-only)

- `frontend/src/csv.ts` (pure, vitest-tested):
  - `toCsv(cells, locale)`: delimiter/decimal pair derived from
    `Intl.NumberFormat(locale).formatToParts(1.1)` (it-IT → `;` + `,`;
    en-US → `,` + `.`); BOM `\uFEFF`; CRLF; RFC 4180 quoting; injection guard
    (prefix `'` on free-text cells starting with `= + - @`).
  - `csvAmount(milli, c)` = same math as `fmt` without symbol, guards `-0`;
    `csvDate(iso)` = ISO unchanged.
  - `downloadFile(name, text, mime)`: sanitize filename
    (`/\\:*?"<>|`), Blob, anchor in DOM, delayed `revokeObjectURL`.
- AccountView: "⋯" overflow menu in the header (this batch builds it; hosts
  Export CSV, Print/Save PDF, Payee Rules, Schedule Suggestions). Reconcile and
  "+ Add Transaction" stay primary. Export binds to the `visible` array
  (WYSIWYG with filters), columns mirror the register exactly:
  `Flag;Date;Payee;Category;Memo;Outflow;Inflow;Cleared;Scheduled;Balance`
  (locale delimiter; Outflow/Inflow positive magnitudes; Balance empty for
  `scheduledId` rows; ISO dates). Disabled when `visible` empty.
- Reflect: per-tab Export at the right end of the filter bar, bound to the same
  react-query data (same queryKey; disabled while loading). Spending filename
  uses the response `from/to`; the three array endpoints use request state.
  BvA export (once H3 exists): `Month;Group;Category;Assigned;Activity;Available`,
  hidden categories marked `(hidden)`, inflow group excluded.
  Reflect export stays enabled on a successful empty result (header-only CSV).
- Print/PDF: `@page { size: A4 landscape; margin: 10mm }` + `@media print` resets
  (`html, body, #root { height: auto; overflow: visible }`, `main { overflow:
  visible !important }`, `.overflow-y-auto { overflow: visible; height: auto }`,
  `print-color-adjust: exact`). Always-mounted print-only `<table>`
  (`hidden print:block`) per view fed from the same data; charts `print:hidden`;
  cleared rendered as text; sidebar/toolbars/filter bars hidden.
  "Print / Save PDF" in the Export menu calls `window.print()`.

### 3. H2 — Payee categorization rules

- `engine/payeeRules.ts` (pure, tested): `normalizePattern`, `matchRule` (exact
  before substring, createdAt ASC, id tie-break; Unicode lowercase; skip
  `SYSTEM_PAYEES` = Starting Balance / Manual Balance Adjustment / Reconciliation
  Balance Adjustment and `Transfer : ` prefixes; skip rules whose category is
  deleted), `pickCategory(payeeName, rules, explicit)` —
  explicit wins when set, else first matching rule, else null.
  Precedence vs inflow fallback: rule match beats inflow default, i.e.
  `categoryId = ruleMatch ?? (isInflow ? inflowCat.id : null)`.
- Routes (register.ts): GET /payee-rules (with categoryName, categoryDeleted,
  match counts computed with apply semantics), POST/PATCH (validate pattern +
  category exists + not deleted, 409 on pattern collision), DELETE (hard).
  POST /payee-rules/apply `{ruleId?, overwrite?, includeReconciled?}`: scope =
  `deleted:false, transferAccountId:null, subtransactions:{none:{}}, categoryId
  null` (or the rule's category when overwrite), `cleared != 'reconciled'` unless
  opted in; JS matching with claimed-set first-rule-wins; returns
  `{applied, perRule, skipped:{reconciled,splits,transfers,systemPayees,noMatch}}`.
- Auto-apply: non-transfer branch of `createTransaction` (resolve payee name
  from payeeId if needed; rule only when caller passed no category) and at
  `POST /scheduled` creation. Importers (importCsv, importTradeRepublic) compute
  `pickCategory(...)` per row with the rule-beats-inflow precedence; explicit
  TSV categories in importYnab untouched. PATCH paths stay manual.
- `DELETE /categories/:id` gains a 409 guard when `payeeRule.count > 0`.
- UI: Rules manager in the "⋯" menu (list: pattern → category, counts, dangling
  ⚠ chip; create/edit form; per-rule Apply with overwrite checkbox + reconciled
  confirm; toast with applied/skipped counts). TxnEditor auto-fill: rules passed
  as props; on payee blur/Enter fill category only when category select empty and
  payee isn't a transfer; hint chip "Rule: pattern → category", cleared on manual
  override.
- Tests: engine/payeeRules.test.ts (precedence, Unicode case, transfer exclusion,
  deleted category, split exclusion, rule-beats-inflow, explicit-never-overridden,
  overwrite semantics).

### 4. H4 — Category drill-down from Reflect

- Spending report fix: consume the shared posting predicate (splits counted via
  sub-postings, on-budget only, future-dated excluded). Donut numbers change for
  splits — accepted correctness fix.
- New route `GET /transactions?categoryId=&from=&to=&accountId=` (register.ts):
  categoryId required → 400 in `{error}` JSON shape; rejects `isInflow` and
  `paymentAccountId` categories with clear error; validates from/to format and
  accountId ownership; month-of range semantics; rows via `serializeTxn`;
  one row per matching posting (split subs expanded, synthetic id
  `parentId:subId` used only as React keys — never for PATCH/DELETE);
  excluded: deleted, future-dated, scheduled ghosts; echo
  `{categoryId, categoryName, from, to, txns}`; date desc + createdAt desc.
- `TxnRow` gains `accountId`; account names resolved client-side from
  `meta.accounts`.
- Shared modal (`TxnListModal`): title = category + range; Outflow/Inflow
  columns, Account, Cleared, flag; two footer modes —
  `spending` = `Σ min(amount,0)` (must equal donut slice; refunds muted subtotal),
  `activity` = signed Σ (must equal month Activity cell); row click navigates
  to `/accounts/:id`; read-only rows; empty + error states via `errMsg`;
  backdrop click + Esc close. Payment-category clicks blocked with
  "derived activity, not drillable".
- Wiring: donut slice + breakdown row click (Spending tab, account filter
  propagated), Budget-vs-Actual category click (`onOpenCategory(cat.id, month)`,
  no account filter). No wiring on Income-v-Expense bars.

### 5. H3 — Budget vs Actual (frontend-only)

- `frontend/src/lib/bva.ts` (pure, vitest-tested): row builder + totals.
  Drop inflow group (empty-categories filter); card-payment categories
  (`paymentAccountId != null`) render as a separate section, Activity relabeled
  "Payments", excluded from utilization/colors/chart/overall totals; totals =
  row-sum, never payload `totalAssigned/totalActivity`; `spent = −min(activity,0)`,
  `refunded = max(activity,0)` shown muted; utilization = spent/assigned when
  assigned>0 else "—", displayed capped ">100%"; color: `available<0` → red
  (cash/mixed) or amber (credit overspendType), else utilization ≥90% amber-100
  else green; tooltip on carried-over negative available.
- ReflectView: month state lifted to ReflectView (init `meta.currentMonth`,
  clamped to `meta.months` bounds); filter bar branches per tab — BvA gets
  prev/next + `<input type="month">`, presets hidden; footer
  `monthLabel(month)` + "Activity through {today}" + "refunds net against
  spending" note; future months: table shown, chart disabled, Available dimmed
  "(no activity yet)"; hidden categories/groups muted but kept in subtotals;
  Activity column signed per CategoryRow convention.
- Table + optional bar chart (assigned vs spent, non-payment cats, zero-activity
  rows excluded, sorted by spent desc, top-12 + "others omitted").
- Query: reuse `api.month(month)` / `['month', month]` (shares BudgetView cache).
- States: Loading, error message, "Nothing budgeted in {month}".

### 6. M6 — Undo system

- `OpLog` per Phase 0. Prune to 200 newest inside the log transaction.
- Logged kinds and payloads:
  - assign / autoAssign: `[{categoryId, month, prev, next}]` (rounded values
    actually written; only categories actually written; prev read inside the tx).
    Undo = `upsert(current − (next − prev))` — always upsert, never delete rows,
    no `existed` flag. Delta semantics compose across any undo order.
  - move: `{month, fromCategoryId, toCategoryId, amount}` (rounded); inverse
    mirrors rta-skip logic exactly.
  - createTxn: `{txnId, transferTxnId?}` → undo = soft-delete both legs.
  - updateTxn: `{txnId, transferTxnId?, prev, prevMirror?}` (full field
    pre-image; restore both legs directly).
  - deleteTxn: `{txnId, transferTxnId?}` → undo = `deleted:false` both legs.
  - deleteCategory / deleteGroup: `{id}` → undo = `{deleted:false}` only
    (never touches hidden).
  - reconcile: `{accountId, adjustmentTxnId: string|null, flipped: string[]}`
    (flipped captured pre-flip; always logged even when no adjustment); undo =
    delete adjustment if any + guarded downgrade `cleared:'reconciled'` →
    `'cleared'` only where still reconciled.
  - patchCategory hidden: `{categoryId, prevHidden}`.
  - Skip-log no-ops (assign next==prev, move amount==0, autoAssign writes nothing).
- Atomicity: mutation + prev reads + op insert + prune in one
  `prisma.$transaction`; `createTransaction` gains an optional tx client
  (POST /transactions logs, `materializeDue` stays unlogged on plain prisma).
  Undo = inverse + singular `opLog.delete({where:{id}})` in one transaction
  (concurrent double-undo → P2025 → 404; SQLITE_BUSY P1002 → 409 retry).
  Undo on a soft-deleted row: write inverse only if still live, else consume op.
- Routes (`backend/src/routes/ops.ts`, registered in server.ts):
  GET /ops?limit=20 → `{id, kind, summary, createdAt}` (joins at read; `'rta'`
  sentinel → "Ready to Assign"; payload never leaves the server);
  POST /ops/:id/undo → `{ok}` or 404/409 with `{error}` shape.
- Frontend: floating History button (fixed, offset below header — `top-20`/`top-24`
  — to avoid covering Reconcile/Add/Category Group) over `<main>` in App.tsx with
  dropdown; undo invalidates `['ops']`, `['budget']`, all `['month']`, all
  `['categories']`, all `['txns']`; `['ops']` invalidation added to the three real
  refresh sites (BudgetView.refresh, Inspector.refresh, AccountView.invalidate).
- Tests: `backend/src/routes/ops.test.ts` via `app.inject` + temp SQLite +
  `prisma db push` + minimal fixture: assign log/undo incl. row-created case;
  delta composition (assign 100→200 then 200→300, undo op1 → 200); cross-kind
  composition (move then assign, undo move); move incl. rta legs; autoAssign
  partial write; createTxn/updateTxn/deleteTxn incl. mirror pair; reconcile with
  and without adjustment; deleteCategory/Group restore w/o hidden change;
  double-undo → 404; undo after prune → 404; malformed payload → 409; no-op not
  logged; prune cap 200; atomicity (mid-tx failure → no op row, op retained).

### 7. M7 — Recurring pattern detection → schedule suggestions

- `engine/schedule.ts`: `nextOccurrence` gains optional `anchorDay` (Phase 0);
  `materializeDue` passes `s.anchorDay` through.
- `engine/suggestions.ts` (pure, tested): `detectSuggestions(rows, today)`:
  - Input rows: date, amount, payeeId, accountId, cleared, categoryId, subcount.
  - Filters: `date ≤ today`, deleted excluded, `transferAccountId == null`,
    payeeId non-null, no subtransactions, cleared ∈ {cleared, reconciled},
    payee not in excluded set; dedupe one row per `(payeeId, accountId, date,
    amount)` preferring cleared.
  - Group by `(payeeId, accountId)`; same-sign occurrences required;
    occurrences ≥4 (yearly ≥3); recency guard `today − last ≤ 1.5×interval`.
  - Frequency: test candidates `{weekly 7k±2 (k≤3), everyOtherWeek 14k±3 (k≤2),
    monthly [28,31] or modal-day±4, yearly 364–366}`; best match ratio, ≥60% and
    ≥3 matched gaps; tie-break by lowest mean multiplier k (pure-14-day stream →
    everyOtherWeek), then smaller base interval; reject if none matches.
  - Amount: tolerance `max(1% of modal, 500 milliunits)` → `fixed` else `varies`
    with modal amount.
  - `confidence = 0.35·min(1,(occ−2)/4) + 0.40·reg + 0.25·amt`, threshold ≥0.6.
  - `nextDate`: strictly first occurrence > today; monthly via anchorDay (modal
    day-of-month, clamped); walk capped at 120; drop rows where nextDate null.
  - Output: `{payeeId, payee, accountId, categoryId (modal), amount, frequency,
    anchorDay, nextDate, occurrences, confidence, recentDates}`.
- Route: GET /scheduled/suggestions?accountId= (thin; loads rows, calls the pure
  function, sorts confidence desc, caps at 20). Payees included for names.
- UI: Suggestions entry in the "⋯" menu (badge with count from
  `useQuery(['suggestions', id])`); modal: payee, amount (editable), frequency
  (editable), nextDate (editable), category select (pre-filled from modal
  categoryId), occurrences, confidence, recent dates; Add →
  `api.createScheduled({accountId, payeeId, categoryId, amount, frequency,
  nextDate, anchorDay})`; invalidate `['txns', id]`, `['budget']`,
  `['suggestions', id]`; empty + error states via `errMsg`.
- Tests: engine/suggestions.test.ts (31st-anchor drift, Feb boundary,
  biweekly-with-skip vs monthly, weekly-with-skip, pure-14 → everyOtherWeek,
  paused/ended subscriptions, split parent excluded, mixed-sign refund,
  dedupe, uncleared-only rejection, adjustment-payee exclusion, yearly
  3-occurrence, strict nextDate > today, exactly-60% boundary).

### 8. M8 — Cash-flow projection

- `engine/cashflow.ts` (pure, tested):
  - Anchor `rta0 = comp.rtaByMonth[currentMonth] ?? 0` (returned with anchorMonth).
  - Horizon `listMonths(addMonths(currentMonth,1), addMonths(currentMonth,N))`;
    N validated 1..36; `?? 0` on every comp lookup; partial "rest of current
    month" row shows only known upcoming/scheduled net + anchor RTA; RTA chain
    starts at the first full horizon month.
  - `projectedRTA[M] = prev + projectedIncome[M] − projectedAssigned[M]`;
    `projectedAssigned[M]` = actual assigned when the user has assigned in M
    (from comp.monthCategories), else trailing-3-month average of
    `assignedByMonth`. `projectedNet = income − spending` is a separate
    cash-flow column.
  - Averages over completed months (≥2 required → `sufficient:false`), income
    average excludes system payees (Starting Balance / Reconciliation Balance
    Adjustment).
  - Spending hybrid: per category — scheduled occurrences in window + trailing
    average of (historical category activity − that schedule's historical
    occurrences); payment categories excluded. Scheduled inflows lift
    projectedIncome in their month.
  - `knownScheduledNet[M]`: iterate `nextOccurrence` from
    `max(nextDate, tomorrow)` (route calls `materializeDue` first), skip
    scheduled transfers targeting on-budget accounts (count tracking-target
    transfers), 120-cap, bucket by occurrence date; real future-dated txns
    (`date > today`, deleted:false) bucketed up to `horizonEnd` (beyond =
    dropped, documented), tagged `source: 'upcoming' | 'scheduled'`.
  - Rows: `{month, partial, knownScheduledNet, projectedIncome,
    projectedSpending, projectedNet, projectedRTA, schedules:[{date, payee,
    amount, frequency, source}]}`; unknown-frequency schedules skipped + counted.
- Route GET /reports/cashflow?months=N (reports.ts): validate (400 on bad N),
  `materializeDue(budget.id)` first, loadComputation, pure function,
  `{anchorRta, anchorMonth, historyMonths, sufficient, horizonMonths}`;
  schedules with `include: { payee: true }`.
- UI: "Cash Flow" tab; filter bar branches to horizon chips (3/6/12);
  footer "Projection: N months · based on M completed months"; table with
  signed/colored cells; ComposedChart (income/spending bars, projected RTA line,
  dashed anchor reference line, zero line); collapsible per-month schedule
  lists; insufficient-data state; footnote: model irregular income (December
  grant) as scheduled inflows; "activity net of refunds" tooltips.
- Tests: engine/cashflow.test.ts (clamp-day, once/weekly across month ends,
  hybrid replacement + undercount guard, transfer-leg exclusion, insufficient
  history, negative chain, beyond-lastMonth window, partial current-month row,
  system-payee exclusion, future-dated bucket cap).

### 9. M9 — Debt & Savings (frontend-only)

- Reflect tab "Debt & Savings"; reuses `['rep','ie',...]` query + shared presets;
  global footer hidden on this tab, section-local captions instead.
- Savings Rate section:
  - `windowEnd = min(range.to, meta.currentMonth)`; series clipped to it;
    current month labeled "(to date)".
  - Headline stat cards: money-weighted rate `Σ(inc−exp)/Σinc` over trailing
    3/6/12 months ending at windowEnd; "n/a" when Σinc = 0 or
    `windowEnd < range.from`; negative rates rendered red with caption.
  - Main chart: net savings (income − expense) bars.
  - Secondary line: per-month rate, plotted only when `income > 0 AND
    expense < 2×income` (suppresses the −15.600% spikes), null otherwise, gaps
    not connected, percent formatter `(v*100).toFixed(0)+'%'`, tooltip "income
    too low for a meaningful rate" on suppressed months.
  - Caption: expense includes transfers to tracking accounts; uncategorized
    outflows excluded; income = inflows to Ready to Assign only.
- Payoff Simulator (`frontend/src/payoff.ts` + `parsePercent` in format.ts, both
  tested):
  - Inputs: tracking-account picker (`!onBudget && !closed` per Sidebar
    convention; prefill `balance = −working` when working < 0; "— manual entry —"
    default; empty-state message when no tracking accounts), balance, TAN/APR %
    (nominal; TAEG not modeled — footnote), mode fixed monthly payment or
    payoff-by-date, optional extra monthly payment.
  - Math contract: monthly rate = TAN/12; month-end payments; per-row interest/
    principal rounded to milliunits; final row = exact residual (clamp, never
    negative); `r = 0 → P = B/n`; validation `payment + extra > first-month
    interest` (inline error); iteration cap 600 with "does not amortize" state;
    payoff-by-date n = calendar months (n ≥ 1); required payment rounded up to
    the cent; extra payment accelerates → show actual payoff month.
  - Outputs: amortization table (all rows when ≤120, else first 12 + last 12 +
    ellipsis row + total count), total interest (positive sum), payoff month,
    balance-over-time LineChart. Live updates on change (ReconcilePanel pattern).
- Tests (vitest): payoff known-answer (€100.000 @4% TAN 20y → P ≈ €605,98; total
  interest ≈ €45.436), zero-rate, payoff-by-date, rounding-to-cent final row,
  extra-payment acceleration, payment < interest rejection; rate math:
  income=0/negative → null, >100% rate, money-weighted window with lumpy income
  (grant fixture), suppression rule, clipping to windowEnd.

---

## Shared conventions

- ASCII-only code/comments (existing repo style); no code comments unless
  needed for non-obvious semantics (repo has a few; keep sparse).
- Backend: TS with semicolons, Fastify `{error}` JSON shape for all 4xx/5xx so
  `errMsg` surfaces messages.
- Frontend: no semicolons; react-query keys follow existing conventions
  (`['month', m]`, `['txns', id]`, `['rep', ...]`); new pure logic lands in
  dedicated modules with vitest coverage; all new UI follows the inline
  component pattern (no new generic component libraries).
- Every feature verified: `npm run build` + `npm run lint` (frontend),
  `npm test` (backend), curl checks against the running dev server, and a
  browser pass via opencli.
- Out of scope (explicitly deferred): filter URL *presets* (persistence of the
  filters themselves shipped in the 2026-08-15 batch), fuzzy payee merging
  beyond suggestions, dismissal persistence for suggestions (shipped), split
  transfers (delete+recreate), schedule-edit UX overhaul (shipped: preview +
  skip), seasonal weighting beyond the same-month-last-year blend, targets-aware
  projection (shipped) vs targets-aware *auto-assign*, localStorage persistence
  for the simulator.

---

## Follow-up: Debt Plans (amortization plans for debts)

Implemented after the batch above.

- **Schema**: `DebtPlan { name, accountId? (linked tracking account — balance
  syncs from -working), balance (manual when unlinked), tanBps (basis points),
  payment, targetMonth?, extraPayment, startMonth, active, note }`. Inputs are
  stored; the schedule is derived on read with `frontend/src/payoff.ts`.
- **Routes** (`backend/src/routes/debts.ts`, registered in server.ts):
  GET/POST/PATCH/DELETE `/debt-plans` (effectiveBalance returned with
  `loadComputation` balances; account ownership validated; tanBps 0-5000) and
  `POST /debt-plans/:id/payment-schedule {accountId, amount?, frequency
  monthly|once, categoryId?}` — materializes the payments as a
  ScheduledTransaction (transfer to the linked tracking account when linked,
  plain expense otherwise), memo-marked `Piano ammortamento: <planId>` for
  idempotency and `hasPaymentSchedule` detection; linked plans get the
  `Transfer : <account>` payee, manual plans a payee named after the plan.
- **Frontend**: "Debts" sidebar item + `/debts` route; `DebtsView` master-detail
  (plan cards → detail with stat cards, balance-at-month lookup, chart,
  capped amortization table, schedule panel with source account / frequency /
  amount). PlanEditor modal for create/edit (tracking-account link or manual
  balance, TAN %, fixed-payment or payoff-by-date mode).
- **Modeling note** (student loan): a lump-sum closure is modeled as
  manual balance = total residual including accrued interest with a
  single `once` payment — linking the account would track capital
  only and understate the closure amount.
- **Tests**: `backend/src/routes/debts.test.ts` (CRUD, sync, schedule
  idempotency, past startMonth, validation) + `balanceAtMonth` in
  frontend `payoff.test.ts`.

---

## Follow-up: bulk edit, payee merge, goal plans

- **Bulk edit** — `POST /transactions/bulk { ids, data: {categoryId|flagColor}, delete }`
  (max 500 ids; transfers and split parents are skipped for category changes —
  their categories are locked/no-op; delete soft-deletes mirror pairs). Every
  affected row logs a regular `updateTxn`/`deleteTxn` undo op, so bulk edits
  undo one by one. Register rows gained a checkbox column + a selection bar
  (category / flag / delete / clear; scheduled ghost ids are excluded from
  bulk actions).
- **Payee management** — `GET /payees/manage` (per-payee txn count + top
  categories), `POST /payees/:id/rename` (409 on name clash with a live payee),
  `POST /payees/merge {fromId, toId}` — moves transactions, subtransactions and
  schedules to the target, deletes the source payee, logs a `mergePayees` undo
  op (payload carries `fromId/toId/fromName/txnIds/subTxnIds`; schedules are
  NOT restored by undo — documented). Transfer payees are excluded from
  rename/merge. UI: PayeesManager modal in the register `⋯` menu.
- **Goal plans** — `GoalPlan { name, accountId? (progress syncs from working
  balance), categoryId? (funding category), target, current, monthlyContribution,
  targetMonth?, startMonth, active, note }`; CRUD routes mirror debts; `POST
  /goal-plans/:id/contribution-schedule` (memo `Piano risparmio: <planId>`,
  monthly, categorized, idempotent). Frontend: "Goals" 🎯 sidebar view with
  progress bars, required-contribution / reach-by-date math
  (`requiredContribution`, `monthsToTarget` in `payoff.ts`), projection chart.
- **Tests**: `routes/bulk.test.ts`, `routes/payees.test.ts` (incl. merge undo),
  `routes/goals.test.ts`; `payoff.test.ts` gains goal-math cases. All wired
  into `npm test` (9 backend suites + frontend vitest).

---

## Follow-up: Shopping email via Agent Mail (implemented 2026-08-15)

The Shopping email route (`POST /shopping/lists/:id/email`) now prefers
**AgentMail** (`https://api.agentmail.to/v0/inboxes/{AGENTMAIL_INBOX}/messages/send`,
`Authorization: Bearer AGENTMAIL_API_KEY`, key also readable from
`AGENTMAIL_API_KEY_FILE` — the desktop email agent's file pattern) and falls
back to direct SMTP (`SMTP_HOST` etc.). Recipient = body `to` or
`SHOPPING_EMAIL_TO`; subject `Lista della spesa — <date> (stimato <N> €)`;
body from `buildEmailBody()`. 409 with a clear message when neither channel is
configured. Response now includes `channel: 'agentmail' | 'smtp'`. `.env` is
set up with `AGENTMAIL_API_KEY_FILE` + `AGENTMAIL_INBOX` (both gitignored).

## Follow-up: tightening batch (implemented 2026-08-15)

Closed out several items from the deferred list plus workflow gaps:

- **Split-transaction editor** — `POST/PATCH /transactions` accept
  `subtransactions` (≥2 rows, nonzero amounts, live non-inflow categories,
  sum == parent amount; transfers rejected 400). Split parents keep
  `categoryId null`; rows serialize into the register (`TxnRow.subtransactions`)
  and the `TxnEditor` gains a Split toggle (per-row category/amount/payee/memo,
  auto parent total). `updateTxn` undo ops carry `prevSubs` pre-images —
  undo restores the exact previous rows. Bad payloads → 400 `{error}`.
- **Schedule-edit UX** — ghost rows now carry `anchorDay`; the editor shows the
  next 4 occurrences (`frontend/src/lib/dates.ts`, mirrors engine/schedule.ts,
  vitest-tested) and a **Skip next** button (`POST /scheduled/:id/skip` —
  advances nextDate, never materializes).
- **Multi-select filters + URL persistence** — `filters.ts` uses
  `categories[]`/`payees[]`/`flags[]` (OR-composed, `__none__` sentinel);
  `filtersToQuery`/`filtersFromQuery` sync to the account URL (`?q=&cat=&payee=
  &min=&max=&cleared=&flag=`); FilterBar uses checkbox dropdowns
  (`MultiSelect`). Tests updated.
- **Targets-aware + seasonal cash-flow** — `projectCashflow` takes `targetCats`
  (per-month `computeTarget` requirement); unassigned months are floored at
  `max(trailing assigned avg, Σ target requirements)`. Category spending and
  income use a seasonal factor: 50/50 blend of the same-calendar-month-last-year
  value with the flat average when history ≥ 6 months, else 1. Reflect
  footnote updated.
- **File-import UI** — `routes/imports.ts`: `POST /import/csv` (BVR format) and
  `POST /import/tr-csv` (TR format), sharing the exact parsers/dedup with the
  CLI (`importBankCsv`, `importTradeRepublicCsv`; their `main()` is now guarded
  by an is-main check so importing them can't run the CLI). AccountView ⋯ menu
  → **Import CSV…** (drag & drop, format + account select, result + backup name).
- **Auto-backup hook** — `backend/src/backup.ts` (`backupDb(label)`): timestamped
  copy of dev.db into `backups/`, pruned to 30. Runs before `seed --force` and
  before every import route call.
- **Duplicate detection** — `GET /transactions/duplicates?accountId=` groups
  same account/date/|amount|/payee rows; ⋯ menu badge + `DuplicatesModal`
  (group checkboxes, bulk delete, undoable).
- **Suggestions dismissal persistence** — `SuggestionDismissal` table
  (unique budgetId+payeeId+accountId); `POST /suggestions/dismiss`,
  `DELETE /suggestions/dismiss`, `GET /suggestions/dismissed`; suggestions route
  excludes dismissed pairs; SuggestionsModal has per-row dismiss + restore list.
- **Fuzzy payee merging** — `engine/similarity.ts` (levenshtein + containment
  + normalization, pure); `GET /payees/similar`; PayeesManager shows amber
  "Similar names" pairs with one-click merge.

Tests: `engine/similarity.test.ts`, `routes/tools.test.ts` (dismissal,
duplicates, similarity, skip), split create/edit/undo in `ops.test.ts`,
targets+seasonal cases in `cashflow.test.ts`, `lib/dates.test.ts` + updated
`filters.test.ts` on the frontend. All wired into `npm test`.

Still deferred (unchanged): filter URL *presets*, fuzzy payee merging beyond
suggestions, split-transfer conversion (delete+recreate), seasonal weighting
for the remainder-average paths, targets-aware *auto-assign*, localStorage
persistence for the payoff simulator.
