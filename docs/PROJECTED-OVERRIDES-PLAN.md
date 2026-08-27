# Plan: editable projected expenses (per-category, per-month overrides)

**Goal:** in the Budget page's forecast side panel, allow editing a category's projected
expense. Edits become per-(category, month) overrides persisted in the backend; the panel's
totals and NET use the effective values (override ?? moving average). Clearing a value
reverts to the average.

Status: resumable task list.

---

## Resumable task list

### Phase 1 — DB + backend
- [x] `backend/prisma/schema.prisma`: add
      ```prisma
      model ProjectedOverride {
        id         String   @id @default(cuid())
        budgetId   String
        budget     Budget   @relation(fields: [budgetId], references: [id], onDelete: Cascade)
        categoryId String
        month      String   // "YYYY-MM-01"
        amount     Int      // signed milliunits, negative = projected spending
        createdAt  DateTime @default(now())
        @@unique([budgetId, categoryId, month])
      }
      ```
      + `projectedOverrides ProjectedOverride[]` on `Budget`.
- [x] `cd backend && npx prisma db push` (syncs dev.db, regenerates client).
- [x] `backend/src/routes/forecast.ts`:
      - `GET /forecast?month=YYYY-MM-01&window=N` (month optional → current month):
        load overrides for that month; per category `effective = override ?? average`;
        categories with an override but no history also appear; `overridden: boolean` per row;
        filter `effective < 0`; sort asc; `projectedTotal = Σ −effective`.
      - `PUT /forecast/overrides/:categoryId` body `{ month, amount }` → upsert
        (validate `month` format + integer `amount`).
      - `DELETE /forecast/overrides/:categoryId?month=` → delete (no-op if absent).
- [x] Extend `backend/src/routes/forecast.test.ts`: override supersedes average; deleting
      reverts to average; override-only category appears; upsert idempotent; invalid month/amount → 400.

### Phase 2 — frontend
- [x] `frontend/src/api.ts`: `ForecastCat` gains `overridden?: boolean`; change
      `forecast(month, window)` (URL `?month=&window=`); add
      `setForecastOverride(categoryId, month, amount)` (PUT) and
      `deleteForecastOverride(categoryId, month)` (DELETE).
- [x] `BudgetView.tsx`: forecast query key `['forecast', month, months]`, pass `month`.
- [x] `ForecastPanel.tsx`: each projected row's amount becomes an inline-edit
      (button → input, like the Budgeted cell). Enter/blur saves; Esc cancels.
      Empty/`0` input deletes the override (reverts to average). Overridden rows show the
      amount in `emerald-700` + a `•` marker. On save: `setForecastOverride` mutation →
      invalidate `['forecast']`.

### Phase 3 — verify
- [x] `cd backend && npm test` (incl. forecast.test.ts).
- [x] `cd frontend && npm run build && npm test && npm run lint`.
- [x] Live smoke (headless Chrome): edit a projected value → total/NET change, marker shows,
      persists after window/month switch; clear → reverts to average.

### Phase 4 — overrides feed Cash Flow + undo (2026-08-22)
- [x] `cashflow.ts`: new `overrides` param; per month, an overridden category replaces its
      spending estimate (override wins over scheduled+remainder / seasonal average); verified in test 12.
- [x] `reports.ts`: load `ProjectedOverride`s, pass to `projectCashflow`.
- [x] `ops-helpers.ts`: `undoOp` case `projectedOverride` — payload `{ categoryId, month, prev, next }`
      (both nullable): `next===null` recreates `prev`; `prev===null` deletes; else restores `prev`.
- [x] `ops.ts` `summarize`: `projectedOverride` → human-readable (set/edit/revert to average).
- [x] `forecast.ts`: wrap set/delete override routes in `$transaction` + `logOps` (kind `projectedOverride`).
- [x] `forecast.test.ts`: register `opsRoutes` too; assert an op is logged and `POST /ops/:id/undo`
      reverts a set and restores a delete.
- [x] `ForecastPanel.tsx`: invalidate `['ops']` after set/delete so HistoryMenu updates.
- [x] Reflect Cash Flow: report per-row override count; show a small badge when overrides are in effect.

## Gotchas
- Money = signed milliunits; a projected expense is stored **negative** (`amount = −parseAmount(input)`).
- `parseAmount` (frontend) now accepts arithmetic — reuse it for the edit input.
- `prisma db push` on dev.db is additive (new empty table); safe for existing data.
- Tests create temp DBs via `prisma db push --skip-generate`; client is generated once.

## Files touched (expected)
- `backend/prisma/schema.prisma`
- `backend/src/routes/forecast.ts`
- `backend/src/routes/forecast.test.ts`
- `frontend/src/api.ts`
- `frontend/src/components/BudgetView.tsx`
- `frontend/src/components/ForecastPanel.tsx`