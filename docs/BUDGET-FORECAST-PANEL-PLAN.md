# Plan: Budget-page forecast side panel

**Goal:** replace the central Ready-to-Assign strip with a right-side panel that, for
the selected month, shows (1) Ready to Assign, (2) known transactions, (3) projected
expenses per category from a selectable moving average (12/6/3 months), and a NET line.
The panel disappears when a category is selected for editing (Inspector takes over) and
returns when deselected.

Status: resumable task list. Re-read referenced files if interrupted.

---

## Resumable task list

### Phase 1 — Backend: `GET /api/forecast`
- [x] Create `backend/src/routes/forecast.ts`:
      - Query `window` (3 | 6 | 12, default 6; 400 otherwise).
      - `budget = getBudgetOrThrow()`, `{ comp, categories } = loadComputation(budget.id)`.
      - Completed months = distinct `comp.monthCategories[].month` with `month < monthOf(today())`,
        sorted desc; take first `window`.
      - Per category: average `mc.activity` over those months (skip zero avgs, keep only
        `avg < 0` → spending). Sort most-negative first.
      - `projectedTotal = Σ −avg`. Response:
        `{ window, historyMonths, projected: [{categoryId, categoryName, avg}], projectedTotal }`.
      - Map inflow category name → `Ready to Assign` (skip from list via avg>0 filter anyway).
- [x] Register in `server.ts` (`import forecastRoutes ...` + `await app.register(forecastRoutes, { prefix: '/api' })`).
- [x] `backend/src/routes/forecast.test.ts`: temp SQLite budget + on-budget account + 2 categories,
      transactions with category activity in the last 1-4 months (relative to `today()`), assert
      window=3 picks only the 3 most recent completed months and averages correctly; window=12/6
      behave; `window=7` → 400. Wire into `backend/package.json` test script.

### Phase 2 — Frontend: api layer
- [x] `frontend/src/api.ts`: `ForecastCat` / `ForecastData` types +
      `forecast: (months: number) => get<ForecastData>(`/forecast?window=${months}`)`.

### Phase 3 — Frontend: ForecastPanel component
- [x] New `frontend/src/components/ForecastPanel.tsx`. Props:
      `{ month, c, readyToAssign, expectedMonth?, forecast?, months, setMonths }`.
      Renders (right column, matches Inspector chrome: `w-[328px] border-l bg-white p-5`):
      1. **Ready to Assign** — label + `fmt` amount + `rtaLabel`.
      2. **Known transactions · <monthLabel>** — list from `expectedMonth.items`
         (`date · payee · amount`, scheduled/upcoming markers) + `Known net` footer.
      3. **Projected expenses** — segmented `12m | 6m | 3m` control (calls `setMonths`);
         per-category rows (`categoryName`, `fmt(-avg)`) + `Projected total`.
      4. **Net** (bottom) = `knownNet − projectedTotal`; red when negative, emerald when positive;
         caption `Known net − projected expenses`.
      Empty states: "No scheduled or upcoming transactions this month." /
      "No spending history in the selected window."
- [x] Currency formatting via `fmt` (milliunits) + `tnum`.

### Phase 4 — Frontend: wire into BudgetView
- [x] Add `const [months, setMonths] = useState(6)` + `useQuery(['forecast', months], () => api.forecast(months))`.
- [x] **Remove** the central Ready-to-Assign strip and the `isFuture` known-transactions preview.
- [x] Right side of the layout becomes conditional:
      `selectedCats.length > 0 ? <Inspector …/> : <ForecastPanel …/>`.
      (`selectedCats` = selected category views; selecting a category swaps the panel to the
      Inspector, deselecting brings the forecast panel back.)
- [x] `refresh()` also invalidates `['expected']` and `['forecast']`.
- [x] Remove now-unused imports in BudgetView (`rtaLabel`, `dateDisplay`, `isFuture`).

### Phase 5 — Verify
- [x] `cd backend && npm test` (incl. forecast.test.ts).
- [x] `cd frontend && npm run build && npm test && npm run lint`.
- [x] Live smoke (headless Chrome + CDP on http://localhost:5173/):
      panel shows RTA + known txns + projected expenses (window switch refetches);
      clicking a category row swaps to Inspector; deselect returns the panel;
      month navigation updates the panel.

## Gotchas
- `window` is a bad prop name (shadows global) — use `months`/`setMonths`.
- `comp.monthCategories` entries are `{month, categoryId, assigned, activity, available}`.
- `loadComputation(budget.id)` is async and runs the engine fresh per request.
- Money = signed milliunits; activity is negative for spending.
- Forecast is month-independent (trailing average as of today), so the endpoint takes only `window`.

## Files touched (expected)
- `backend/src/routes/forecast.ts` (new)
- `backend/src/routes/forecast.test.ts` (new)
- `backend/src/server.ts`
- `backend/package.json`
- `frontend/src/api.ts`
- `frontend/src/components/ForecastPanel.tsx` (new)
- `frontend/src/components/BudgetView.tsx`