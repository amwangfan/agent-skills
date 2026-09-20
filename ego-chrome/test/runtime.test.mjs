import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  createRuntime,
  matchUrl,
  serializeEvaluation,
  normalizeSelectOptions,
  normalizeInputFiles,
  deepQueryAll,
  deepQueryOne,
  evaluateWithDeepQuery,
} from '../src/runtime.mjs'

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

test('browser.openTab and page.goto pass timeoutMs in request options while preserving params.timeout', async () => {
  const calls = []
  const rpc = {
    async request(method, params = {}, options = {}) {
      calls.push({ method, params, options })
      if (method === 'tabs.open') return { id: 42, url: params.url || 'about:blank', title: 'Test' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.goto') return { navigated: true, url: params.url }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)

  // 1) browser.openTab with custom timeout
  await runtime.browser.openTab('https://example.com/custom-timeout', { timeout: 45_000, wait: true })
  const openCallCustom = calls.find((c) => c.method === 'tabs.open')
  assert.equal(openCallCustom.params.timeout, 45_000)
  assert.deepEqual(openCallCustom.options, { timeoutMs: 45_000 })

  // 2) browser.openTab with default timeout
  calls.length = 0
  await runtime.browser.openTab('https://example.com/default-timeout')
  const openCallDefault = calls.find((c) => c.method === 'tabs.open')
  assert.equal(openCallDefault.params.timeout, undefined)
  assert.deepEqual(openCallDefault.options, { timeoutMs: 20_000 })

  // 3) page.goto with custom timeout
  calls.length = 0
  await runtime.page.goto('https://example.com/goto-custom', { timeout: 35_000 })
  const gotoCallCustom = calls.find((c) => c.method === 'page.goto')
  assert.equal(gotoCallCustom.params.timeout, 35_000)
  assert.deepEqual(gotoCallCustom.options, { timeoutMs: 35_000 })

  // 4) page.goto with default timeout
  calls.length = 0
  await runtime.page.goto('https://example.com/goto-default')
  const gotoCallDefault = calls.find((c) => c.method === 'page.goto')
  assert.equal(gotoCallDefault.params.timeout, undefined)
  assert.deepEqual(gotoCallDefault.options, { timeoutMs: 20_000 })
})

test('page.setNextDialogAction validates action strictly and rejects invalid actions with TypeError', async () => {
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 10, url: 'https://example.com' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.setNextDialogAction') return { configured: true, action: params.action }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com')

  // Valid string action: accept
  calls.length = 0
  await runtime.page.setNextDialogAction('accept')
  assert.equal(calls[0].params.action, 'accept')

  // Valid string action: dismiss
  calls.length = 0
  await runtime.page.setNextDialogAction('dismiss')
  assert.equal(calls[0].params.action, 'dismiss')

  // Default action: accept
  calls.length = 0
  await runtime.page.setNextDialogAction()
  assert.equal(calls[0].params.action, 'accept')

  // Valid object action
  calls.length = 0
  await runtime.page.setNextDialogAction({ action: 'dismiss', promptText: 'hello' })
  assert.equal(calls[0].params.action, 'dismiss')
  assert.equal(calls[0].params.promptText, 'hello')

  // Invalid action strings
  await assert.rejects(
    () => runtime.page.setNextDialogAction('cancel'),
    { name: 'TypeError' },
  )
  await assert.rejects(
    () => runtime.page.setNextDialogAction('prompt'),
    { name: 'TypeError' },
  )

  // Invalid action in object
  await assert.rejects(
    () => runtime.page.setNextDialogAction({ action: 'foo' }),
    { name: 'TypeError' },
  )

  // Invalid non-string / non-object action
  await assert.rejects(
    () => runtime.page.setNextDialogAction(123),
    { name: 'TypeError' },
  )
  await assert.rejects(
    () => runtime.page.setNextDialogAction(null),
    { name: 'TypeError' },
  )
})

test('page and locator RPC methods forward expected arguments for 0.3.0 capabilities', async () => {
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 10, url: 'https://example.com' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.hover') return { hovered: true }
      if (method === 'page.isChecked') return true
      if (method === 'page.setChecked') return { checked: params.checked }
      if (method === 'page.selectOption') return ['val1']
      if (method === 'page.setInputFiles') return { files: params.files }
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com')

  // 1. page.hover
  calls.length = 0
  await runtime.page.hover('button.submit', { timeout: 1000 })
  assert.equal(calls[0].method, 'page.hover')
  assert.deepEqual(calls[0].params, {
    tabId: 10,
    target: 'button.submit',
    options: { timeout: 1000 },
  })

  // 2. page.isChecked
  calls.length = 0
  const checked = await runtime.page.isChecked('input#agree')
  assert.equal(checked, true)
  assert.equal(calls[0].method, 'page.isChecked')
  assert.deepEqual(calls[0].params, {
    tabId: 10,
    target: 'input#agree',
  })

  // 3. page.setChecked
  calls.length = 0
  await runtime.page.setChecked('input#agree', true, { timeout: 2000 })
  assert.equal(calls[0].method, 'page.setChecked')
  assert.deepEqual(calls[0].params, {
    tabId: 10,
    target: 'input#agree',
    checked: true,
    options: { timeout: 2000 },
  })

  // 4. page.check & page.uncheck (idempotent mapping)
  calls.length = 0
  await runtime.page.check('input#agree')
  assert.equal(calls[0].method, 'page.setChecked')
  assert.equal(calls[0].params.checked, true)

  calls.length = 0
  await runtime.page.uncheck('input#agree')
  assert.equal(calls[0].method, 'page.setChecked')
  assert.equal(calls[0].params.checked, false)

  // 5. page.selectOption
  calls.length = 0
  await runtime.page.selectOption('select#country', 'US')
  assert.equal(calls[0].method, 'page.selectOption')
  assert.deepEqual(calls[0].params, {
    tabId: 10,
    target: 'select#country',
    values: [{ value: 'US' }],
  })

  // 6. page.setInputFiles
  calls.length = 0
  await runtime.page.setInputFiles('input#file', 'package.json')
  assert.equal(calls[0].method, 'page.setInputFiles')
  assert.equal(calls[0].params.tabId, 10)
  assert.equal(calls[0].params.target, 'input#file')
  assert.equal(Array.isArray(calls[0].params.files), true)
  assert.equal(calls[0].params.files.length, 1)
  assert.ok(calls[0].params.files[0].endsWith('package.json'))

  // 7. Base locator methods delegating to page
  const loc = runtime.page.locator('button.test')
  calls.length = 0
  await loc.hover({ timeout: 500 })
  assert.equal(calls[0].method, 'page.hover')
  assert.equal(calls[0].params.target, 'button.test')

  calls.length = 0
  await loc.check()
  assert.equal(calls[0].method, 'page.setChecked')
  assert.equal(calls[0].params.checked, true)

  calls.length = 0
  await loc.uncheck()
  assert.equal(calls[0].method, 'page.setChecked')
  assert.equal(calls[0].params.checked, false)

  calls.length = 0
  await loc.setChecked(false)
  assert.equal(calls[0].method, 'page.setChecked')
  assert.equal(calls[0].params.checked, false)

  calls.length = 0
  await loc.isChecked()
  assert.equal(calls[0].method, 'page.isChecked')

  calls.length = 0
  await loc.selectOption({ label: 'Option A' })
  assert.equal(calls[0].method, 'page.selectOption')
  assert.deepEqual(calls[0].params.values, [{ label: 'Option A' }])

  calls.length = 0
  await loc.setInputFiles([])
  assert.equal(calls[0].method, 'page.setInputFiles')
  assert.deepEqual(calls[0].params.files, [])
})

test('selectOption normalization supports string, array, descriptors, and empty array clearing', () => {
  // String
  assert.deepEqual(normalizeSelectOptions('blue'), [{ value: 'blue' }])

  // String array
  assert.deepEqual(normalizeSelectOptions(['a', 'b']), [{ value: 'a' }, { value: 'b' }])

  // Descriptors
  assert.deepEqual(normalizeSelectOptions({ value: 'v1' }), [{ value: 'v1' }])
  assert.deepEqual(normalizeSelectOptions({ label: 'Label 1' }), [{ label: 'Label 1' }])
  assert.deepEqual(normalizeSelectOptions({ index: 2 }), [{ index: 2 }])

  // Mixed descriptor array
  assert.deepEqual(
    normalizeSelectOptions([{ value: 'v' }, { label: 'l' }, { index: 0 }, 'raw']),
    [{ value: 'v' }, { label: 'l' }, { index: 0 }, { value: 'raw' }],
  )

  // Empty array clears selection
  assert.deepEqual(normalizeSelectOptions([]), [])

  // Invalid descriptors
  assert.throws(() => normalizeSelectOptions(), { name: 'TypeError' })
  assert.throws(() => normalizeSelectOptions(null), { name: 'TypeError' })
  assert.throws(() => normalizeSelectOptions(123), { name: 'TypeError' })
  assert.throws(() => normalizeSelectOptions({}), { name: 'TypeError' })
  assert.throws(() => normalizeSelectOptions({ foo: 'bar' }), { name: 'TypeError' })
  assert.throws(() => normalizeSelectOptions({ value: 'v', invalid: true }), { name: 'TypeError' })
  assert.throws(() => normalizeSelectOptions({ index: -1 }), { name: 'TypeError' })
  assert.throws(() => normalizeSelectOptions({ index: 'not-int' }), { name: 'TypeError' })
  assert.throws(() => normalizeSelectOptions([{ value: 'ok' }, {}]), { name: 'TypeError' })
})

test('setInputFiles validates file existence, resolves absolute paths, and clears with empty array', async () => {
  // Single existing file
  const single = await normalizeInputFiles('package.json')
  assert.equal(single.length, 1)
  assert.ok(path.isAbsolute(single[0]))
  assert.ok(single[0].endsWith('package.json'))

  // Multiple existing files
  const multi = await normalizeInputFiles(['package.json', 'README.md'])
  assert.equal(multi.length, 2)
  assert.ok(path.isAbsolute(multi[0]))
  assert.ok(path.isAbsolute(multi[1]))

  // Empty array (clearing files)
  const empty = await normalizeInputFiles([])
  assert.deepEqual(empty, [])

  // Non-existent file throws error containing the missing path without file content
  const nonExistent = 'this-file-does-not-exist-12345.xyz'
  await assert.rejects(
    () => normalizeInputFiles(nonExistent),
    (err) => {
      assert.ok(err.message.includes(path.resolve(nonExistent)))
      return true
    },
  )

  // Invalid inputs throw TypeError
  await assert.rejects(() => normalizeInputFiles(null), { name: 'TypeError' })
  await assert.rejects(() => normalizeInputFiles(123), { name: 'TypeError' })
  await assert.rejects(() => normalizeInputFiles(['']), { name: 'TypeError' })
})

test('deepQueryAll and deepQueryOne serialize and traverse open shadow roots in document order', () => {
  // Verify helper functions serialize cleanly
  assert.ok(typeof deepQueryAll.toString() === 'string')
  assert.ok(typeof deepQueryOne.toString() === 'string')

  const expr = evaluateWithDeepQuery(({ selector }) => {
    return deepQueryAll(selector).map((el) => el.id)
  }, { selector: '.target' })

  // Verify evaluateWithDeepQuery produces an expression string
  assert.ok(typeof expr === 'string')
  assert.ok(expr.includes('deepQueryAll'))
  assert.ok(expr.includes('deepQueryOne'))

  // Construct a mock DOM tree with open shadow roots:
  // light1 (.target)
  // host1 (shadowRoot: open)
  //   - shadow1 (.target)
  //   - innerHost (shadowRoot: open)
  //     - deepShadow (.target)
  // closedHost (shadowRoot: null -> closed shadow)
  // light2 (.target)
  const createMockElement = (id, className, shadowRoot = null) => {
    const el = {
      id,
      className,
      shadowRoot,
      matches(sel) {
        if (sel === `.${className}`) return true
        if (sel === `#${id}`) return true
        if (sel === `[data-target="${id}"]`) return true
        return false
      },
    }
    return el
  }

  const deepShadow = createMockElement('deepShadow', 'target')
  const innerHost = createMockElement('innerHost', 'host', {
    children: [deepShadow],
    ownerDocument: null,
  })
  const shadow1 = createMockElement('shadow1', 'target')
  const host1 = createMockElement('host1', 'host', {
    children: [shadow1, innerHost],
    ownerDocument: null,
  })
  const closedHost = createMockElement('closedHost', 'closed', null) // closed shadow -> shadowRoot is null
  const light1 = createMockElement('light1', 'target')
  const light2 = createMockElement('light2', 'target')

  const mockDoc = {
    children: [light1, host1, closedHost, light2],
    ownerDocument: null,
  }

  // Test deepQueryAll traverses open shadowRoot and ignores closed, preserving order
  const allFound = deepQueryAll('.target', mockDoc)
  assert.deepEqual(allFound.map((el) => el.id), ['light1', 'shadow1', 'deepShadow', 'light2'])

  // Test deepQueryOne finds the first element in document order
  const firstFound = deepQueryOne('.target', mockDoc)
  assert.equal(firstFound.id, 'light1')

  // Test deepQueryOne finding element exclusively in deep shadow
  const deepFound = deepQueryOne('#deepShadow', mockDoc)
  assert.equal(deepFound.id, 'deepShadow')

  // Test deepQueryOne returning null for non-existent selector
  const missingFound = deepQueryOne('.not-there', mockDoc)
  assert.equal(missingFound, null)
})

test('page textContent, count, waitForSelector, and locator press/evaluate use deep query serialization', async () => {
  const evaluations = []
  const rpc = {
    async request(method, params = {}) {
      if (method === 'tabs.open') return { id: 11, url: 'https://example.com' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        evaluations.push(params.expression)
        if (params.expression.includes('deepQueryAll(selector).length')) return 3
        if (params.expression.includes('textContent')) return 'shadow text'
        if (params.expression.includes('const element = deepQueryOne(selector)')) return true
        return true
      }
      if (method === 'page.press') return true
      throw new Error(`unexpected method ${method}`)
    },
  }

  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com')

  // textContent
  const text = await runtime.page.textContent('.shadow-content')
  assert.equal(text, 'shadow text')
  assert.ok(evaluations.some((expr) => expr.includes('deepQueryOne') && expr.includes('textContent')))

  // count
  const count = await runtime.page.count('.shadow-content')
  assert.equal(count, 3)
  assert.ok(evaluations.some((expr) => expr.includes('deepQueryAll') && expr.includes('length')))

  // waitForSelector
  const waitResult = await runtime.page.waitForSelector('.shadow-content', { timeout: 500 })
  assert.equal(waitResult, true)

  // locator.press uses deep query to focus
  evaluations.length = 0
  await runtime.page.locator('.shadow-input').press('Enter')
  assert.ok(evaluations.some((expr) => expr.includes('deepQueryOne') && expr.includes('focus()')))

  // locator.evaluate uses deep query
  evaluations.length = 0
  await runtime.page.locator('.shadow-input').evaluate((el) => el.tagName)
  assert.ok(evaluations.some((expr) => expr.includes('deepQueryOne') && expr.includes('source')))
})

test('deepQueryAll produces no duplicates and clickText cleans up shadow marker via deep query in finally', async () => {
  // 1. Verify deepQueryAll deduplication
  const duplicateCandidate = {
    id: 'dup-1',
    matches(sel) { return sel === '.dup' },
    children: [],
  }
  const mockWithDups = {
    children: [duplicateCandidate, duplicateCandidate],
    matches() { return false },
  }
  const allResults = deepQueryAll('.dup', mockWithDups)
  assert.equal(allResults.length, 1)
  assert.equal(allResults[0].id, 'dup-1')

  // 2. Verify clickText uses deepQueryOne to clean up marker in finally
  const calls = []
  const rpc = {
    async request(method, params = {}) {
      calls.push({ method, params })
      if (method === 'tabs.open') return { id: 25, url: 'https://example.com' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        if (params.expression.includes('collectVisibleTextMatches')) {
          return {
            found: true,
            count: 1,
            selected: { index: 0, text: 'Shadow Action Button' },
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
  await runtime.browser.openTab('https://example.com')
  calls.length = 0

  const result = await runtime.page.clickText('Shadow Action Button')
  assert.equal(result.text, 'Shadow Action Button')

  const clickCall = calls.find((c) => c.method === 'page.click')
  assert.ok(clickCall)
  assert.match(clickCall.params.target, /\[data-ego-chrome-text-target="ego-text-/)

  const cleanupCall = calls.find((c) => c.method === 'page.evaluate' && c.params.expression.includes('deepQueryOne') && c.params.expression.includes('data-ego-chrome-text-target'))
  assert.ok(cleanupCall, 'cleanup evaluation must use deepQueryOne to pierce open shadow roots')
})
