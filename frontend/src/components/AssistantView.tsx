import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChatMsg } from '../api'
import { api, errMsg } from '../api'

// Assistant — AI chat over the budget. Sessions persist server-side; deleting
// a session removes its messages for good.

function SessionRow({
  id,
  title,
  lastMessage,
  active,
  onPick,
  onDelete,
}: {
  id: string
  title: string
  lastMessage: string | null
  active: boolean
  onPick: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div
      className={`group flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 transition-colors ${
        active ? 'border-blue-400 bg-blue-50' : 'border-transparent hover:bg-slate-100'
      }`}
      onClick={() => onPick(id)}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-slate-700">{title}</div>
        {lastMessage && <div className="truncate text-[11px] text-slate-400">{lastMessage}</div>}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (window.confirm('Delete this chat and all its messages?')) onDelete(id)
        }}
        title="Delete chat"
        className="shrink-0 rounded px-1 text-slate-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
      >
        🗑
      </button>
    </div>
  )
}

function Bubble({ m }: { m: ChatMsg }) {
  const isUser = m.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg border px-3 py-2 text-[13px] leading-relaxed ${
          isUser
            ? 'whitespace-pre-wrap border-blue-300 bg-blue-50 text-slate-800'
            : 'border-slate-200 bg-panel text-slate-700'
        }`}
      >
        {isUser ? (
          m.content
        ) : (
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

const EXAMPLES = [
  'How much is left to assign this month?',
  'Which categories are overspent?',
  'What subscriptions are coming up?',
  'How does my spending compare to the budget?',
]

export default function AssistantView() {
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tools, setTools] = useState<{ name: string; summary: string }[]>([])
  const [listening, setListening] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const recRef = useRef<{ stop: () => void } | null>(null)

  const { data: status } = useQuery({ queryKey: ['chat-status'], queryFn: api.chatStatus })
  const { data: sessions } = useQuery({ queryKey: ['chat-sessions'], queryFn: api.chatSessions })
  const { data: messages } = useQuery({
    queryKey: ['chat-messages', activeId],
    queryFn: () => api.chatMessages(activeId!),
    enabled: !!activeId,
  })

  useEffect(() => {
    if (!activeId && sessions && sessions.length > 0) setActiveId(sessions[0].id)
  }, [sessions, activeId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['chat-sessions'] })
    if (activeId) qc.invalidateQueries({ queryKey: ['chat-messages', activeId] })
  }

  const newChat = useMutation({
    mutationFn: () => api.createChatSession(),
    onSuccess: (s) => {
      invalidate()
      setActiveId(s.id)
      setError(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })
  const del = useMutation({
    mutationFn: (id: string) => api.deleteChatSession(id),
    onSuccess: (_r, id) => {
      invalidate()
      if (activeId === id) setActiveId(null)
    },
    onError: (e: Error) => setError(errMsg(e)),
  })
  const send = useMutation({
    mutationFn: (content: string) => api.sendChatMessage(activeId!, content),
    onSuccess: (res) => {
      invalidate()
      // tool chips + budget refresh when the assistant actually changed things
      setTools(res.toolCalls ?? [])
      if (res.toolCalls?.length) {
        qc.invalidateQueries({ queryKey: ['budget'] })
        qc.invalidateQueries({ queryKey: ['month'] })
        qc.invalidateQueries({ queryKey: ['txns'] })
        qc.invalidateQueries({ queryKey: ['categories'] })
        qc.invalidateQueries({ queryKey: ['ops'] })
        qc.invalidateQueries({ queryKey: ['scheduled'] })
      }
    },
    onError: (e: Error) => setError(errMsg(e)),
  })

  // ---- voice dictation (Web Speech API; button hidden when unsupported) ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null
  const toggleMic = () => {
    if (!SR) return
    if (listening) {
      recRef.current?.stop()
      return
    }
    const rec = new SR()
    rec.lang = navigator.language || 'en-US'
    rec.interimResults = true
    rec.continuous = false
    const base = draft
    rec.onresult = (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      let txt = ''
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript
      setDraft((base ? base + ' ' : '') + txt)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    setListening(true)
    rec.start()
  }

  const submit = () => {
    const text = draft.trim()
    if (!text || !activeId || send.isPending) return
    setDraft('')
    setError(null)
    setTools([])
    send.mutate(text)
  }

  const active = sessions?.find((s) => s.id === activeId) ?? null
  const thread: ChatMsg[] = messages ?? []
  // optimistic user bubble while waiting for the reply
  const pendingUser: ChatMsg | null =
    send.isPending && draft === ''
      ? { id: '__pending__', role: 'user', content: send.variables ?? '', createdAt: '' }
      : null

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-panel px-6">
        <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">Assistant</h1>
        <div className="flex items-center gap-2">
          {active && <span className="text-[11px] text-slate-400">{active.model}</span>}
          <button
            onClick={() => newChat.mutate()}
            disabled={newChat.isPending}
            className="rounded bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            + New chat
          </button>
        </div>
      </div>

      {status && !status.configured && (
        <div className="mx-6 mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-600">
          AI chat is not configured. Set <code>CHAT_API_KEY</code> (or <code>CHAT_API_KEY_FILE</code>) in{' '}
          <code>backend/.env</code> and restart the backend.
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4 p-6">
        {/* sessions rail */}
        <div className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto">
          {(sessions ?? []).map((s) => (
            <SessionRow
              key={s.id}
              id={s.id}
              title={s.title}
              lastMessage={s.lastMessage}
              active={s.id === activeId}
              onPick={setActiveId}
              onDelete={(id) => del.mutate(id)}
            />
          ))}
          {sessions?.length === 0 && (
            <div className="rounded-md border border-slate-200 p-3 text-[12px] text-slate-400">
              No chats yet — start one with “+ New chat”.
            </div>
          )}
        </div>

        {/* thread */}
        <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-slate-200 bg-panel">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {thread.length === 0 && !pendingUser && (
              <div className="mt-8 text-center text-[13px] text-slate-400">
                Ask anything about your budget.
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => setDraft(ex)}
                      className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {thread.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
            {pendingUser && <Bubble m={pendingUser} />}
            {tools.length > 0 && (
              <div className="flex flex-wrap justify-start gap-1.5">
                {tools.map((t, i) => (
                  <span
                    key={i}
                    title={t.summary}
                    className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700"
                  >
                    ⚒ {t.name.replace(/_/g, ' ')} — {t.summary}
                  </span>
                ))}
              </div>
            )}
            {send.isPending && (
              <div className="flex justify-start">
                <div className="rounded-lg border border-slate-200 bg-panel px-3 py-2 text-[13px] text-slate-400">
                  thinking…
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="mx-4 mb-1 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
          )}

          <div className="border-t border-slate-200 p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                placeholder={activeId ? 'Ask about your budget… (Enter to send, Shift+Enter for newline)' : 'Create a chat first'}
                disabled={!activeId || send.isPending}
                rows={2}
                className="flex-1 resize-none rounded-md border border-slate-300 bg-panel px-2.5 py-1.5 text-[13px] text-slate-800 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-[3px] focus:ring-blue-500/35 disabled:opacity-50"
              />
              {SR && (
                <button
                  onClick={toggleMic}
                  disabled={!activeId || send.isPending}
                  title={listening ? 'Stop dictation' : 'Dictate (voice input)'}
                  className={`rounded px-3 py-2 text-[14px] transition-colors disabled:opacity-40 ${
                    listening
                      ? 'animate-pulse bg-red-500 text-white'
                      : 'border border-slate-300 bg-panel text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  🎙
                </button>
              )}
              <button
                onClick={submit}
                disabled={!activeId || !draft.trim() || send.isPending}
                className="rounded bg-accent px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
