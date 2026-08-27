import { useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { BudgetMeta } from '../api'
import { api, errMsg } from '../api'
import { fmt, parseAmount, normalizeAmount, type Currency } from '../format'

type CatalogItem = { id: string; store: string; name: string; brand: string | null; price: number; unit: string | null; imageUrl: string | null }

const STORES = ['all', 'aldi', 'lidl', 'netto', 'manual'] as const

export default function ShoppingView() {
  const meta = useOutletContext<BudgetMeta>()
  const c: Currency = {
    symbol: meta.budget.currencySymbol,
    digits: meta.budget.decimalDigits,
    locale: meta.budget.locale,
  }
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [store, setStore] = useState<(typeof STORES)[number]>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [freeName, setFreeName] = useState('')
  const [freePrice, setFreePrice] = useState('')
  const [emailTo, setEmailTo] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: catalog } = useQuery({
    queryKey: ['shopping-catalog', q, store],
    queryFn: () => api.shoppingCatalog(q, store),
  })
  const { data: lists } = useQuery({ queryKey: ['shopping-lists'], queryFn: api.shoppingLists })
  const selected = lists?.find((l) => l.id === selectedId) ?? lists?.[0] ?? null

  const refreshLists = () => qc.invalidateQueries({ queryKey: ['shopping-lists'] })
  const refreshCatalog = () => qc.invalidateQueries({ queryKey: ['shopping-catalog'] })

  const sync = useMutation({
    mutationFn: api.shoppingSync,
    onSuccess: (r) => {
      refreshCatalog()
      const parts = r.results.map((x) => `${x.store}: ${x.status === 'ok' ? `${x.count} prodotti` : x.error ?? x.status}`)
      setSyncMsg(`Settimana ${r.week} — ${parts.join(' · ')}`)
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })
  const ensureList = async (): Promise<string> => {
    if (selected) return selected.id
    const made = (await api.createShoppingList()) as { id: string }
    refreshLists()
    setSelectedId(made.id)
    return made.id
  }
  const addItem = useMutation({
    mutationFn: async (it: CatalogItem) => {
      const listId = await ensureList()
      return api.shoppingAddItem(listId, { itemId: it.id })
    },
    onSuccess: refreshLists,
    onError: (e: Error) => setError(errMsg(e)),
  })
  const addFree = useMutation({
    mutationFn: async () => {
      const listId = await ensureList()
      const price = parseAmount(freePrice) / 1000
      return api.shoppingAddItem(listId, { name: freeName.trim(), price: Number.isFinite(price) ? Math.round(price * 1000) : 0 })
    },
    onSuccess: () => {
      refreshLists()
      setFreeName('')
      setFreePrice('')
    },
    onError: (e: Error) => setError(errMsg(e)),
  })
  const setQty = useMutation({
    mutationFn: ({ listId, itemId, quantity }: { listId: string; itemId: string; quantity: number }) =>
      api.shoppingSetQty(listId, itemId, quantity),
    onSuccess: refreshLists,
  })
  const removeItem = useMutation({
    mutationFn: ({ listId, itemId }: { listId: string; itemId: string }) => api.shoppingRemoveItem(listId, itemId),
    onSuccess: refreshLists,
  })
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateShoppingList(id, name),
    onSuccess: refreshLists,
  })
  const removeList = useMutation({
    mutationFn: (id: string) => api.deleteShoppingList(id),
    onSuccess: () => {
      refreshLists()
      setSelectedId(null)
    },
  })
  const email = useMutation({
    mutationFn: (listId: string) => api.shoppingEmail(listId, emailTo.trim() || undefined),
    onSuccess: () => setError(null),
    onError: (e: Error) => setError(errMsg(e)),
  })

  const total = selected?.items.reduce((s, i) => s + i.price * i.quantity, 0) ?? 0
  const knownTotal = selected?.items.filter((i) => i.price > 0).reduce((s, i) => s + i.price * i.quantity, 0) ?? 0

  const onCsv = async (file: File) => {
    const text = await file.text()
    const r = await api.shoppingImportCsv(text)
    refreshCatalog()
    setSyncMsg(`CSV importato — ${r.count} prodotti per la settimana ${r.week}`)
  }

  useEffect(() => {
    if (lists && lists.length > 0 && !lists.some((l) => l.id === selectedId)) setSelectedId(lists[0].id)
  }, [lists, selectedId])

  return (
    <div className="flex h-full bg-panel">
      <div className="flex w-[46%] min-w-[380px] shrink-0 flex-col border-r border-slate-200">
        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Shopping</h1>
            <div className="text-xs text-slate-400">
              Offerte settimana {catalog?.week ?? '…'} — prezzi stimati, possono variare in negozio
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              {sync.isPending ? 'Sincronizzo…' : 'Sync'}
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onCsv(f)
                e.target.value = ''
              }}
            />
          </div>
        </div>
        {syncMsg && <div className="border-b border-slate-100 bg-blue-50 px-4 py-2 text-xs text-blue-700">{syncMsg}</div>}
        {error && <div className="border-b border-slate-100 bg-red-50 px-4 py-2 text-xs text-red-600">{error}</div>}

        <div className="flex items-center gap-1.5 border-b border-slate-200 px-4 py-2">
          <input
            placeholder="Cerca nel catalogo…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm"
          />
          <select
            value={store}
            onChange={(e) => setStore(e.target.value as (typeof STORES)[number])}
            className="rounded border border-slate-200 px-2 py-1.5 text-sm"
          >
            {STORES.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'Tutti' : s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="divide-y divide-slate-50">
            {catalog?.items.map((it) => (
              <div key={it.id} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-slate-50">
                {it.imageUrl && (
                  <img
                    src={it.imageUrl}
                    alt=""
                    loading="lazy"
                    onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                    className="h-9 w-9 shrink-0 rounded object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-slate-700">{it.name}</div>
                  <div className="text-[11px] text-slate-400">
                    {it.brand ? `${it.brand} · ` : ''}
                    {it.store}
                    {it.unit ? ` · ${it.unit}` : ''}
                  </div>
                </div>
                <span className="tnum shrink-0 text-slate-700">{it.price > 0 ? fmt(it.price, c) : '—'}</span>
                <button
                  onClick={() => addItem.mutate(it)}
                  className="shrink-0 rounded bg-accent px-2 py-1 text-xs text-white hover:bg-accent-hover"
                >
                  +
                </button>
              </div>
            ))}
            {catalog?.items.length === 0 && <div className="px-4 py-8 text-center text-sm text-slate-400">Nessun prodotto.</div>}
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <select
            value={selected?.id ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            className="rounded border border-slate-200 px-2 py-1.5 text-sm"
          >
            {!selected && <option value="">—</option>}
            {lists?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {selected && (
            <>
              <input
                defaultValue={selected.name}
                onBlur={(e) => {
                  const n = e.target.value.trim()
                  if (n && n !== selected.name) rename.mutate({ id: selected.id, name: n })
                }}
                className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm"
              />
              <button
                onClick={() => selected && removeList.mutate(selected.id)}
                className="rounded px-2 py-1 text-sm text-red-500 hover:bg-red-50"
                title="Delete list"
              >
                🗑
              </button>
            </>
          )}
          <button
            onClick={() => api.createShoppingList().then((l) => { const made = l as { id: string }; refreshLists(); setSelectedId(made.id) })}
            className="rounded border border-slate-200 px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            + Lista
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {!selected && <div className="p-6 text-center text-sm text-slate-400">Crea una lista per iniziare.</div>}
          {selected && (
            <>
              <div className="divide-y divide-slate-100">
                {selected.items.map((it) => (
                  <div key={it.id} className="flex items-center gap-2 py-1.5 text-sm">
                    {it.imageUrl && (
                      <img
                        src={it.imageUrl}
                        alt=""
                        loading="lazy"
                        onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
                        className="h-7 w-7 shrink-0 rounded object-cover"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-slate-700">
                      {it.name}
                      <span className="ml-1 text-[11px] text-slate-400">{it.store}</span>
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setQty.mutate({ listId: selected.id, itemId: it.id, quantity: it.quantity - 1 })}
                        className="h-6 w-6 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
                      >
                        −
                      </button>
                      <span className="tnum w-6 text-center text-slate-700">{it.quantity}</span>
                      <button
                        onClick={() => setQty.mutate({ listId: selected.id, itemId: it.id, quantity: it.quantity + 1 })}
                        className="h-6 w-6 rounded border border-slate-200 text-slate-600 hover:bg-slate-50"
                      >
                        +
                      </button>
                    </div>
                    <span className="tnum w-24 text-right text-slate-700">
                      {it.price > 0 ? fmt(it.price * it.quantity, c) : '—'}
                    </span>
                    <button
                      onClick={() => removeItem.mutate({ listId: selected.id, itemId: it.id })}
                      className="rounded px-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {selected.items.length === 0 && <div className="py-4 text-center text-sm text-slate-400">Lista vuota.</div>}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <input
                  placeholder="Articolo libero…"
                  value={freeName}
                  onChange={(e) => setFreeName(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm"
                />
                <input
                  placeholder="Prezzo €"
                  value={freePrice}
                  onChange={(e) => setFreePrice(e.target.value)}
                  onBlur={(e) => setFreePrice(normalizeAmount(e.target.value))}
                  inputMode="decimal"
                  className="tnum w-24 rounded border border-slate-200 px-2 py-1.5 text-right text-sm"
                />
                <button
                  disabled={!freeName.trim()}
                  onClick={() => addFree.mutate()}
                  className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                >
                  Aggiungi
                </button>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3">
                <div>
                  <div className="text-xs text-slate-400">Totale stimato</div>
                  <div className={`tnum text-2xl font-semibold ${knownTotal !== total ? 'text-amber-600' : 'text-slate-800'}`}>
                    {fmt(total, c)}
                  </div>
                  {knownTotal !== total && (
                    <div className="text-[11px] text-slate-400">{fmt(knownTotal, c)} senza prezzi mancanti</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    placeholder="email (default: configurata)"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    className="w-56 rounded border border-slate-200 px-2 py-1.5 text-sm"
                  />
                  <button
                    onClick={() => email.mutate(selected.id)}
                    disabled={email.isPending}
                    className="rounded bg-positive px-3 py-1.5 text-sm font-medium text-white hover:bg-positive-hover disabled:opacity-40"
                  >
                    Invia email
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
