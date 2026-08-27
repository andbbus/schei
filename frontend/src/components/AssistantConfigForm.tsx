import { useState } from 'react'
import { api, errMsg } from '../api'

// Shared assistant-provider form: presets for common OpenAI-compatible
// gateways, live "Test connection" probe, saves to backend/.env via
// POST /setup/chat. Used by the first-run wizard and the Assistant view.

const PROVIDERS = [
  { id: 'opencode', label: 'OpenCode Zen (default)', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'ollama', label: 'Ollama (local, no key)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', model: '' },
]

export default function AssistantConfigForm({
  initial,
  onSaved,
}: {
  initial: { model: string; baseUrl: string; keyTail: string | null; configured: boolean }
  onSaved: (msg: string) => void
}) {
  const matching = PROVIDERS.find((p) => p.baseUrl === initial.baseUrl)
  const [preset, setPreset] = useState(matching?.id ?? 'custom')
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl || PROVIDERS[0].baseUrl)
  const [model, setModel] = useState(initial.model || PROVIDERS[0].model)
  const [apiKey, setApiKey] = useState('')
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pickPreset = (id: string) => {
    setPreset(id)
    const p = PROVIDERS.find((x) => x.id === id)
    if (p?.baseUrl) setBaseUrl(p.baseUrl)
    if (p?.model) setModel(p.model)
  }

  const payload = () => ({
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    // only send the key when the user typed one — blank keeps the stored key
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  })

  const runTest = async () => {
    setBusy(true)
    setError(null)
    setTest(null)
    try {
      const r = await api.setupTestChat(payload())
      setTest({ ok: true, msg: `Works — ${r.model} answered${r.sample ? `: “${r.sample}”` : '.'}` })
    } catch (e) {
      setTest({ ok: false, msg: errMsg(e as Error) })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.setupSaveChat(payload())
      onSaved('Assistant configured.')
    } catch (e) {
      setError(errMsg(e as Error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="text-left">
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => pickPreset(p.id)}
            className={`rounded-md border px-3 py-2 text-left text-[12px] transition-colors ${
              preset === p.id
                ? 'border-blue-400 bg-blue-50 font-medium text-slate-800'
                : 'border-slate-200 text-slate-600 hover:bg-slate-100'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <label className="mt-3 block text-[11px] font-medium text-slate-500">
        API base URL
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://provider.example/v1"
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
        />
      </label>
      <label className="mt-2 block text-[11px] font-medium text-slate-500">
        Model
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="provider model id"
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
        />
      </label>
      <label className="mt-2 block text-[11px] font-medium text-slate-500">
        API key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            initial.keyTail ? `saved (••••${initial.keyTail}) — leave blank to keep` : initial.configured ? 'saved — leave blank to keep' : 'paste the API key'
          }
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1.5 text-[13px] text-slate-800"
        />
      </label>
      <div className="mt-1 text-[10px] text-slate-400">
        Stored locally in backend/.env — never sent anywhere except your chosen provider.
      </div>

      {test && (
        <div className={`mt-2 rounded px-2.5 py-1.5 text-[11px] ${test.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
          {test.ok ? '✓ ' : '✕ '}
          {test.msg}
        </div>
      )}
      {error && <div className="mt-2 rounded bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">{error}</div>}

      <div className="mt-4 flex items-center justify-between">
        <button
          onClick={runTest}
          disabled={busy || !baseUrl.trim() || !model.trim()}
          className="rounded border border-slate-300 px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        >
          {busy ? '…' : 'Test connection'}
        </button>
        <button
          onClick={save}
          disabled={busy || !baseUrl.trim() || !model.trim()}
          className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  )
}
