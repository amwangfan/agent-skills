import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/semantic-runtime.mjs'
import { createSemanticLocator, semanticQueryOperation, isTransientNavigationError } from '../src/semantic-locators.mjs'

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
      if (method === 'page.hover') return { hovered: true }
      if (method === 'page.setChecked') return { checked: params.checked }
      if (method === 'page.isChecked') return true
      if (method === 'page.selectOption') return ['val1']
      if (method === 'page.setInputFiles') return { set: true }
      throw new Error(`unexpected method ${method}`)
    },
  }
  return { runtime: createRuntime(rpc), calls }
}

function createMockShadowRoot({ host = null, children = [], mode = 'open' } = {}) {
  const shadowRoot = {
    nodeType: 11,
    mode,
    host,
    children: [...children],
    getRootNode(options = {}) {
      if (options.composed && this.host && typeof this.host.getRootNode === 'function') {
        return this.host.getRootNode(options)
      }
      return this
    },
    getElementById(id) {
      const walk = (curr) => {
        if (!curr) return null
        if (curr.id === id) return curr
        for (const c of curr.children || []) {
          const found = walk(c)
          if (found) return found
        }
        return null
      }
      for (const child of this.children) {
        const found = walk(child)
        if (found) return found
      }
      return null
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null
    },
    querySelectorAll(selector) {
      const result = []
      const selParts = selector.split(',').map((s) => s.trim())
      const walk = (curr) => {
        for (const child of curr.children || []) {
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
  for (const c of shadowRoot.children) {
    c.parentElement = null
    c.parentNode = shadowRoot
  }
  return shadowRoot
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
  shadowRoot = null,
}) {
  const attrs = new Map(Object.entries(attributes))
  if (id) attrs.set('id', id)
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    labels,
    innerText,
    textContent: textContent || innerText,
    parentElement: parent,
    parentNode: parent,
    children: [...children],
    style: { display: 'block', visibility: 'visible', opacity: '1', ...style },
    isContentEditable,
    shadowRoot,
    focus() {
      this.focused = true
    },
    attachShadow({ mode = 'open' } = {}) {
      const root = createMockShadowRoot({ host: this, mode })
      if (mode === 'open') {
        this.shadowRoot = root
      } else {
        this.shadowRoot = null
      }
      return root
    },
    getRootNode(options = {}) {
      if (this.parentElement) return this.parentElement.getRootNode(options)
      if (this.parentNode) {
        if (typeof this.parentNode.getRootNode === 'function') {
          return this.parentNode.getRootNode(options)
        }
        return this.parentNode
      }
      return globalThis.document || this
    },
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
      let curr = this.parentElement || this.parentNode
      while (curr) {
        if (curr.style && (curr.style.display === 'none' || curr.style.visibility === 'hidden')) return []
        curr = curr.parentElement || curr.parentNode || curr.host
      }
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
    matches(selector) {
      const selParts = selector.split(',').map((s) => s.trim())
      return selParts.some((sel) => matchesSimpleSelector(this, sel))
    },
  }
  for (const c of node.children) {
    c.parentElement = node
    c.parentNode = node
  }
  if (shadowRoot) {
    shadowRoot.host = node
  }
  if (typeof globalThis.Element === 'function') {
    Object.setPrototypeOf(node, globalThis.Element.prototype)
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
  if (s.startsWith('[data-ego-chrome-semantic-target')) {
    if (s.includes('=')) {
      const match = s.match(/\[data-ego-chrome-semantic-target=["']?([^"']+)["']?\]/)
      return element.getAttribute('data-ego-chrome-semantic-target') === (match ? match[1] : '')
    }
    return element.hasAttribute('data-ego-chrome-semantic-target')
  }
  if (s.startsWith('[contenteditable')) return element.isContentEditable
  if (s.startsWith('a[href]')) return element.tagName === 'A' && element.hasAttribute('href')
  return element.tagName === s.toUpperCase()
}

function setupMockDom(root) {
  const allNodes = []
  const collectAll = (n) => {
    if (!n) return
    allNodes.push(n)
    if (n.shadowRoot) {
      for (const c of n.shadowRoot.children || []) collectAll(c)
    }
    for (const c of n.children || []) collectAll(c)
  }
  collectAll(root)

  class MockElement {}
  for (const n of allNodes) {
    Object.setPrototypeOf(n, MockElement.prototype)
  }

  const doc = {
    nodeType: 9,
    body: root,
    documentElement: root,
    getElementById(id) {
      const walk = (curr) => {
        if (!curr) return null
        if (curr.id === id) return curr
        for (const c of curr.children || []) {
          const found = walk(c)
          if (found) return found
        }
        return null
      }
      return walk(root)
    },
    querySelectorAll(selector) {
      return root.querySelectorAll(selector)
    },
    querySelector(selector) {
      return root.querySelector(selector)
    },
    getRootNode() {
      return doc
    },
  }

  root.parentNode = doc

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

test('getByRole finds button inside open shadowRoot by role and accessible name', () => {
  const shadowBtn = createMockNode({ tag: 'button', innerText: 'Shadow Submit' })
  const shadow = createMockShadowRoot({ children: [shadowBtn] })
  const host = createMockNode({ tag: 'my-element', shadowRoot: shadow })
  const root = createMockNode({ tag: 'body', children: [host] })
  const teardown = setupMockDom(root)

  try {
    const count = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Shadow Submit', exact: true } },
    })
    assert.equal(count, 1, 'button inside shadowRoot should be found by role and name')
  } finally {
    teardown()
  }
})

test('accessible name prefers aria-labelledby inside shadowRoot over document ID', () => {
  const docLabel = createMockNode({ tag: 'span', id: 'label-id', innerText: 'Doc Label' })
  const shadowLabel = createMockNode({ tag: 'span', id: 'label-id', innerText: 'Shadow Label' })
  const shadowBtn = createMockNode({
    tag: 'button',
    attributes: { 'aria-labelledby': 'label-id' },
    innerText: 'Button',
  })
  const shadow = createMockShadowRoot({ children: [shadowLabel, shadowBtn] })
  const host = createMockNode({ tag: 'my-card', shadowRoot: shadow })
  const root = createMockNode({ tag: 'body', children: [docLabel, host] })
  const teardown = setupMockDom(root)

  try {
    const countShadow = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Shadow Label', exact: true } },
    })
    assert.equal(countShadow, 1, 'aria-labelledby must resolve to shadow local id first')

    const countDoc = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Doc Label', exact: true } },
    })
    assert.equal(countDoc, 0, 'aria-labelledby should not resolve to doc when shadow has id')
  } finally {
    teardown()
  }
})

