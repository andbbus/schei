import { Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import Sidebar from './components/Sidebar'
import HistoryMenu from './components/HistoryMenu'
import CommandPalette from './components/CommandPalette'
import Welcome from './components/Welcome'

export default function App() {
  // first-run gate: a fresh clone has no budget yet → wizard instead of the shell
  const { data: setup } = useQuery({ queryKey: ['setup'], queryFn: api.setupStatus })
  const { data, isLoading, error } = useQuery({
    queryKey: ['budget'],
    queryFn: api.budget,
    // fetch the budget only once the setup gate has confirmed one exists
    enabled: !!setup?.hasBudget,
    retry: 1,
  })

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
    </div>
  )
}
