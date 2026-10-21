import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as built from '../../lib/index.js'
import * as source from '../../src/index.ts'

// DSH runs `lib/` (`main: lib/index.js`), so a stale build is invisible at
// runtime and only shows up as "the fix did nothing". This test fails loudly
// when `lib/` was not rebuilt from `src/`.
test('lib/ экспортирует тот же публичный интерфейс, что src/', () => {
  assert.equal(built.name, source.name)
  assert.equal(typeof built.apply, 'function')
  assert.deepEqual(Object.keys(built).sort(), Object.keys(source).sort())
})

test('тексты команд в lib/ совпадают с src/ (сборка свежая)', async () => {
  const builtMsg = (await import('../../lib/commands.js')).MSG as Record<string, unknown>
  const sourceMsg = (await import('../../src/commands.ts')).MSG as Record<string, unknown>
  assert.deepEqual(Object.keys(builtMsg).sort(), Object.keys(sourceMsg).sort())
  for (const [key, value] of Object.entries(sourceMsg)) {
    if (typeof value === 'string') assert.equal(builtMsg[key], value, `MSG.${key} разошёлся`)
  }
  // Ни одного китайского литерала в собранном коде (наследие upstream).
  assert.doesNotMatch(JSON.stringify(builtMsg), /[\u4e00-\u9fff]/)
})

test('поведение собранного кода совпадает с src/ (рендер и статус)', async () => {
  const builtFormat = await import('../../lib/format.js')
  const sourceFormat = await import('../../src/format.ts')
  const sample = '**жирный** и `код`\n\n```js\nlet a = 1 < 2\n```'
  assert.equal(builtFormat.markdownToHtml(sample), sourceFormat.markdownToHtml(sample))
  assert.equal(builtFormat.escapeHtml('<a&b>'), sourceFormat.escapeHtml('<a&b>'))

  const builtStatus = await import('../../lib/status.js')
  const sourceStatus = await import('../../src/status.ts')
  const info = {
    sessionId: 's-1',
    label: 'демо',
    workspace: { title: 'proj', path: '/p' },
    model: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' },
    runtime: { contextUsed: 64536, contextWindow: 131072, turns: 3, steps: 5 },
    live: true,
  }
  assert.equal(builtStatus.formatStatusText(info as never), sourceStatus.formatStatusText(info as never))
})
