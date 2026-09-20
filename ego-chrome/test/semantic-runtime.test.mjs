import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/semantic-runtime.mjs'
import { semanticQueryOperation, isTransientNavigationError } from '../src/semantic-locators.mjs'

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

function createMockNode({
  tag = 'div',
  attributes = {},
  id = '',
  labels,
  innerText = '',
  textContent = '',
  parent = null,
  children = [],
  style = {},
  isContentEditable = false,
  clientRects = [{ width: 100, height: 20 }],
}) {
  const attrs = new Map(Object.entries(attributes))
  if (id) attrs.set('id', id)
  const node = {
    tagName: tag.toUpperCase(),
    id,
    labels,
    innerText,
    textContent: textContent || innerText,
    parentElement: parent,
    children: [...children],
    style: { display: 'block', visibility: 'visible', opacity: '1', ...style },
    isContentEditable,
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null
    },
    hasAttribute(name) {
      return attrs.has(name)
    },
    setAttribute(name, val) {
      attrs.set(name, String(val))
    },
    removeAttribute(name) {
      attrs.delete(name)
    },
    getClientRects() {
      if (this.style.display === 'none' || this.style.visibility === 'hidden') return []
      return clientRects
    },
    closest(selector) {
      const matchTag = (target, sel) => {
        const parts = sel.split(',').map((s) => s.trim().toUpperCase())
        return parts.includes(target.tagName)
      }
      let curr = this.parentElement
      while (curr) {
        if (matchTag(curr, selector)) return curr
        curr = curr.parentElement
      }
      return null
    },
    querySelector(selector) {
      const matches = this.querySelectorAll(selector)
      return matches[0] || null
    },
    querySelectorAll(selector) {
      const result = []
      const selParts = selector.split(',').map((s) => s.trim())
      const walk = (curr) => {
        for (const child of curr.children) {
          for (const sel of selParts) {
            if (matchesSimpleSelector(child, sel)) {
              if (!result.includes(child)) result.push(child)
              break
            }
          }
          walk(child)
        }
      }
      walk(this)
      return result
    },
  }
  for (const c of node.children) {
    c.parentElement = node
  }
  return node
}

function matchesSimpleSelector(element, selector) {
  const s = selector.trim()
  if (s === '[role]') return element.hasAttribute('role')
  if (s === '[id]') return Boolean(element.id)
  if (s.startsWith('label[for=')) {
    const id = s.replace(/^label\[for=["']?/, '').replace(/["']?\]$/, '')
    return element.tagName === 'LABEL' && element.getAttribute('for') === id
  }
  if (s === 'label[for]') return element.tagName === 'LABEL' && element.hasAttribute('for')
  if (s.startsWith('[contenteditable')) return element.isContentEditable
  if (s.startsWith('a[href]')) return element.tagName === 'A' && element.hasAttribute('href')
  return element.tagName === s.toUpperCase()
}

function setupMockDom(root) {
  const allNodes = []
  const collectAll = (n) => {
    allNodes.push(n)
    for (const c of n.children) collectAll(c)
  }
  collectAll(root)

  class MockElement {}
  for (const n of allNodes) {
    Object.setPrototypeOf(n, MockElement.prototype)
  }

  const doc = {
    body: root,
    documentElement: root,
    getElementById(id) {
      return allNodes.find((n) => n.id === id) || null
    },
    querySelectorAll(selector) {
      return root.querySelectorAll(selector)
    },
    querySelector(selector) {
      return root.querySelector(selector)
    },
  }

  const prevDoc = globalThis.document
  const prevStyle = globalThis.getComputedStyle
  const prevEl = globalThis.Element
  const prevCSS = globalThis.CSS

  globalThis.document = doc
  globalThis.getComputedStyle = (el) => el.style
  globalThis.Element = MockElement
  globalThis.CSS = { escape: (s) => s }

  return () => {
    globalThis.document = prevDoc
    globalThis.getComputedStyle = prevStyle
    globalThis.Element = prevEl
    globalThis.CSS = prevCSS
  }
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

test('accessible name prefers aria-labelledby over aria-label and falls back to aria-label', () => {
  const labelSpan = createMockNode({ tag: 'span', id: 'label-1', innerText: 'Labelled By Name' })
  const btnBoth = createMockNode({
    tag: 'button',
    id: 'btn-both',
    attributes: { 'aria-labelledby': 'label-1', 'aria-label': 'Direct Aria Label' },
    innerText: 'Button Text',
  })
  const btnFallback = createMockNode({
    tag: 'button',
    id: 'btn-fallback',
    attributes: { 'aria-labelledby': 'nonexistent-id', 'aria-label': 'Fallback Label' },
    innerText: 'Button Text',
  })
  const root = createMockNode({ tag: 'body', children: [labelSpan, btnBoth, btnFallback] })
  const teardown = setupMockDom(root)

  try {
    const matchedLabelledBy = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Labelled By Name', exact: true } },
    })
    assert.equal(matchedLabelledBy, 1, 'aria-labelledby must take precedence over aria-label')

    const matchedDirect = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Direct Aria Label', exact: true } },
    })
    assert.equal(matchedDirect, 0, 'aria-label should not match when aria-labelledby resolved')

    const matchedFallback = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Fallback Label', exact: true } },
    })
    assert.equal(matchedFallback, 1, 'aria-label should be used when aria-labelledby target does not exist')
  } finally {
    teardown()
  }
})

