import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App'
import BudgetView from './components/BudgetView'
import AccountView from './components/AccountView'
import ReflectView from './components/ReflectView'
import DebtsView from './components/DebtsView'
import GoalsView from './components/GoalsView'
import ShoppingView from './components/ShoppingView'
import SubscriptionsView from './components/SubscriptionsView'

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } })

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <BudgetView /> },
      { path: 'accounts/:id', element: <AccountView /> },
      { path: 'reflect', element: <ReflectView /> },
      { path: 'debts', element: <DebtsView /> },
      { path: 'goals', element: <GoalsView /> },
      { path: 'shopping', element: <ShoppingView /> },
      { path: 'subscriptions', element: <SubscriptionsView /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
