import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TelegramBridge } from '../src/bridge.ts'
import type { InlineKeyboardMarkup, TelegramClientLike, TelegramUpdate } from '../src/client.ts'
import { BIND_CB_PREFIX, MSG } from '../src/commands.ts'

// The model's reasoning must reach the chat as a spoiler by default, and
// `/reasoning off` must silence it per chat. The catalog falls back to the DSH
// store, so every test points DSH_HOME at an empty directory.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'tg-reasoning-test-'))
process.env.DSH_HOME = TEST_HOME
process.env.DSH_TELEGRAM_BINDINGS_FILE = join(TEST_HOME, 'bindings.json')

/** Per-test state file: a preference saved by one case must not reach another. */
function freshStateFile(name: string): void {
  process.env.DSH_TELEGRAM_BINDINGS_FILE = join(TEST_HOME, `${name}.json`)
}
process.on('exit', () => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch {}
})

type SentMessage = { chatId: number; text: string; parseMode?: string; replyMarkup?: InlineKeyboardMarkup }

function fakeClient(sent: SentMessage[]): TelegramClientLike {
  return {
    getMe: async () => ({ id: 1 }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text, parseMode, replyMarkup) => {
      sent.push({ chatId, text, parseMode, replyMarkup })
      return { message_id: sent.length, date: 0, chat: { id: chatId, type: 'private' }, text }
    },
    sendChatAction: async () => true,
    answerCallbackQuery: async () => true,
    setMyCommands: async () => true,
    setMyDescription: async () => true,
    setMyShortDescription: async () => true,
    getFile: async (fileId: string) => ({ file_id: fileId, file_unique_id: fileId }),
    downloadFile: async () => new Uint8Array(),
  }
}

function makeAgent(id: string) {
  return {
    id: SessionId(id),
    session: { header: { cwd: `/proj/${id}` }, meta: { cwd: `/proj/${id}` }, events: [] },
    followup() {},
  }
}

/** Bind chat 10 to a live session and hand back the session/event listener. */
async function boundBridge(
  t: { after: (fn: () => Promise<void> | void) => void },
  sent: SentMessage[],
  sessionId: string,
): Promise<{
  bridge: TelegramBridge
  emit: (event: unknown) => Promise<void>
  stateFile: string
}> {
  const agent = makeAgent(sessionId)
  let listener: ((session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) | undefined
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === sessionId ? agent : undefined),
    },
    on(event: string, handler: typeof listener) {
      if (event === 'session/event') listener = handler
      return () => {}
    },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  bridge.start()
  const update: TelegramUpdate = {
    update_id: 2,
    callback_query: {
      id: 'cq1',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' }, text: 'picker' },
      data: `${BIND_CB_PREFIX}${sessionId}`,
    },
  }
  await bridge.processUpdate(update)
  assert.ok(sent.some((message) => message.text.startsWith('Сессия привязана')), 'bind confirmation')
  const emit = async (event: unknown): Promise<void> => {
    listener?.({ id: SessionId(sessionId) }, event)
    // onSessionEvent is fire-and-forget; give its awaits a tick to finish.
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  // Always stop the poll loop, even when an assertion throws: a live bridge
  // keeps timers open and the test runner would wait for the loop to drain.
  t.after(async () => {
    await bridge.stop()
  })
  return { bridge, emit, stateFile: process.env.DSH_TELEGRAM_BINDINGS_FILE as string }
}

function assistantMessage(reasoning: string | undefined, text: string): unknown {
  const content: Array<Record<string, string>> = []
  if (reasoning !== undefined) content.push({ type: 'reasoning', text: reasoning })
  if (text.length > 0) content.push({ type: 'text', text })
  return {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content } },
  }
}

test('reasoning arrives as an expandable spoiler before the answer', async (t) => {
  freshStateFile('spoiler')
  const sent: SentMessage[] = []
  const { emit } = await boundBridge(t, sent, 'live-r1')
  sent.length = 0
  await emit(assistantMessage('Сначала проверю файл, потом отвечу.', 'Готово.'))
  assert.equal(sent.length, 2, 'reasoning spoiler + answer')
  const spoiler = sent[0]!.text
  assert.match(spoiler, /<blockquote expandable>/)
  assert.match(spoiler, /🧠 Рассуждения/)
  assert.match(spoiler, /Сначала проверю файл, потом отвечу\./)
  assert.match(spoiler, /<pre>/)
  assert.equal(sent[1]!.text, 'Готово.')
})

