import { useEffect, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BudgetMeta } from './api'
import { ACTIONS, bindingKey, isEditableTarget, loadBindings, type ActionId } from './shortcuts'
import { undoLastChange } from './lib/undo'
import Sidebar from './components/Sidebar'
import HistoryMenu from './components/HistoryMenu'
import CommandPalette from './components/CommandPalette'
import TransactionModal from './components/TransactionModal'
import ShortcutsModal from './components/ShortcutsModal'
import EmailSettingsModal from './components/EmailSettingsModal'
import Welcome from './components/Welcome'

// Hosts for globally-dispatched actions (custom shortcuts, sidebar button,
// palette): the centered Add-transaction dialog, the shortcut editor and
// the email/digest configuration.
function GlobalHosts({ meta }: { meta: BudgetMeta }) {
  const [addTxn, setAddTxn] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [email, setEmail] = useState(false)
  useEffect(() => {
    const openAdd = () => setAddTxn(true)
    const openShortcuts = () => setShortcuts(true)
    const openEmail = () => setEmail(true)
    window.addEventListener('schei:add-txn', openAdd)
    window.addEventListener('schei:shortcuts', openShortcuts)
    window.addEventListener('schei:email', openEmail)
    return () => {
      window.removeEventListener('schei:add-txn', openAdd)
      window.removeEventListener('schei:shortcuts', openShortcuts)
      window.removeEventListener('schei:email', openEmail)
    }
  }, [])
  return (
    <>
      {addTxn && <TransactionModal meta={meta} onClose={() => setAddTxn(false)} />}
      {shortcuts && <ShortcutsModal onClose={() => setShortcuts(false)} />}
      {email && <EmailSettingsModal onClose={() => setEmail(false)} />}
    </>
  )
}

export default function App() {
  // first-run gate: a fresh clone has no budget yet → wizard instead of the shell
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: setup } = useQuery({ queryKey: ['setup'], queryFn: api.setupStatus })
  const { data, isLoading, error } = useQuery({
    queryKey: ['budget'],
    queryFn: api.budget,
    // fetch the budget only once the setup gate has confirmed one exists
    enabled: !!setup?.hasBudget,
    retry: 1,
  })

  // Central shortcut dispatcher — bindings are user-editable (shortcuts.ts +
  // ShortcutsModal). Actions broadcast window events or navigate directly;
  // plain-key bindings never fire while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const combo = bindingKey(e)
      if (!combo) return
      const bindings = loadBindings()
      const action = (Object.keys(ACTIONS) as ActionId[]).find((id) => bindings[id] === combo)
      if (!action) return
      const def = ACTIONS[action]
      if (isEditableTarget(e.target) && !def.allowInInput) return
      e.preventDefault()
      if (action === 'undo') void undoLastChange(qc)
      else if (def.event) window.dispatchEvent(new CustomEvent(def.event))
      else if (def.path) navigate(def.path)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, qc])

  if (setup && !setup.hasBudget) return <Welcome />

  if (isLoading || !setup)
    return <div className="flex h-full items-center justify-center text-slate-500">Loading budget…</div>
  if (error || !data)
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-red-600">
        Failed to load budget. Is the API running on :3001?
        <br />
        <span className="text-sm text-slate-500">{String(error)}</span>
      </div>
    )

  return (
    <div className="flex h-full">
      <Sidebar meta={data} />
      <main className="flex-1 overflow-hidden">
        <Outlet context={data} />
      </main>
      <HistoryMenu />
      <CommandPalette meta={data} />
      <GlobalHosts meta={data} />
    </div>
  )
}
