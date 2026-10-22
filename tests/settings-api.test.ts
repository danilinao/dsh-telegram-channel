import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  SETTINGS_INFO_PATH,
  SETTINGS_RESOLVE_PATH,
  createSettingsApi,
  type SettingsInfo,
} from '../src/settings-api.ts'

/** Minimal response double: records status, headers and body. */
function makeRes(): ServerResponse & { bodyText: string; headers: Record<string, string>; json: () => any } {
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value)
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') body += chunk
    },
    headers,
    get bodyText() {
      return body
    },
    json() {
      return JSON.parse(body)
    },
  }
  return res as unknown as ServerResponse & { bodyText: string; headers: Record<string, string>; json: () => any }
}

/** Minimal request double with an optional JSON body. */
function makeReq(
  method: string,
  headers: Record<string, string> = {},
  body?: string,
): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  return Object.assign(stream, { method, headers }) as unknown as IncomingMessage
}

const info: SettingsInfo = {
  ok: true,
  running: true,
  tokenSet: true,
  bot: { id: 42, username: 'dsh_lex1133_bot', name: 'DSH' },
  allowAllUsers: false,
  users: [{ id: 333041652, name: 'Алексей', enabled: true }],
  people: [{ id: 333041652, name: 'Алексей', username: 'danilinao', at: 1 }],
  bindings: [],
}

function api(overrides: Partial<Parameters<typeof createSettingsApi>[0]> = {}) {
  const warnings: string[] = []
  return {
    warnings,
    handlers: createSettingsApi({
      describe: async () => info,
      resolve: async (query: string) => ({ id: 7, name: query }),
      logger: { warn: (message: string) => warnings.push(message) },
      ...overrides,
    }),
  }
}

test('route paths live under the package prefix', () => {
  assert.equal(SETTINGS_INFO_PATH, '/plugins/dsh-telegram-channel-ru/settings/info')
  assert.equal(SETTINGS_RESOLVE_PATH, '/plugins/dsh-telegram-channel-ru/settings/resolve')
})

test('info answers GET with the payload and a no-store header', async () => {
  const { handlers } = api()
  const res = makeRes()
  await handlers.info(makeReq('GET'), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.json().bot.username, 'dsh_lex1133_bot')
  assert.equal(res.json().users[0].id, 333041652)
})

test('info answers HEAD without a body', async () => {
  const { handlers } = api()
  const res = makeRes()
  await handlers.info(makeReq('HEAD'), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.bodyText, '')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
})

test('info refuses a write method', async () => {
  const { handlers } = api()
  const res = makeRes()
  await handlers.info(makeReq('POST'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
})

test('info turns a broken description into a 500 without leaking it', async () => {
  const { handlers, warnings } = api({
    describe: async () => {
      throw new Error('boom with 123:secret')
    },
  })
  const res = makeRes()
  await handlers.info(makeReq('GET'), res)
  assert.equal(res.statusCode, 500)
  assert.equal(res.json().ok, false)
  assert.equal(warnings.length, 1)
})

test('resolve answers a POST that names the same origin', async () => {
  const { handlers } = api()
  const res = makeRes()
  await handlers.resolve(
    makeReq('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, JSON.stringify({ query: '@danilinao' })),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, user: { id: 7, name: '@danilinao' } })
})

test('resolve accepts a request with no Origin at all (curl, tests)', async () => {
  const { handlers } = api()
  const res = makeRes()
  await handlers.resolve(
    makeReq('POST', { host: '127.0.0.1:3080' }, JSON.stringify({ query: '333041652' })),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
})

test('resolve refuses another origin', async () => {
  const { handlers } = api()
  const res = makeRes()
  await handlers.resolve(
    makeReq('POST', { host: '127.0.0.1:3080', origin: 'https://evil.example' }, JSON.stringify({ query: '@x' })),
    res,
  )
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().ok, false)
})

test('resolve refuses a GET', async () => {
  const { handlers } = api()
  const res = makeRes()
  await handlers.resolve(makeReq('GET'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('resolve requires a query and reports Telegram failures as data', async () => {
  const { handlers } = api()
  const empty = makeRes()
  await handlers.resolve(makeReq('POST', {}, JSON.stringify({})), empty)
  assert.equal(empty.statusCode, 400)
  assert.match(empty.json().error, /username|id/)

  const failing = api({
    resolve: async () => {
      throw new Error('Bad Request: chat not found')
    },
  })
  const res = makeRes()
  await failing.handlers.resolve(makeReq('POST', {}, JSON.stringify({ query: '@nobody' })), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: false, error: 'Bad Request: chat not found' })
  assert.equal(failing.warnings.length, 1)
})

test('resolve refuses a malformed or oversized body', async () => {
  const { handlers } = api()
  const malformed = makeRes()
  await handlers.resolve(makeReq('POST', {}, 'not json'), malformed)
  assert.equal(malformed.json().ok, false)
  assert.match(malformed.json().error, /JSON/)

  const oversized = makeRes()
  await handlers.resolve(makeReq('POST', {}, JSON.stringify({ query: 'x'.repeat(5000) })), oversized)
  assert.equal(oversized.json().ok, false)
  assert.match(oversized.json().error, /большое/)
})
