import type { QueryClient } from '@tanstack/react-query'
import { api, errMsg } from '../api'

// Shared "undo last op" — used by the command palette and the global shortcut.
export async function undoLastChange(qc: QueryClient): Promise<void> {
  try {
    const ops = await api.ops()
    if (ops.length > 0) {
      await api.undoOp(ops[0].id)
      for (const key of ['ops', 'budget', 'month', 'categories', 'txns']) {
        qc.invalidateQueries({ queryKey: [key] })
      }
    }
  } catch (e) {
    alert(errMsg(e as Error))
  }
}