test('getByLabel associates label[for] inside open shadowRoot and prioritizes over document', () => {
  const docLabel = createMockNode({ tag: 'label', attributes: { for: 'email-field' }, innerText: 'Global Email' })
  const shadowLabel = createMockNode({ tag: 'label', attributes: { for: 'email-field' }, innerText: 'Shadow Email' })
  const shadowInput = createMockNode({ tag: 'input', id: 'email-field', attributes: { type: 'text' } })
  const shadow = createMockShadowRoot({ children: [shadowLabel, shadowInput] })
  const host = createMockNode({ tag: 'user-form', shadowRoot: shadow })
  const root = createMockNode({ tag: 'body', children: [docLabel, host] })
  const teardown = setupMockDom(root)

  try {
    const countShadow = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'label', matcher: { kind: 'text', value: 'Shadow Email', exact: true } },
    })
    assert.equal(countShadow, 1, 'input should associate with shadow label')

    const countGlobal = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'label', matcher: { kind: 'text', value: 'Global Email', exact: true } },
    })
    assert.equal(countGlobal, 0, 'shadow input should not associate with document label when shadow label exists')
  } finally {
    teardown()
  }
})

test('candidates across multiple shadow roots maintain depth-first DOM order', () => {
  const btn1 = createMockNode({ tag: 'button', innerText: 'Button 1' })
  const shadow1 = createMockShadowRoot({ children: [btn1] })
  const host1 = createMockNode({ tag: 'host-one', shadowRoot: shadow1 })

  const nestedBtn = createMockNode({ tag: 'button', innerText: 'Nested Button' })
  const nestedShadow = createMockShadowRoot({ children: [nestedBtn] })
  const nestedHost = createMockNode({ tag: 'nested-host', shadowRoot: nestedShadow })
  shadow1.children.push(nestedHost)
  nestedHost.parentNode = shadow1

  const btn2 = createMockNode({ tag: 'button', innerText: 'Button 2' })
  const shadow2 = createMockShadowRoot({ children: [btn2] })
  const host2 = createMockNode({ tag: 'host-two', shadowRoot: shadow2 })

  const lightBtn = createMockNode({ tag: 'button', innerText: 'Light Button' })

  const root = createMockNode({ tag: 'body', children: [host1, host2, lightBtn] })
  const teardown = setupMockDom(root)

  try {
    const texts = semanticQueryOperation({
      operation: 'allInnerTexts',
      query: { kind: 'role', role: 'button' },
    })
    assert.deepEqual(texts, ['Button 1', 'Nested Button', 'Button 2', 'Light Button'])
  } finally {
    teardown()
  }
})

