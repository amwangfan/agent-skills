import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/semantic-runtime.mjs'

function createMockRuntime() {
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        if (params.expression.includes('"operation":"count"')) return 2
        if (params.expression.includes('"operation":"mark"')) return { found: true, count: 1 }
        return true
      }
      if (method === 'page.fill') return { filled: true }
      if (method === 'page.click') return { clicked: true }
      throw new Error(`unexpected method ${method}`)
    },
  }
  return { runtime: createRuntime(rpc), calls }
}

test('getByRole serializes implicit role and regex name matching', async () => {
  const { runtime, calls } = createMockRuntime()
  await runtime.browser.openTab('https://example.com', { wait: false })
  const count = await runtime.page.getByRole('button', { name: /save/i }).count()
  assert.equal(count, 2)
  const expression = calls.findLast((call) => call.method === 'page.evaluate').params.expression
  assert.match(expression, /semanticQueryOperation/)
  assert.match(expression, /"role":"button"/)
  assert.match(expression, /"source":"save"/)
})

test('getByLabel fills through a temporary CDP-clickable target', async () => {
  const { runtime, calls } = createMockRuntime()
  await runtime.browser.openTab('https://example.com', { wait: false })
  await runtime.page.getByLabel('Email').fill('me@example.com')
  assert.ok(calls.some((call) => call.method === 'page.fill'))
  assert.ok(calls.some((call) => call.method === 'page.evaluate' && call.params.expression.includes('"operation":"mark"')))
})
