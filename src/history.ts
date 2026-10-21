import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm/types'
import { resolveApiProxy } from './apiproxy.js'

export interface LastTurn {
  userText?: string
  assistantText?: string
}

type ApiFn = (req: { rpcId: string; payload: unknown }) => Promise<unknown>

function unwrap<T>(res: unknown): T | undefined {
  const r = res as { result?: { ok?: boolean; value?: T; error?: { message?: string } } } | undefined
  if (r?.result?.ok === true) return r.result.value
  return undefined
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as ContentBlock[])
    .filter((block): block is TextBlock => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

type LooseEvent = {
  type?: string
  data?: {
    source?: { kind?: string }
    content?: unknown
    message?: { content?: unknown; source?: { kind?: string } }
    text?: string
  }
}

/** Extract the latest human Q + assistant A from a session event list. */
export function extractLastTurn(events: readonly LooseEvent[]): LastTurn {
  let lastUser: string | undefined
  let lastAssistant: string | undefined

  for (const ev of events) {
    if (ev.type === 'user/message') {
      const sourceKind = ev.data?.source?.kind ?? ev.data?.message?.source?.kind
      // Prefer real human prompts; skip plugin-injected context noise.
      if (sourceKind && sourceKind !== 'user') continue
      const text = contentToText(ev.data?.content ?? ev.data?.message?.content)
      if (text) {
        lastUser = text
        // New user turn resets prior assistant for pairing.
        lastAssistant = undefined
      }
      continue
    }
    if (ev.type === 'assistant/message') {
      const text = contentToText(ev.data?.message?.content ?? ev.data?.content)
      if (text) lastAssistant = text
      continue
    }
    if (ev.type === 'compaction/summary') {
      const text = typeof ev.data?.text === 'string' ? ev.data.text.trim() : ''
      if (text && !lastAssistant) lastAssistant = `(сводка) ${text}`
    }
  }

  return { userText: lastUser, assistantText: lastAssistant }
}

export function formatLastTurn(turn: LastTurn, maxEach = 3500): string {
  if (!turn.userText && !turn.assistantText) {
    return 'Прошлых вопросов нет (сессия пуста или не было ходов пользователя).'
  }
  const clip = (s: string) => {
    const chars = [...s]
    if (chars.length <= maxEach) return s
    return `${chars.slice(0, maxEach - 1).join('')}…`
  }
  const parts: string[] = ['— прошлый диалог —']
  if (turn.userText) {
    parts.push('', '【Вы】', clip(turn.userText))
  }
  if (turn.assistantText) {
    parts.push('', '【Ассистент】', clip(turn.assistantText))
  }
  return parts.join('\n')
}

async function historyViaApi(ctx: Context, sessionId: string): Promise<LooseEvent[] | undefined> {
  const api = resolveApiProxy(ctx)
  const history = api?.sessions?.history as ApiFn | undefined
  if (typeof history !== 'function') return undefined
  const raw = await history({
    rpcId: randomUUID(),
    payload: { sessionId, maxMessages: 8 },
  })
  const value = unwrap<{ events: Array<{ event?: LooseEvent } | LooseEvent> }>(raw)
  if (!value?.events) return undefined
  return value.events.map((entry) => {
    if (entry && typeof entry === 'object' && 'event' in entry && entry.event) {
      return entry.event
    }
    return entry as LooseEvent
  })
}

function historyViaAgent(agent: Agent | undefined): LooseEvent[] | undefined {
  const events = (agent as { session?: { events?: readonly LooseEvent[] } } | undefined)?.session?.events
  if (!events || events.length === 0) return undefined
  return [...events]
}

/** Load last Q/A for a bound session (apiProxy history, else live agent events). */
export async function loadLastTurn(
  ctx: Context,
  sessionId: string,
  agent?: Agent,
): Promise<LastTurn> {
  let events: LooseEvent[] | undefined
  try {
    events = await historyViaApi(ctx, sessionId)
  } catch {
    events = undefined
  }
  if (!events || events.length === 0) {
    events = historyViaAgent(agent)
  }
  if (!events || events.length === 0) return {}
  return extractLastTurn(events)
}
