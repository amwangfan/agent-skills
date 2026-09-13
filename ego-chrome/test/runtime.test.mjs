import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, matchUrl, serializeEvaluation } from '../src/runtime.mjs'

test('URL matching modes', () => {
  assert.equal(matchUrl('https://example.com/a/', 'https://example.com/a', 'origin+path'), true)
  assert.equal(matchUrl('https://example.com/a?q=1', 'https://example.com/b', 'origin'), true)
  assert.equal(matchUrl('https://example.com/a', '/a', 'exact'), false)
  assert.equal(matchUrl('https://example.com/orders/1', '/orders/', 'includes'), true)
})

test('page evaluation serializes functions and arguments', () => {
  const expression = serializeEvaluation((value) => value.answer, { answer: 42 })
  assert.equal(Function(`return ${expression}`)(), 42)
})

test('page methods require an explicitly selected automation tab', async () => {
  const calls = []
  const runtime = createRuntime({
    async request(method) {
      calls.push(method)
      throw new Error('unexpected')
    },
  })

  await assert.rejects(runtime.page.url(), /No automation tab selected/)
  assert.deepEqual(calls, [])
})

test('selected tab can be explicitly continued through bridge session calls', async () => {
  let remembered = 7
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'bridge.session.currentTab') return remembered ? { tabId: remembered } : null
      if (method === 'bridge.session.selectTab') {
        remembered = params.tabId
        return { tabId: remembered }
      }
      if (method === 'bridge.session.clearTab') {
        remembered = null
        return { cleared: true }
      }
      if (method === 'tabs.list') return [{ id: 7, url: 'https://example.com', title: 'Example' }]
      if (method === 'page.info') return { url: 'https://example.com/search?q=youtube', title: 'Search' }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  assert.equal((await runtime.browser.continueLastTab()).id, 7)
  assert.equal(
    await runtime.page.waitForURL((url) => url.searchParams.get('q') === 'youtube'),
    'https://example.com/search?q=youtube',
  )
  assert.ok(calls.some((call) => call.method === 'bridge.session.currentTab'))
})

test('active user tab is selected only through explicit API', async () => {
  let remembered = null
  const rpc = {
    async request(method, params = {}) {
      if (method === 'tabs.active') return { id: 3, url: 'https://active.example', title: 'Active' }
      if (method === 'bridge.session.selectTab') {
        remembered = params.tabId
        return { tabId: remembered }
      }
      if (method === 'page.info') return { url: 'https://active.example', title: 'Active' }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.useActiveTab()
  assert.equal(await runtime.page.url(), 'https://active.example')
  assert.equal(remembered, 3)
})

test('text locator marks a candidate and uses a trusted page click', async () => {
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 9, url: 'https://example.com', title: 'Example' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        if (params.expression.includes('collectVisibleTextMatches')) {
          return {
            found: true,
            count: 2,
            selected: { index: 1, text: 'Wind account' },
            matches: [],
          }
        }
        return true
      }
      if (method === 'page.click') return { clicked: true }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })
  const selected = await runtime.page.clickText('wind', { nth: 1 })

  assert.equal(selected.text, 'Wind account')
  assert.ok(
    calls.some(
      (call) =>
        call.method === 'page.click' && /data-ego-chrome-text-target/.test(call.params.target),
    ),
  )
})