test('a message with reasoning but no text still shows the reasoning', async (t) => {
  freshStateFile('reasoning-only')
  const sent: SentMessage[] = []
  const { emit } = await boundBridge(t, sent, 'live-r2')
  sent.length = 0
  await emit(assistantMessage('Только думаю, без ответа.', ''))
  assert.equal(sent.length, 1)
  assert.match(sent[0]!.text, /Только думаю, без ответа\./)
})

test('/reasoning off silences the spoiler but keeps the answer', async (t) => {
  freshStateFile('off')
  const sent: SentMessage[] = []
  const { bridge, emit } = await boundBridge(t, sent, 'live-r3')
  await bridge.processUpdate({ update_id: 3, message: { message_id: 3, date: 0, chat: { id: 10, type: 'private' }, from: { id: 1 }, text: '/reasoning off' } })
  assert.equal(sent.at(-1)!.text, MSG.REASONING_SET(false))
  sent.length = 0
  await emit(assistantMessage('Это не должно прийти.', 'Ответ на месте.'))
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.text, 'Ответ на месте.')
  const saved = JSON.parse(readFileSync(process.env.DSH_TELEGRAM_BINDINGS_FILE as string, 'utf8')) as {
    reasoningPrefs?: Record<string, string>
  }
  assert.equal(saved.reasoningPrefs?.['10'], 'off', 'the choice is persisted')
})

test('/reasoning reports the state and accepts on again', async (t) => {
  freshStateFile('state')
  const sent: SentMessage[] = []
  const { bridge, emit } = await boundBridge(t, sent, 'live-r4')
  await bridge.processUpdate({ update_id: 4, message: { message_id: 4, date: 0, chat: { id: 10, type: 'private' }, from: { id: 1 }, text: '/reasoning' } })
  assert.equal(sent.at(-1)!.text, MSG.REASONING_STATE(true))
  await bridge.processUpdate({ update_id: 5, message: { message_id: 5, date: 0, chat: { id: 10, type: 'private' }, from: { id: 1 }, text: '/reasoning off' } })
  await bridge.processUpdate({ update_id: 6, message: { message_id: 6, date: 0, chat: { id: 10, type: 'private' }, from: { id: 1 }, text: '/reasoning on' } })
  assert.equal(sent.at(-1)!.text, MSG.REASONING_SET(true))
  sent.length = 0
  await emit(assistantMessage('Рассуждаю снова.', 'Ок.'))
  assert.match(sent[0]!.text, /Рассуждаю снова\./)
})

test('a streamed reasoning prefix is flushed on step/end (fallback path)', async (t) => {
  freshStateFile('stream')
  const sent: SentMessage[] = []
  const { emit } = await boundBridge(t, sent, 'live-r5')
  sent.length = 0
  await emit({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning', block: { type: 'reasoning' }, text: 'поток рассуждений' } },
  })
  // The "Думаю…" notice comes from the same path; the spoiler follows step/end.
  await emit({ type: 'step/end', data: { turn: 1, step: 1 } })
  const spoiler = sent.find((message) => message.text.includes('🧠 Рассуждения'))
  assert.ok(spoiler, 'streamed reasoning became a spoiler')
  assert.match(spoiler!.text, /поток рассуждений/)
})

test('reasoning is not duplicated when both a stream prefix and the message carry it', async (t) => {
  freshStateFile('dedupe')
  const sent: SentMessage[] = []
  const { emit } = await boundBridge(t, sent, 'live-r6')
  sent.length = 0
  await emit({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning', block: { type: 'reasoning' }, text: 'префикс' } },
  })
  await emit(assistantMessage('полный текст рассуждения', 'Ответ.'))
  // The durable message's reasoning wins; the streamed prefix must not repeat.
  const spoilers = sent.filter((message) => message.text.includes('🧠 Рассуждения'))
  assert.equal(spoilers.length, 1)
  assert.match(spoilers[0]!.text, /полный текст рассуждения/)
  assert.doesNotMatch(spoilers[0]!.text, /префикс/)
})
