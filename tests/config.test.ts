import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configSignature,
  enabledUserIds,
  envUserIds,
  normalizeUserIds,
  normalizeUsers,
  readVolatile,
  resolveConfig,
  resolveEffectiveUserIds,
} from '../src/config.ts'

/** A live config reference, the shape DSH hands a `.volatile()` field. */
function box<T>(value: T): { get: () => T } {
  return { get: () => value }
}

test('readVolatile unwraps a live box but leaves plain values alone', () => {
  assert.equal(readVolatile(box('abc')), 'abc')
  assert.equal(readVolatile('abc'), 'abc')
  assert.deepEqual(readVolatile([1, 2]), [1, 2])
  assert.equal(readVolatile(undefined), undefined)
})

test('normalizeUsers drops junk, keeps the first duplicate and defaults enabled', () => {
  const users = normalizeUsers([
    { id: 10, name: '  Лёша  ' },
    { id: '11', enabled: false },
    { id: 10, name: 'дубль' },
    { id: -3 },
    { id: 0 },
    { id: 12 },
    { notAUser: true },
    { id: 13, enabled: true },
  ])
  assert.deepEqual(users, [
    { id: 10, name: 'Лёша', enabled: true },
    { id: 11, enabled: false },
    { id: 12, enabled: true },
    { id: 13, enabled: true },
  ])
  assert.deepEqual(enabledUserIds(users), [10, 12, 13])
})

test('normalizeUsers accepts bare numbers from hand-written YAML', () => {
  assert.deepEqual(normalizeUsers([5, '6']), [
    { id: 5, enabled: true },
    { id: 6, enabled: true },
  ])
  assert.deepEqual(normalizeUsers(undefined), [])
  assert.deepEqual(normalizeUsers('nope'), [])
})

test('normalizeUserIds accepts numbers and numeric strings', () => {
  assert.deepEqual(normalizeUserIds([1, '2', 2, -1, 0, Number.NaN]), [1, 2])
  assert.deepEqual(normalizeUserIds(undefined), [])
})

test('envUserIds splits the environment fallback list', () => {
  assert.deepEqual(envUserIds({ DSH_TELEGRAM_ALLOWED_USER_IDS: '1, 2;3 4' } as NodeJS.ProcessEnv), [1, 2, 3, 4])
  assert.deepEqual(envUserIds({} as NodeJS.ProcessEnv), [])
})

test('the GUI user list wins over the legacy flat list and the environment', () => {
  const env = { DSH_TELEGRAM_ALLOWED_USER_IDS: '99' } as NodeJS.ProcessEnv
  assert.deepEqual(
    resolveEffectiveUserIds([{ id: 1 }, { id: 2, enabled: false }], [7, 8], env),
    [1],
  )
  // An empty user list falls back to the legacy list, then to the environment.
  assert.deepEqual(resolveEffectiveUserIds([], [7, 8], env), [7, 8])
  assert.deepEqual(resolveEffectiveUserIds([], [], env), [99])
  // A user list whose entries are all disabled authorizes nobody, even though
  // the legacy list would have allowed someone.
  assert.deepEqual(resolveEffectiveUserIds([{ id: 3, enabled: false }], [7], env), [])
})

test('resolveConfig unwraps every volatile field and applies the defaults', () => {
  const env = { DSH_TELEGRAM_ALLOWED_USER_IDS: '4' } as NodeJS.ProcessEnv
  const resolved = resolveConfig({
    token: box(' 123:abc '),
    users: box([{ id: 11, name: 'Аня' }]),
    allowedUserIds: box([11]),
    allowAllUsers: box(false),
    maxMessageLength: box(2048),
    pollingTimeoutSec: box(5),
    rendering: box('rich'),
  }, env)
  assert.equal(resolved.token, '123:abc')
  assert.deepEqual(resolved.users, [{ id: 11, name: 'Аня', enabled: true }])
  assert.deepEqual(resolved.effectiveUserIds, [11])
  assert.equal(resolved.allowAllUsers, false)
  assert.equal(resolved.maxMessageLength, 2048)
  assert.equal(resolved.pollingTimeoutSec, 5)
  assert.equal(resolved.rendering, 'rich')
})

test('resolveConfig clamps the numbers and tolerates plain config', () => {
  const env = {} as NodeJS.ProcessEnv
  const resolved = resolveConfig({
    token: '',
    maxMessageLength: 99999,
    pollingTimeoutSec: -5,
    rendering: 'nonsense',
  }, env)
  assert.equal(resolved.maxMessageLength, 4096)
  assert.equal(resolved.pollingTimeoutSec, 0)
  assert.equal(resolved.rendering, 'html')
  assert.deepEqual(resolved.effectiveUserIds, [])
})

test('the token falls back to DSH_TELEGRAM_TOKEN', () => {
  const resolved = resolveConfig({ token: '' }, { DSH_TELEGRAM_TOKEN: 'env-token' } as NodeJS.ProcessEnv)
  assert.equal(resolved.token, 'env-token')
})

test('configSignature changes when behavior changes and never leaks into the log', () => {
  const base = resolveConfig({ token: 'a', users: [{ id: 1 }] }, {} as NodeJS.ProcessEnv)
  assert.equal(configSignature(base), configSignature(resolveConfig({ token: 'a', users: [{ id: 1 }] }, {} as NodeJS.ProcessEnv)))
  assert.notEqual(configSignature(base), configSignature(resolveConfig({ token: 'b', users: [{ id: 1 }] }, {} as NodeJS.ProcessEnv)))
  assert.notEqual(configSignature(base), configSignature(resolveConfig({ token: 'a', users: [{ id: 1, enabled: false }] }, {} as NodeJS.ProcessEnv)))
  assert.notEqual(configSignature(base), configSignature(resolveConfig({ token: 'a', users: [{ id: 2 }] }, {} as NodeJS.ProcessEnv)))
})

test('every Config field is volatile, and the token is a secret', async () => {
  // DSH only builds a settings form for an entry with volatile fields, and only
  // volatile paths may be written from the GUI — a plain field would silently
  // disappear from the page. `role('secret')` keeps the token out of the browser.
  const { Config } = await import('../src/index.ts')
  const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean; role?: string } }> }).dict
  assert.deepEqual(
    Object.keys(dict).sort(),
    ['allowAllUsers', 'allowedUserIds', 'maxMessageLength', 'pollingTimeoutSec', 'rendering', 'token', 'users'],
  )
  for (const [key, field] of Object.entries(dict)) {
    assert.equal(field.meta?.volatile, true, `${key} должен быть .volatile()`)
  }
  assert.equal(dict.token.meta?.role, 'secret', 'token должен быть .role(\'secret\')')
  // The host serializes the schema into the settings wire document and reads
  // the form schema back through it.
  const wire = JSON.parse(JSON.stringify(Config.toJSON())) as {
    uid: number
    refs: Record<string, { type?: string; dict?: Record<string, unknown> }>
  }
  const root = wire.refs[String(wire.uid)]
  assert.equal(root?.type, 'object')
  assert.deepEqual(Object.keys(root?.dict ?? {}).sort(), Object.keys(dict).sort())
})
