import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, applyWith, inject } from '../src/index.ts'
import type { TelegramClientLike } from '../src/client.ts'
import type { RawTelegramChannelConfig } from '../src/config.ts'

// The catalog falls back to the on-disk DSH store, so point DSH_HOME at an
// empty directory: a developer's real sessions must never reach the assertions.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'tg-apply-test-'))
process.env.DSH_HOME = TEST_HOME
process.env.DSH_TELEGRAM_BINDINGS_FILE = join(TEST_HOME, 'bindings.json')
process.on('exit', () => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch {}
})

/** A live config reference, the shape DSH hands a `.volatile()` field. */
function box<T>(value: T): { get: () => T } {
  return { get: () => value }
}

interface FakeContext {
  ctx: any
  logs: string[]
  emit: (event: string) => void
  dispose: () => void
}

/**
 * Structural Cordis double: the plugin registers effects and one event
 * listener, and every effect body runs immediately (like a real fiber).
 */
function fakeContext(): FakeContext {
  const logs: string[] = []
  const disposers: Array<() => void> = []
  const listeners = new Map<string, Array<() => void>>()
  const ctx: any = {
    effect(fn: () => (() => void) | void) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on(event: string, handler: () => void) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    inject(_deps: string[], callback: (scoped: unknown) => void) {
      callback(ctx)
    },
    logger: {
      info(message: string) { logs.push(`info:${message}`) },
      warn(message: string) { logs.push(`warn:${message}`) },
      error(message: unknown) { logs.push(`error:${String(message)}`) },
    },
  }
  return {
    ctx,
    logs,
    emit(event: string) {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

/** A client double: never talks to Telegram, records which token it was made for. */
function fakeClientFactory(created: string[]): (token: string) => TelegramClientLike {
  return (token: string) => {
    created.push(token)
    return {
      getMe: async () => ({ id: 42, username: 'test_bot', first_name: 'Test' }),
      getUpdates: async () => [],
      sendMessage: async (chatId, text) => ({ message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, text }),
      sendChatAction: async () => true,
      answerCallbackQuery: async () => true,
      setMyCommands: async () => true,
      setMyDescription: async () => true,
      setMyShortDescription: async () => true,
      getFile: async (fileId: string) => ({ file_id: fileId, file_unique_id: fileId }),
      downloadFile: async () => new Uint8Array(),
    }
  }
}

/** Let queued microtasks and the coalescing timer run. */
async function settle(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('optional host services are not hard Cordis dependencies', () => {
  assert.deepEqual(inject, ['agents'])
})

test('apply without a token logs an error and never builds a client', () => {
  const previousToken = process.env.DSH_TELEGRAM_TOKEN
  const previousUsers = process.env.DSH_TELEGRAM_ALLOWED_USER_IDS
  delete process.env.DSH_TELEGRAM_TOKEN
  delete process.env.DSH_TELEGRAM_ALLOWED_USER_IDS
  const { ctx, logs, dispose } = fakeContext()
  const created: string[] = []
  try {
    applyWith(ctx, { token: '', allowedUserIds: [1] }, { clientFor: fakeClientFactory(created) })
    assert.deepEqual(created, [])
    assert.ok(logs.some((line) => line.startsWith('error:') && /missing bot token/.test(line)))
  } finally {
    dispose()
    if (previousToken !== undefined) process.env.DSH_TELEGRAM_TOKEN = previousToken
    else delete process.env.DSH_TELEGRAM_TOKEN
    if (previousUsers !== undefined) process.env.DSH_TELEGRAM_ALLOWED_USER_IDS = previousUsers
    else delete process.env.DSH_TELEGRAM_ALLOWED_USER_IDS
  }
})

test('apply with a token starts one bridge for that token', async () => {
  const { ctx, dispose } = fakeContext()
  const created: string[] = []
  try {
    applyWith(ctx, { token: '111:aaa', users: box([{ id: 5 }]) }, { clientFor: fakeClientFactory(created) })
    assert.deepEqual(created, ['111:aaa'])
  } finally {
    dispose()
    await settle()
  }
})

test('a live config write rebuilds the bridge with the new token', async () => {
  const { ctx, logs, emit, dispose } = fakeContext()
  const created: string[] = []
  const token = box('111:aaa')
  const users = box<Array<{ id: number }>>([{ id: 5 }])
  try {
    applyWith(ctx, { token, users }, { clientFor: fakeClientFactory(created), restartDelayMs: 0 })
    assert.deepEqual(created, ['111:aaa'])

    // The loader updates the box in place, then announces the changed paths.
    token.get = () => '222:bbb'
    emit('loader/volatile-update')
    await settle()

    assert.deepEqual(created, ['111:aaa', '222:bbb'])
    assert.ok(logs.some((line) => /settings applied without a restart/.test(line)))
  } finally {
    dispose()
    await settle()
  }
})

test('an unchanged volatile field does not restart the bridge', async () => {
  const { ctx, emit, dispose } = fakeContext()
  const created: string[] = []
  const token = box('111:aaa')
  try {
    applyWith(ctx, { token }, { clientFor: fakeClientFactory(created), restartDelayMs: 0 })
    emit('loader/volatile-update')
    await settle()
    assert.deepEqual(created, ['111:aaa'])
  } finally {
    dispose()
    await settle()
  }
})

test('a removed token stops polling instead of crashing', async () => {
  const { ctx, logs, emit, dispose } = fakeContext()
  const created: string[] = []
  const token = box('111:aaa')
  try {
    applyWith(ctx, { token }, { clientFor: fakeClientFactory(created), restartDelayMs: 0 })
    token.get = () => ''
    emit('loader/volatile-update')
    await settle()
    assert.deepEqual(created, ['111:aaa'])
    assert.ok(logs.some((line) => line.startsWith('error:') && /missing bot token/.test(line)))
  } finally {
    dispose()
    await settle()
  }
})

test('disposing the plugin stops the bridge', async () => {
  const { ctx, dispose } = fakeContext()
  const created: string[] = []
  applyWith(ctx, { token: '333:ccc' }, { clientFor: fakeClientFactory(created) })
  dispose()
  await settle()
  assert.deepEqual(created, ['333:ccc'])
})

test('apply works through the plain plugin entry too', () => {
  const { ctx, dispose } = fakeContext()
  const previousToken = process.env.DSH_TELEGRAM_TOKEN
  delete process.env.DSH_TELEGRAM_TOKEN
  try {
    assert.doesNotThrow(() => apply(ctx, { token: '', allowedUserIds: [1] } as RawTelegramChannelConfig))
  } finally {
    dispose()
    if (previousToken !== undefined) process.env.DSH_TELEGRAM_TOKEN = previousToken
    else delete process.env.DSH_TELEGRAM_TOKEN
  }
})