test('semantic locator delegates action methods to page with marker target', async () => {
  const calls = []
  const mockPage = {
    async evaluate(fn, arg) {
      if (arg?.operation === 'count') return 1
      if (arg?.operation === 'mark') return { found: true, count: 1 }
      if (arg?.operation === 'unmark') return true
      return true
    },
    async hover(target, options) {
      calls.push({ action: 'hover', target, options })
      return { hovered: true }
    },
    async check(target, options) {
      calls.push({ action: 'check', target, options })
      return { checked: true }
    },
    async uncheck(target, options) {
      calls.push({ action: 'uncheck', target, options })
      return { unchecked: true }
    },
    async setChecked(target, checked, options) {
      calls.push({ action: 'setChecked', target, checked, options })
      return { checked, changed: true }
    },
    async isChecked(target) {
      calls.push({ action: 'isChecked', target })
      return true
    },
    async selectOption(target, values) {
      calls.push({ action: 'selectOption', target, values })
      return ['val1']
    },
    async setInputFiles(target, files) {
      calls.push({ action: 'setInputFiles', target, files })
      return { count: files.length }
    },
  }

  const locator = createSemanticLocator(mockPage, { kind: 'role', role: 'button' })

  await locator.hover({ force: true })
  assert.equal(calls[0].action, 'hover')
  assert.match(calls[0].target, /data-ego-chrome-semantic-target/)
  assert.deepEqual(calls[0].options, { force: true })

  await locator.check({ force: true })
  assert.equal(calls[1].action, 'check')
  assert.match(calls[1].target, /data-ego-chrome-semantic-target/)
  assert.deepEqual(calls[1].options, { force: true })

  await locator.uncheck()
  assert.equal(calls[2].action, 'uncheck')
  assert.match(calls[2].target, /data-ego-chrome-semantic-target/)

  await locator.setChecked(false, { force: true })
  assert.equal(calls[3].action, 'setChecked')
  assert.match(calls[3].target, /data-ego-chrome-semantic-target/)
  assert.equal(calls[3].checked, false)
  assert.deepEqual(calls[3].options, { force: true })

  const checked = await locator.isChecked()
  assert.equal(checked, true)
  assert.equal(calls[4].action, 'isChecked')

  const selected = await locator.selectOption('blue')
  assert.deepEqual(selected, ['val1'])
  assert.equal(calls[5].action, 'selectOption')
  assert.equal(calls[5].values, 'blue')

  const uploaded = await locator.setInputFiles(['file.txt'])
  assert.deepEqual(uploaded, { count: 1 })
  assert.equal(calls[6].action, 'setInputFiles')
  assert.deepEqual(calls[6].files, ['file.txt'])
})