test('label[for] associates custom labelable elements as fallback', () => {
  const label = createMockNode({ tag: 'label', attributes: { for: 'custom-widget' }, innerText: 'Choose Category' })
  const customWidget = createMockNode({
    tag: 'div',
    id: 'custom-widget',
    attributes: { role: 'combobox' },
    innerText: 'Selected: None',
  })
  const root = createMockNode({ tag: 'body', children: [label, customWidget] })
  const teardown = setupMockDom(root)

  try {
    const count = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'label', matcher: { kind: 'text', value: 'Choose Category', exact: true } },
    })
    assert.equal(count, 1, 'custom labelable widget without native labels should resolve label[for]')
  } finally {
    teardown()
  }
})

test('implicit roles are correctly recognized', () => {
  const dialog = createMockNode({ tag: 'dialog', attributes: { 'aria-label': 'Confirmation' } })
  const table = createMockNode({ tag: 'table', attributes: { 'aria-label': 'Users' } })
  const row = createMockNode({ tag: 'tr' })
  const cell = createMockNode({ tag: 'td', innerText: 'Cell Value' })
  const colHeader = createMockNode({ tag: 'th', innerText: 'Name Header' })
  const rowHeader = createMockNode({ tag: 'th', attributes: { scope: 'row' }, innerText: 'Row 1 Header' })
  const listUl = createMockNode({ tag: 'ul' })
  const listItem = createMockNode({ tag: 'li', innerText: 'List Item 1' })
  const nav = createMockNode({ tag: 'nav', attributes: { 'aria-label': 'Site Nav' } })
  const main = createMockNode({ tag: 'main' })
  const aside = createMockNode({ tag: 'aside', attributes: { 'aria-label': 'Sidebar' } })
  const article = createMockNode({ tag: 'article', innerText: 'Article Content' })
  const imgWithAlt = createMockNode({ tag: 'img', attributes: { alt: 'Avatar Picture' } })
  const imgEmptyAlt = createMockNode({ tag: 'img', attributes: { alt: '' } })
  const progress = createMockNode({ tag: 'progress', attributes: { value: '50', max: '100', 'aria-label': 'Upload Progress' } })

  const root = createMockNode({
    tag: 'body',
    children: [
      dialog, table, row, cell, colHeader, rowHeader,
      listUl, listItem, nav, main, aside, article,
      imgWithAlt, imgEmptyAlt, progress,
    ],
  })
  const teardown = setupMockDom(root)

  try {
    const checkRole = (role, matcher) => semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role, matcher: matcher ? { kind: 'text', value: matcher, exact: true } : null },
    })

    assert.equal(checkRole('dialog', 'Confirmation'), 1, 'dialog role')
    assert.equal(checkRole('table', 'Users'), 1, 'table role')
    assert.equal(checkRole('row'), 1, 'row role')
    assert.equal(checkRole('cell', 'Cell Value'), 1, 'cell role')
    assert.equal(checkRole('columnheader', 'Name Header'), 1, 'columnheader role')
    assert.equal(checkRole('rowheader', 'Row 1 Header'), 1, 'rowheader role')
    assert.equal(checkRole('list'), 1, 'list role')
    assert.equal(checkRole('listitem', 'List Item 1'), 1, 'listitem role')
    assert.equal(checkRole('navigation', 'Site Nav'), 1, 'navigation role')
    assert.equal(checkRole('main'), 1, 'main role')
    assert.equal(checkRole('complementary', 'Sidebar'), 1, 'complementary role')
    assert.equal(checkRole('article', 'Article Content'), 1, 'article role')
    assert.equal(checkRole('img', 'Avatar Picture'), 1, 'img role')
    assert.equal(checkRole('img'), 1, 'img with alt="" should not have role img')
    assert.equal(checkRole('progressbar', 'Upload Progress'), 1, 'progressbar role')
  } finally {
    teardown()
  }
})

