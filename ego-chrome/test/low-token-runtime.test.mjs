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

test('low-token indexed locator delegates new methods to RPC via temporary marker and cleans up', async () => {
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.hover') return { hovered: true }
      if (method === 'page.isChecked') return true
      if (method === 'page.setChecked') return { checked: params.checked }
      if (method === 'page.selectOption') return ['selected-val']
      if (method === 'page.setInputFiles') return { files: params.files }
      if (method === 'page.press') return true
      if (method === 'page.evaluate') {
        if (params.expression.includes('data-ego-chrome-index-target') && params.expression.includes('setAttribute')) {
          return { found: true, count: 3 }
        }
        return true
      }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })
  const nthLoc = runtime.page.locator('.item').nth(1)

  // 1. hover
  calls.length = 0
  await nthLoc.hover({ timeout: 1500 })
  const hoverCall = calls.find((c) => c.method === 'page.hover')
  assert.ok(hoverCall)
  assert.match(hoverCall.params.target, /\[data-ego-chrome-index-target="ego-index-/)
  assert.deepEqual(hoverCall.params.options, { timeout: 1500 })
  const hoverCleanups = calls.filter((c) => c.method === 'page.evaluate' && c.params.expression.includes('removeAttribute'))
  assert.equal(hoverCleanups.length, 1)

  // 2. check
  calls.length = 0
  await nthLoc.check({ timeout: 2000 })
  const checkCall = calls.find((c) => c.method === 'page.setChecked')
  assert.ok(checkCall)
  assert.match(checkCall.params.target, /\[data-ego-chrome-index-target="ego-index-/)
  assert.equal(checkCall.params.checked, true)
  assert.deepEqual(checkCall.params.options, { timeout: 2000 })
  const checkCleanups = calls.filter((c) => c.method === 'page.evaluate' && c.params.expression.includes('removeAttribute'))
  assert.equal(checkCleanups.length, 1)

  // 3. uncheck
  calls.length = 0
  await nthLoc.uncheck()
  const uncheckCall = calls.find((c) => c.method === 'page.setChecked')
  assert.ok(uncheckCall)
  assert.match(uncheckCall.params.target, /\[data-ego-chrome-index-target="ego-index-/)
  assert.equal(uncheckCall.params.checked, false)
  const uncheckCleanups = calls.filter((c) => c.method === 'page.evaluate' && c.params.expression.includes('removeAttribute'))
  assert.equal(uncheckCleanups.length, 1)

  // 4. setChecked
  calls.length = 0
  await nthLoc.setChecked(true)
  const setCheckedCall = calls.find((c) => c.method === 'page.setChecked')
  assert.ok(setCheckedCall)
  assert.equal(setCheckedCall.params.checked, true)

  // 5. isChecked
  calls.length = 0
  const isCheckedResult = await nthLoc.isChecked()
  assert.equal(isCheckedResult, true)
  const isCheckedCall = calls.find((c) => c.method === 'page.isChecked')
  assert.ok(isCheckedCall)
  assert.match(isCheckedCall.params.target, /\[data-ego-chrome-index-target="ego-index-/)

  // 6. selectOption
  calls.length = 0
  const selectResult = await nthLoc.selectOption('banana')
  assert.deepEqual(selectResult, ['selected-val'])
  const selectCall = calls.find((c) => c.method === 'page.selectOption')
  assert.ok(selectCall)
  assert.match(selectCall.params.target, /\[data-ego-chrome-index-target="ego-index-/)
  assert.deepEqual(selectCall.params.values, [{ value: 'banana' }])

  // 7. setInputFiles
  calls.length = 0
  await nthLoc.setInputFiles([])
  const fileCall = calls.find((c) => c.method === 'page.setInputFiles')
  assert.ok(fileCall)
  assert.match(fileCall.params.target, /\[data-ego-chrome-index-target="ego-index-/)
  assert.deepEqual(fileCall.params.files, [])

  // 8. press
  calls.length = 0
  await nthLoc.press('Tab')
  const pressCall = calls.find((c) => c.method === 'page.press')
  assert.ok(pressCall)
  assert.equal(pressCall.params.key, 'Tab')
  const focusEval = calls.find((c) => c.method === 'page.evaluate' && c.params.expression.includes('focus()'))
  assert.ok(focusEval)
  assert.ok(focusEval.params.expression.includes('deepQueryOne'))

  // 9. first() and last()
  calls.length = 0
  await runtime.page.locator('.item').first().hover()
  assert.ok(calls.some((c) => c.method === 'page.hover'))

  calls.length = 0
  await runtime.page.locator('.item').last().check()
  assert.ok(calls.some((c) => c.method === 'page.setChecked'))
})

test('withIndexedTarget cleans up marker even if action throws error', async () => {
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        if (params.expression.includes('setAttribute')) {
          return { found: true, count: 2 }
        }
        return true
      }
      if (method === 'page.hover') {
        throw new Error('CDP hover failed')
      }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })

  await assert.rejects(
    () => runtime.page.locator('.item').nth(0).hover(),
    /CDP hover failed/,
  )

  const cleanups = calls.filter((c) => c.method === 'page.evaluate' && c.params.expression.includes('removeAttribute'))
  assert.equal(cleanups.length, 1)
})

test('withIndexedTarget throws descriptive error when index is out of bounds', async () => {
  const rpc = {
    async request(method, params = {}) {
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        return { found: false, count: 1 }
      }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })

  await assert.rejects(
    () => runtime.page.locator('.item').nth(5).hover(),
    /Locator index not found: \.item; count=1; index=5/,
  )
})

test('low-token locator methods without index delegate directly to base locator', async () => {
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.hover') return { hovered: true }
      if (method === 'page.isChecked') return false
      if (method === 'page.setChecked') return { checked: params.checked }
      if (method === 'page.selectOption') return ['val']
      if (method === 'page.setInputFiles') return { files: params.files }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })
  const loc = runtime.page.locator('button.direct')

  await loc.hover()
  assert.equal(calls[calls.length - 1].method, 'page.hover')
  assert.equal(calls[calls.length - 1].params.target, 'button.direct')

  await loc.check()
  assert.equal(calls[calls.length - 1].method, 'page.setChecked')
  assert.equal(calls[calls.length - 1].params.checked, true)

  await loc.uncheck()
  assert.equal(calls[calls.length - 1].method, 'page.setChecked')
  assert.equal(calls[calls.length - 1].params.checked, false)

  await loc.isChecked()
  assert.equal(calls[calls.length - 1].method, 'page.isChecked')

  await loc.selectOption('opt')
  assert.equal(calls[calls.length - 1].method, 'page.selectOption')
  assert.deepEqual(calls[calls.length - 1].params.values, [{ value: 'opt' }])

  await loc.setInputFiles([])
  assert.equal(calls[calls.length - 1].method, 'page.setInputFiles')
})

test('low-token locator collection and evaluation methods use deep query expressions', async () => {
  const evaluations = []
  const rpc = {
    async request(method, params = {}) {
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        evaluations.push(params.expression)
        return ['item1', 'item2']
      }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })
  const loc = runtime.page.locator('li.row')

  await loc.allInnerTexts()
  assert.ok(evaluations.some((expr) => expr.includes('deepQueryAll') && expr.includes('innerText')))

  evaluations.length = 0
  await loc.allTextContents()
  assert.ok(evaluations.some((expr) => expr.includes('deepQueryAll') && expr.includes('textContent')))

  evaluations.length = 0
  await loc.evaluateAll((nodes) => nodes.length)
  assert.ok(evaluations.some((expr) => expr.includes('deepQueryAll') && expr.includes('source')))

  evaluations.length = 0
  await loc.nth(0).innerText()
  assert.ok(evaluations.some((expr) => expr.includes('deepQueryAll') && expr.includes('innerText')))
})

test('waitForIndexed retries on transient navigation errors and succeeds', async () => {
  let attempts = 0
  const rpc = {
    async request(method, params = {}) {
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        attempts++
        if (attempts === 1) {
          throw new Error('Execution context was destroyed')
        }
        return true
      }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })
  const result = await runtime.page.locator('.item').nth(1).waitFor({ timeout: 2000 })
  assert.equal(result, true)
  assert.ok(attempts >= 2)
})

test('waitForIndexed does not catch non-transient errors', async () => {
  const rpc = {
    async request(method, params = {}) {
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        throw new Error('Custom non-transient failure')
      }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })
  await assert.rejects(
    () => runtime.page.locator('.item').nth(1).waitFor({ timeout: 2000 }),
    /Custom non-transient failure/,
  )
})