test('marker is cleaned up from element inside shadowRoot after action without document.querySelector', async () => {
  const shadowBtn = createMockNode({ tag: 'button', innerText: 'Shadow Action' })
  const shadow = createMockShadowRoot({ children: [shadowBtn] })
  const host = createMockNode({ tag: 'my-host', shadowRoot: shadow })
  const root = createMockNode({ tag: 'body', children: [host] })
  const teardown = setupMockDom(root)

  try {
    const page = {
      async evaluate(fn, arg) {
        if (typeof fn === 'function') {
          return fn(arg)
        }
        return (0, eval)(`(${fn})`)(arg)
      },
      async click(target) {
        assert.ok(shadowBtn.hasAttribute('data-ego-chrome-semantic-target'), 'marker must be set on shadow element')
        return { clicked: true }
      },
    }

    const locator = createSemanticLocator(page, {
      kind: 'role',
      role: 'button',
      matcher: { kind: 'text', value: 'Shadow Action', exact: true },
    })
    await locator.click()

    assert.equal(shadowBtn.hasAttribute('data-ego-chrome-semantic-target'), false, 'marker must be removed from shadow element after action')
  } finally {
    teardown()
  }
})

test('waitFor state attached, visible, hidden, detached works inside shadowRoot', () => {
  const visibleBtn = createMockNode({ tag: 'button', innerText: 'Visible Shadow' })
  const hiddenBtn = createMockNode({ tag: 'button', innerText: 'Hidden Shadow', style: { display: 'none' } })
  const shadow = createMockShadowRoot({ children: [visibleBtn, hiddenBtn] })
  const host = createMockNode({ tag: 'my-host', shadowRoot: shadow })
  const root = createMockNode({ tag: 'body', children: [host] })
  const teardown = setupMockDom(root)

  try {
    const queryVisible = { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Visible Shadow', exact: true } }
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryVisible, state: 'attached' }), true, 'attached for visible shadow')
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryVisible, state: 'visible' }), true, 'visible for visible shadow')
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryVisible, state: 'hidden' }), false, 'hidden is false for visible shadow')
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryVisible, state: 'detached' }), false, 'detached is false for visible shadow')

    const queryHidden = { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Hidden Shadow', exact: true } }
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryHidden, state: 'attached' }), true, 'attached for hidden shadow')
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryHidden, state: 'visible' }), false, 'visible is false for hidden shadow')
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryHidden, state: 'hidden' }), true, 'hidden is true for hidden shadow')
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryHidden, state: 'detached' }), false, 'detached is false for hidden shadow')

    const queryNonExistent = { kind: 'role', role: 'button', matcher: { kind: 'text', value: 'Nonexistent Shadow', exact: true } }
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryNonExistent, state: 'detached' }), true, 'detached for non-existent')
    assert.equal(semanticQueryOperation({ operation: 'state', query: queryNonExistent, state: 'attached' }), false, 'not attached for non-existent')
  } finally {
    teardown()
  }
})

test('closed shadowRoot is explicitly not supported and ignored', () => {
  const closedHost = createMockNode({ tag: 'closed-host' })
  closedHost.attachShadow({ mode: 'closed' })
  assert.equal(closedHost.shadowRoot, null)
  const root = createMockNode({ tag: 'body', children: [closedHost] })
  const teardown = setupMockDom(root)

  try {
    const count = semanticQueryOperation({
      operation: 'count',
      query: { kind: 'role', role: 'button' },
    })
    assert.equal(count, 0)
  } finally {
    teardown()
  }
})
