import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errMsg, type EmailSettings } from '../api'
import Modal, { fieldInput, fieldLabel, ghostBtn, primaryBtn } from './Modal'

// Email delivery configuration (AgentMail or plain SMTP) for shopping-list
// emails and the weekly Monday-08:00 digest. Saved to backend/.env and
// applied live — no restart. Secrets are stored server-side and never
// echoed back: only last-4 tails.
export default function EmailSettingsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['email-settings'], queryFn: api.emailSettings })
  const [provider, setProvider] = useState<'agentmail' | 'smtp' | 'none' | null>(null)
  const [recipient, setRecipient] = useState('')
  const [digestEnabled, setDigestEnabled] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [inbox, setInbox] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [secure, setSecure] = useState(false)
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [from, setFrom] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)

  // prefill once the saved status arrives
  useEffect(() => {
    if (initialized || !status) return
    setInitialized(true)
    setProvider(status.provider ?? 'none')
    setRecipient(status.recipient ?? '')
    setDigestEnabled(status.digestEnabled)
    setInbox(status.inbox ?? '')
    if (status.smtp) {
      setHost(status.smtp.host)
      setPort(String(status.smtp.port))
      setSecure(status.smtp.secure)
      setUser(status.smtp.user)
      setFrom(status.smtp.from)
    }
  }, [status, initialized])

  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.saveEmailSettings(b),
    onSuccess: (s: EmailSettings) => {
      qc.setQueryData(['email-settings'], s)
      setError(null)
      setNotice('Saved — active immediately, no restart needed.')
      setApiKey('')
      setPass('')
    },
    onError: (e: Error) => {
      setNotice(null)
      setError(errMsg(e))
    },
  })

  const test = useMutation({
    mutationFn: () => api.testEmail(),
    onSuccess: (r) => {
      setError(null)
      setNotice(`Test email sent via ${r.channel} to ${r.to}.`)
    },
    onError: (e: Error) => {
      setNotice(null)
      setError(errMsg(e))
    },
  })

  const submit = () => {
    setNotice(null)
    setError(null)
    if (provider === null) return
    save.mutate({
      provider,
      recipient,
      digestEnabled,
      agentmailApiKey: apiKey ? apiKey : undefined,
      agentmailInbox: inbox,
      smtpHost: host,
      smtpPort: Number(port) || 587,
      smtpSecure: secure,
      smtpUser: user,
      smtpPass: pass ? pass : undefined,
      smtpFrom: from,
    })
  }

  const configured = status?.provider != null

  return (
    <Modal title="Email & digest" onClose={onClose} width={520}>
      <p className="mb-4 text-[12px] leading-relaxed text-slate-500">
        Used for <strong>shopping-list emails</strong> and the <strong>weekly digest</strong> (Mondays 08:00: Ready to
        Assign, overspending, upcoming bills, unusual charges). Pick a delivery channel — a hosted{' '}
        <span className="font-medium">AgentMail</span> inbox or any <span className="font-medium">SMTP</span> server
        (e.g. your mail provider with an app password).
      </p>

      <div className="mb-3 flex gap-2">
        {(['agentmail', 'smtp', 'none'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setProvider(p)}
            aria-pressed={provider === p}
            className={`flex-1 rounded-md border px-3 py-2 text-[12px] font-medium transition-colors ${
              provider === p ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {p === 'agentmail' ? 'AgentMail' : p === 'smtp' ? 'SMTP' : 'Off'}
          </button>
        ))}
      </div>
      {configured && (
        <div className="mb-3 rounded bg-blue-50 px-2.5 py-1.5 text-[11px] text-blue-700">
          Currently configured: {status!.provider}
          {status!.recipient ? ` → ${status!.recipient}` : ''}
          {status!.agentKeyTail ? ` · key …${status!.agentKeyTail}` : ''}
        </div>
      )}

      {provider === 'agentmail' && (
        <div className="mb-3 flex flex-col gap-3">
          <label className="block">
            <span className={fieldLabel}>API key {status?.agentKeyTail && <span className="normal-case">(saved: …{status.agentKeyTail})</span>}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status?.agentKeyTail ? 'Leave blank to keep the saved key' : 'Paste your AgentMail API key'}
              className={fieldInput}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>Inbox</span>
            <input value={inbox} onChange={(e) => setInbox(e.target.value)} placeholder="your-inbox" className={fieldInput} />
          </label>
        </div>
      )}

      {provider === 'smtp' && (
        <div className="mb-3 flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <label className="block">
              <span className={fieldLabel}>Host</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.gmail.com" className={fieldInput} />
            </label>
            <label className="block">
              <span className={fieldLabel}>Port</span>
              <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className={`${fieldInput} tnum`} />
            </label>
          </div>
          <label className="block">
            <span className={fieldLabel}>Username</span>
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="usually your email address" className={fieldInput} />
          </label>
          <label className="block">
            <span className={fieldLabel}>Password {status?.smtp?.passTail && <span className="normal-case">(saved: …{status.smtp.passTail})</span>}</span>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder={status?.smtp?.passTail ? 'Leave blank to keep the saved password' : 'App password'}
              className={fieldInput}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>From (optional)</span>
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="defaults to the username" className={fieldInput} />
          </label>
          <label className="flex items-center gap-2 text-[13px] text-slate-600">
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} className="accent-blue-600" />
            Use TLS on connect (port 465) — otherwise STARTTLS is negotiated
          </label>
        </div>
      )}

      {provider !== null && (
        <>
          <label className="mb-3 block">
            <span className={fieldLabel}>Send emails to</span>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="you@example.com"
              inputMode="email"
              className={fieldInput}
            />
          </label>
          <label className="mb-1 flex items-center gap-2 text-[13px] text-slate-600">
            <input type="checkbox" checked={digestEnabled} onChange={(e) => setDigestEnabled(e.target.checked)} className="accent-blue-600" />
            Weekly digest — Mondays at 08:00
          </label>
        </>
      )}

      {notice && <div className="mt-3 rounded bg-emerald-50 px-2.5 py-1.5 text-[12px] text-emerald-700">{notice}</div>}
      {error && <div className="mt-3 rounded bg-red-50 px-2.5 py-1.5 text-[12px] text-red-600">{error}</div>}

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => test.mutate()}
          disabled={!configured || test.isPending}
          className={ghostBtn}
          title={configured ? 'Send a test email to the saved recipient' : 'Save a provider first'}
        >
          {test.isPending ? 'Sending…' : 'Send test email'}
        </button>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>
            Close
          </button>
          <button type="button" onClick={submit} disabled={provider === null || save.isPending} className={primaryBtn}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
