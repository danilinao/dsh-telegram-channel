import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TelegramBridge } from '../src/bridge.ts'
import type { TelegramClientLike, TelegramUpdate } from '../src/client.ts'
import { MSG } from '../src/commands.ts'
import { resolveConfig } from '../src/config.ts'

// Two people on one bot: each has their own chat, both are authorized, a third
// person is refused. The catalog falls back to the DSH store, so isolate it.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'tg-multiuser-test-'))
process.env.DSH_HOME = TEST_HOME
process.env.DSH_TELEGRAM_BINDINGS_FILE = join(TEST_HOME, 'bindings.json')
process.on('exit', () => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch {}
})

/** A live config reference, the shape DSH hands a `.volatile()` field. */
function box<T>(value: T): { get: () => T } {
  return { get: () => value }
}

/** Context double: these tests never start polling, so only the logger is used. */
function fakeContext(): Context {
  return {
    logger: { info() {}, warn() {}, error() {} },
    on() {
      return () => {}
    },
  } as unknown as Context
}

function messageUpdate(chatId: number, userId: number, text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: userId, first_name: `Person ${userId}` },
      text,
    },
  }
}

function fakeClient(sent: Array<{ chatId: number; text: string }>): TelegramClientLike {
  return {
    getMe: async () => ({ id: 42, username: 'test_bot', first_name: 'Test bot' }),
    getChat: async (chatId) => {
      const handle = typeof chatId === 'string' && chatId.startsWith('@') ? chatId.slice(1) : ''
      const id = handle.length > 0 ? 77 : Number(chatId)
      return {
        id,
        type: 'private',
        first_name: handle.length > 0 ? 'Anna' : `Person ${String(id)}`,
        ...(handle.length > 0 ? { username: handle } : {}),
      }
    },
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text })
      return { message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, text }
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

/** A bridge over the given config with a client double; polling never starts. */
function bridgeFor(created: { sent: Array<{ chatId: number; text: string }> }, config: Parameters<typeof resolveConfig>[0]): TelegramBridge {
  const resolved = resolveConfig(config, {} as NodeJS.ProcessEnv)
  return new TelegramBridge(fakeContext(), {
    token: resolved.token,
    allowedUserIds: resolved.effectiveUserIds,
    allowAllUsers: resolved.allowAllUsers,
    users: resolved.users,
    client: fakeClient(created.sent),
  })
}

test('resolved users keep both people and drop the disabled one', () => {
  const resolved = resolveConfig({
    token: box('123:abc'),
    users: box([
      { id: 10, name: 'Аня' },
      { id: 11, name: 'Боря', enabled: false },
      { id: 12 },
    ]),
  })
  assert.deepEqual(resolved.effectiveUserIds, [10, 12])
  assert.deepEqual(resolved.users.map((user) => user.name ?? ''), ['Аня', 'Боря', ''])
})

test('both allowlisted people may talk; a stranger is refused', async () => {
  const created = { sent: [] as Array<{ chatId: number; text: string }> }
  const bridge = bridgeFor(created, { token: '123:abc', users: [{ id: 10, name: 'Аня' }, { id: 12 }] })
  await bridge.processUpdate(messageUpdate(10, 10, '/help'))
  await bridge.processUpdate(messageUpdate(12, 12, '/help'))
  await bridge.processUpdate(messageUpdate(99, 99, '/help'))
  assert.deepEqual(created.sent.map((message) => message.chatId), [10, 12, 99])
  assert.notEqual(created.sent[0].text, MSG.DENIED)
  assert.notEqual(created.sent[1].text, MSG.DENIED)
  assert.equal(created.sent[2].text, MSG.DENIED)
})

test('a disabled person is refused', async () => {
  const created = { sent: [] as Array<{ chatId: number; text: string }> }
  const bridge = bridgeFor(created, { token: '123:abc', users: [{ id: 10 }, { id: 12, enabled: false }] })
  await bridge.processUpdate(messageUpdate(12, 12, '/help'))
  assert.deepEqual(created.sent, [{ chatId: 12, text: MSG.DENIED }])
})

test('describeSettings reports the allowlist, the bot and the people it has seen', async () => {
  const created = { sent: [] as Array<{ chatId: number; text: string }> }
  const bridge = bridgeFor(created, { token: '123:abc', users: [{ id: 10, name: 'Аня' }, { id: 12 }] })
  await bridge.processUpdate(messageUpdate(10, 10, '/help'))
  const info = await bridge.describeSettings()

  assert.equal(info.tokenSet, true)
  assert.deepEqual(info.bot, { id: 42, username: 'test_bot', name: 'Test bot' })
  assert.equal(info.allowAllUsers, false)
  assert.deepEqual(info.users.map((user) => user.id), [10, 12])
  // The label from the config wins over the Telegram name; the second person is
  // named from `getChat`, since they never wrote to the bot here.
  assert.equal(info.users[0].name, 'Аня')
  assert.equal(info.users[1].name, 'Person 12')
})

test('the allowlist and the seen people survive in the state file', async () => {
  const created = { sent: [] as Array<{ chatId: number; text: string }> }
  const bridge = bridgeFor(created, { token: '123:abc', users: [{ id: 10, name: 'Аня' }] })
  await bridge.processUpdate(messageUpdate(10, 10, '/help'))
  const saved = JSON.parse(readFileSync(process.env.DSH_TELEGRAM_BINDINGS_FILE as string, 'utf8')) as {
    people?: Record<string, { name?: string }>
    knownChats?: number[]
  }
  assert.equal(saved.people?.['10']?.name, 'Person 10')
  assert.deepEqual(saved.knownChats, [10])
})

test('resolvePerson resolves an @username through getChat', async () => {
  const created = { sent: [] as Array<{ chatId: number; text: string }> }
  const bridge = bridgeFor(created, { token: '123:abc', users: [{ id: 10 }] })
  assert.deepEqual(await bridge.resolvePerson('@anna'), { id: 77, name: 'Anna', username: 'anna' })
  assert.deepEqual(await bridge.resolvePerson('10'), { id: 10, name: 'Person 10' })
})
