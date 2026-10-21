import assert from 'node:assert/strict'
import test from 'node:test'
import { extractLastTurn, formatLastTurn } from '../src/history.ts'

test('extractLastTurn pairs latest human user with following assistant', () => {
  const turn = extractLastTurn([
    {
      type: 'user/message',
      data: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'injected' }] },
    },
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'первый вопрос' }] },
    },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'первый ответ' }] } },
    },
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'второй вопрос' }] },
    },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'второй ответ' }] } },
    },
  ])
  assert.equal(turn.userText, 'второй вопрос')
  assert.equal(turn.assistantText, 'второй ответ')
})

test('formatLastTurn renders sections', () => {
  const text = formatLastTurn({ userText: 'hi', assistantText: 'hello' })
  assert.match(text, /【Вы】/)
  assert.match(text, /hi/)
  assert.match(text, /【Ассистент】/)
  assert.match(text, /hello/)
})
