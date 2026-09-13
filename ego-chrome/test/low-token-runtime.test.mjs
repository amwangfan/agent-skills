import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/low-token-runtime.mjs'

function mockRuntime(snapshotValues = []) {
  const calls = []
  let snapshotIndex = 0
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.snapshot') return snapshotValues[snapshotIndex++] || 'page "Example"\n@1 button "Save"'
      if (method === 'page.evaluate') return ['one', 'two']
      throw new Error(`unexpected method ${method}`)
    },
  }
  return { runtime: createRuntime(rpc), calls }
}

test('compact snapshot is the low-token default', async () => {
  const { runtime, calls } = mockRuntime()
  await runtime.browser.openTab('https://example.com', { wait: false })
  await runtime.page.snapshot()
  const call = calls.find((entry) => entry.method === 'page.snapshot')
  assert.equal(call.params.options.maxChars, 3500)
  assert.equal(call.params.options.includeText, false)
})

test('normal snapshot opts into page text', async () => {
  const { runtime, calls } = mockRuntime()
  await runtime.browser.openTab('https://example.com', { wait: false })
  await runtime.page.snapshot({ mode: 'normal' })
  const call = calls.find((entry) => entry.method === 'page.snapshot')
  assert.equal(call.params.options.maxChars, 12000)
  assert.equal(call.params.options.includeText, true)
})

test('observe returns only changed semantic lines after a baseline', async () => {
  const { runtime } = mockRuntime([
    'page "Example"\n@1 button "Save"\n@2 textbox "Name"',
    'page "Example"\n@1 button "Saved"\n@2 textbox "Name"',
  ])
  await runtime.browser.openTab('https://example.com', { wait: false })
  await runtime.page.snapshot()
  const change = await runtime.page.observe()
  assert.equal(change.changed, true)
  assert.deepEqual(change.added, ['@1 button "Saved"'])
  assert.deepEqual(change.removed, ['button "Save"'])
  assert.equal(change.snapshot, undefined)
})

test('locator collection helpers use a single bounded evaluation', async () => {
  const { runtime, calls } = mockRuntime()
  await runtime.browser.openTab('https://example.com', { wait: false })
  assert.deepEqual(await runtime.page.locator('li').allInnerTexts(), ['one', 'two'])
  const evaluations = calls.filter((entry) => entry.method === 'page.evaluate')
  assert.equal(evaluations.length, 1)
  assert.match(evaluations[0].params.expression, /querySelectorAll/)
})