test('header and footer only map to landmarks under valid conditions', () => {
  const topHeader = createMockNode({ tag: 'header', attributes: { 'aria-label': 'Top Banner' } })
  const topFooter = createMockNode({ tag: 'footer', attributes: { 'aria-label': 'Top Footer' } })

  const articleHeader = createMockNode({ tag: 'header', attributes: { 'aria-label': 'Article Banner' } })
  const articleFooter = createMockNode({ tag: 'footer', attributes: { 'aria-label': 'Article Footer' } })
  const articleNode = createMockNode({ tag: 'article', children: [articleHeader, articleFooter] })

  const sectionHeader = createMockNode({ tag: 'header', attributes: { 'aria-label': 'Section Banner' } })
  const sectionNode = createMockNode({ tag: 'section', children: [sectionHeader] })

  const root = createMockNode({
    tag: 'body',
    children: [topHeader, topFooter, articleNode, sectionNode],
  })
  const teardown = setupMockDom(root)

  try {
    const banners = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'banner' },
    })
    assert.equal(banners, 1, 'only top-level header should map to banner')

    const bannerWithName = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'banner', matcher: { kind: 'text', value: 'Top Banner', exact: true } },
    })
    assert.equal(bannerWithName, 1, 'top banner matched by name')

    const contentinfos = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'contentinfo' },
    })
    assert.equal(contentinfos, 1, 'only top-level footer should map to contentinfo')

    const contentinfoWithName = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'contentinfo', matcher: { kind: 'text', value: 'Top Footer', exact: true } },
    })
    assert.equal(contentinfoWithName, 1, 'top contentinfo matched by name')
  } finally {
    teardown()
  }
})

test('waitFor state attached/detached includes hidden elements while visible/hidden checks visibility', () => {
  const hiddenBtn = createMockNode({
    tag: 'button',
    id: 'hidden-button',
    attributes: { 'aria-label': 'Hidden Action' },
    style: { display: 'none' },
  })
  const root = createMockNode({ tag: 'body', children: [hiddenBtn] })
  const teardown = setupMockDom(root)

  try {
    const query = {
      kind: 'role',
      role: 'button',
      matcher: { kind: 'text', value: 'Hidden Action', exact: true },
      includeHidden: false, // default is false
    }

    // 1. waitFor({ state: 'attached' }) should match hidden element
    const attached = semanticQueryOperation({
      operation: 'state',
      query,
      state: 'attached',
    })
    assert.equal(attached, true, 'attached should be true for hidden mounted node even if includeHidden=false')

    // 2. waitFor({ state: 'detached' }) should NOT be true when element is mounted
    const detached = semanticQueryOperation({
      operation: 'state',
      query,
      state: 'detached',
    })
    assert.equal(detached, false, 'detached should be false for hidden mounted node')

    // 3. waitFor({ state: 'visible' }) should be false because element is display: none
    const visible = semanticQueryOperation({
      operation: 'state',
      query,
      state: 'visible',
    })
    assert.equal(visible, false, 'visible should be false for display: none element')

    // 4. waitFor({ state: 'hidden' }) should be true because element is display: none
    const hidden = semanticQueryOperation({
      operation: 'state',
      query,
      state: 'hidden',
    })
    assert.equal(hidden, true, 'hidden should be true for display: none element')
  } finally {
    teardown()
  }
})

test('isTransientNavigationError detects navigation and destroyed context errors', () => {
  assert.equal(isTransientNavigationError(new Error('Execution context was destroyed, most likely because of a navigation.')), true)
  assert.equal(isTransientNavigationError(new Error('Execution context destroyed')), true)
  assert.equal(isTransientNavigationError(new Error('Inspected target navigated or closed')), true)
  assert.equal(isTransientNavigationError(new Error('Cannot access a chrome:// URL')), true)
  assert.equal(isTransientNavigationError('Navigation interrupted'), true)
  assert.equal(isTransientNavigationError(new Error('Element not found: [data-target]')), false)
  assert.equal(isTransientNavigationError(new TypeError('Invalid parameter value')), false)
})

test('locator.waitFor retries on transient navigation errors and succeeds', async () => {
  let evaluateAttempts = 0
  const rpc = {
    async request(method, params = {}) {
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        evaluateAttempts++
        if (evaluateAttempts === 1) {
          throw new Error('Execution context was destroyed, most likely because of a navigation.')
        }
        return true
      }
      throw new Error(`unexpected method ${method}`)
    },
  }
  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })
  const matched = await runtime.page.getByRole('button', { name: 'Save' }).waitFor({ timeout: 1000 })
  assert.equal(matched, true)
  assert.ok(evaluateAttempts >= 2, 'should have retried after the transient error')
})

test('locator.waitFor does not retry non-transient errors', async () => {
  let evaluateAttempts = 0
  const rpc = {
    async request(method, params = {}) {
      if (method === 'tabs.open') return { id: 7, url: params.url, title: '' }
      if (method === 'bridge.session.selectTab') return { tabId: params.tabId }
      if (method === 'page.evaluate') {
        evaluateAttempts++
        throw new TypeError('Non-transient failure in locator')
      }
      throw new Error(`unexpected method ${method}`)
    },
  }
  const runtime = createRuntime(rpc)
  await runtime.browser.openTab('https://example.com', { wait: false })
  await assert.rejects(
    runtime.page.getByRole('button', { name: 'Save' }).waitFor({ timeout: 1000 }),
    /Non-transient failure in locator/,
  )
  assert.equal(evaluateAttempts, 1, 'should fail immediately on non-transient error')
})
