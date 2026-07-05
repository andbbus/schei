import { Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import Sidebar from './components/Sidebar'

export default function App() {
  const { data, isLoading, error } = useQuery({ queryKey: ['budget'], queryFn: api.budget })

  if (isLoading)
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
    </div>
  )
}
