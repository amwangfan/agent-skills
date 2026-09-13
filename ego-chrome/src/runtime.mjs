const DEFAULT_TIMEOUT = 10_000

export function createRuntime(rpc, options = {}) {
  let selectedTabId = options.tabId || null
  const taskMap = new Map()
  let nextTaskId = 1

  const call = (method, params = {}, requestOptions) => rpc.request(method, params, requestOptions)

  async function rememberTabId(tabId) {
    selectedTabId = tabId
    await call('bridge.session.selectTab', { tabId })
    return tabId
  }

  async function clearRememberedTab(tabId) {
    if (selectedTabId === tabId) selectedTabId = null
    await call('bridge.session.clearTab', { tabId })
  }

  function requireSelectedTabId() {
    if (selectedTabId) return selectedTabId
    throw new Error(
      'No automation tab selected. Start with browser.openTab(), browser.openOrReuseTab(), ' +
        'browser.continueLastTab(), browser.useActiveTab(), or browser.useTab() before calling page methods.',
    )
  }

  async function resolveRememberedTab() {
    const remembered = await call('bridge.session.currentTab')
    if (!remembered?.tabId) return null
    const tabs = await call('tabs.list')
    const tab = tabs.find((candidate) => candidate.id === remembered.tabId)
    if (!tab) {
      await clearRememberedTab(remembered.tabId)
      return null
    }
    selectedTabId = tab.id
    return tab
  }

  const browser = {
    async listTabs() {
      return call('tabs.list')
    },

    async currentTab() {
      if (selectedTabId) {
        const tabs = await call('tabs.list')
        const tab = tabs.find((candidate) => candidate.id === selectedTabId)
        if (tab) return tab
        await clearRememberedTab(selectedTabId)
      }
      return resolveRememberedTab()
    },

    async continueLastTab() {
      const tab = await resolveRememberedTab()
      if (!tab) throw new Error('No previous automation tab is available')
      return tab
    },

    async useActiveTab() {
      const tab = await call('tabs.active')
      if (!tab?.id) throw new Error('No controllable Chrome tab is active')
      await rememberTabId(tab.id)
      return tab
    },

    async useTab(tabOrId) {
      const id = typeof tabOrId === 'number' ? tabOrId : tabOrId?.id
      if (!Number.isInteger(id)) throw new TypeError('browser.useTab requires a numeric tab id')
      const tabs = await call('tabs.list')
      const tab = tabs.find((candidate) => candidate.id === id)
      if (!tab) throw new Error(`Chrome tab not found: ${id}`)
      await rememberTabId(id)
      return tab
    },

    async openTab(url = 'about:blank', options = {}) {
      const tab = await call('tabs.open', { url, active: options.active === true })
      await rememberTabId(tab.id)
      if (options.wait !== false && isWebUrl(url)) {
        const loaded = await page.waitForLoadState({ timeout: options.timeout || 20_000 })
        if (!loaded) throw new Error(`Timed out loading ${url}`)
      }
      return tab
    },

    async openOrReuseTab(url, options = {}) {
      if (typeof url !== 'string' || !url) throw new TypeError('browser.openOrReuseTab requires a URL')
      const match = options.match || 'exact'
      const tabs = await call('tabs.list')
      const existing = tabs.find((tab) => matchUrl(tab.url, url, match))
      if (existing) {
        await rememberTabId(existing.id)
        if (options.active === true) await call('tabs.activate', { tabId: existing.id })
        if (options.wait !== false && isWebUrl(existing.url)) {
          const loaded = await page.waitForLoadState({ timeout: options.timeout || 20_000 })
          if (!loaded) throw new Error(`Timed out loading ${existing.url}`)
        }
        return { ...existing, reused: true }
      }
      const tab = await browser.openTab(url, options)
      return { ...tab, reused: false }
    },

    async closeTab(tabOrId = selectedTabId) {
      const id = typeof tabOrId === 'number' ? tabOrId : tabOrId?.id
      if (!Number.isInteger(id)) throw new TypeError('browser.closeTab requires a numeric tab id')
      await call('tabs.close', { tabId: id })
      await clearRememberedTab(id)
      return id
    },

    async activateTab(tabOrId = selectedTabId) {
      const id = typeof tabOrId === 'number' ? tabOrId : tabOrId?.id
      if (!Number.isInteger(id)) throw new TypeError('browser.activateTab requires a numeric tab id')
      const tab = await call('tabs.activate', { tabId: id })
      await rememberTabId(id)
      return tab
    },
  }

  const page = {
    async snapshot(options = {}) {
      return call(
        'page.snapshot',
        {
          tabId: requireSelectedTabId(),
          options: {
            maxChars: options.maxChars ?? 12_000,
            includeText: options.includeText !== false,
          },
        },
        { timeoutMs: options.timeout || 20_000 },
      )
    },

    async click(target, options = {}) {
      return call('page.click', {
        tabId: requireSelectedTabId(),
        target,
        options,
      })
    },

    async fill(target, value, options = {}) {
      return call('page.fill', {
        tabId: requireSelectedTabId(),
        target,
        value: String(value ?? ''),
        options,
      })
    },

    async press(key, options = {}) {
      return call('page.press', {
        tabId: requireSelectedTabId(),
        key,
        options,
      })
    },

    async goto(url, options = {}) {
      const tabId = requireSelectedTabId()
      const result = await call('page.goto', { tabId, url })
      if (options.wait !== false) {
        const loaded = await page.waitForLoadState({ timeout: options.timeout || 20_000 })
        if (!loaded) throw new Error(`Timed out loading ${url}`)
      }
      return result
    },

    async info() {
      return call('page.info', { tabId: requireSelectedTabId() })
    },

    async url() {
      return (await page.info()).url
    },

    async title() {
      return (await page.info()).title
    },

    async evaluate(pageFunction, arg) {
      const expression = serializeEvaluation(pageFunction, arg)
      return call('page.evaluate', {
        tabId: requireSelectedTabId(),
        expression,
      })
    },

    async textContent(selector) {
      return page.evaluate((value) => document.querySelector(value)?.textContent ?? null, selector)
    },

    async count(selector) {
      return page.evaluate((value) => document.querySelectorAll(value).length, selector)
    },

    async findText(text, options = {}) {
      validateText(text)
      return page.evaluate(collectVisibleTextMatches, textSearchArgs(text, options))
    },

    async clickText(text, options = {}) {
      validateText(text)
      const marker = `ego-text-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const selected = await page.evaluate(collectVisibleTextMatches, {
        ...textSearchArgs(text, options),
        marker,
      })
      if (!selected.found) {
        throw new Error(`Visible text not found: ${text}; candidates=${selected.count}`)
      }
      try {
        await page.click(`[data-ego-chrome-text-target="${marker}"]`, options)
        return selected.selected
      } finally {
        await page
          .evaluate((value) => {
            document
              .querySelector(`[data-ego-chrome-text-target="${value}"]`)
              ?.removeAttribute('data-ego-chrome-text-target')
          }, marker)
          .catch(() => {})
      }
    },

    getByText(text, options = {}) {
      validateText(text)
      return {
        click: (clickOptions = {}) => page.clickText(text, { ...options, ...clickOptions }),
        count: async () => (await page.findText(text, options)).count,
        all: async () => (await page.findText(text, options)).matches,
      }
    },

    async waitForSelector(selector, options = {}) {
      const timeout = options.timeout ?? DEFAULT_TIMEOUT
      const state = options.state || 'attached'
      const deadline = Date.now() + timeout
      while (true) {
        try {
          const result = await page.evaluate(
            ({ selector, state }) => {
              const element = document.querySelector(selector)
              const visible = Boolean(
                element &&
                  element.getClientRects().length &&
                  getComputedStyle(element).visibility !== 'hidden',
              )
              if (state === 'detached') return !element
              if (state === 'hidden') return !element || !visible
              if (state === 'visible') return visible
              return Boolean(element)
            },
            { selector, state },
          )
          if (result) return true
        } catch (error) {
          if (!isTransientNavigationError(error)) throw error
        }
        if (Date.now() >= deadline) return false
        await page.waitForTimeout(100)
      }
    },

    async waitForURL(expected, options = {}) {
      const timeout = options.timeout ?? DEFAULT_TIMEOUT
      const deadline = Date.now() + timeout
      while (true) {
        try {
          const href = await page.url()
          if (urlExpectationMatches(href, expected)) return href
        } catch (error) {
          if (!isTransientNavigationError(error)) throw error
        }
        if (Date.now() >= deadline) return false
        await page.waitForTimeout(100)
      }
    },

    async waitForLoadState(options = {}) {
      const timeout = options.timeout ?? 20_000
      const deadline = Date.now() + timeout
      while (true) {
        try {
          const readyState = await page.evaluate(() => document.readyState)
          if (readyState === 'interactive' || readyState === 'complete') return true
        } catch (error) {
          if (!isTransientNavigationError(error)) throw error
        }
        if (Date.now() >= deadline) return false
        await page.waitForTimeout(100)
      }
    },

    async waitForTimeout(ms) {
      await new Promise((resolve) => setTimeout(resolve, Number(ms)))
    },

    locator(selector) {
      if (typeof selector !== 'string' || !selector) throw new TypeError('page.locator requires a selector')
      return createLocator(page, selector)
    },
  }

  const taskSpaces = {
    async list() {
      return [...taskMap.values()]
    },
    async useOrCreate(name) {
      if (typeof name !== 'string' || !name.trim()) throw new TypeError('taskSpaces.useOrCreate requires a name')
      let task = taskMap.get(name)
      if (!task) {
        task = { id: nextTaskId++, name, ownership: 'agent', createdAt: new Date().toISOString() }
        taskMap.set(name, task)
      }
      return task
    },
    async complete(nameOrId, options = {}) {
      const task = findTask(taskMap, nameOrId)
      if (!task) throw new Error(`Task space not found: ${nameOrId}`)
      task.completed = true
      task.keep = options.keep === true
      return { done: true, task }
    },
  }

  return { browser, page, taskSpaces }
}

function createLocator(page, selector) {
  return {
    click: (options) => page.click(selector, options),
    fill: (value, options) => page.fill(selector, value, options),
    press: async (key, options) => {
      await page.evaluate((value) => {
        const element = document.querySelector(value)
        if (!element) throw new Error(`Element not found: ${value}`)
        element.focus()
        return true
      }, selector)
      return page.press(key, options)
    },
    textContent: () => page.textContent(selector),
    count: () => page.count(selector),
    waitFor: (options) => page.waitForSelector(selector, options),
    evaluate: (fn, arg) =>
      page.evaluate(
        ({ selector, source, arg }) => {
          const element = document.querySelector(selector)
          if (!element) throw new Error(`Element not found: ${selector}`)
          return (0, eval)(`(${source})`)(element, arg)
        },
        { selector, source: fn.toString(), arg },
      ),
  }
}

function collectVisibleTextMatches({ text, exact, caseSensitive, nth, selector, marker, maxResults }) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const wantedText = normalize(text)
  const wanted = caseSensitive ? wantedText : wantedText.toLowerCase()
  const root = document.body || document.documentElement
  const interactiveSelector = [
    'button',
    'a[href]',
    'input[type="button"]',
    'input[type="submit"]',
    'summary',
    'label',
    '[role="button"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')

  const visible = (element) => {
    if (!(element instanceof Element)) return false
    const style = getComputedStyle(element)
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0 &&
      element.getClientRects().length > 0
    )
  }

  const textMatches = (value) => {
    const normalized = normalize(value)
    if (!normalized) return false
    const candidate = caseSensitive ? normalized : normalized.toLowerCase()
    return exact ? candidate === wanted : candidate.includes(wanted)
  }

  const candidates = []
  const seen = new Set()

  const addCandidate = (element) => {
    if (!(element instanceof Element) || !visible(element)) return
    let target
    if (selector) {
      target = element.matches(selector) ? element : element.closest(selector)
      if (!target) return
    } else {
      target = element.matches(interactiveSelector) ? element : element.closest(interactiveSelector) || element
    }
    if (!(target instanceof Element) || !visible(target) || seen.has(target)) return
    seen.add(target)
    candidates.push(target)
  }

  const attributeSelector = [
    '[aria-label]',
    '[title]',
    '[alt]',
    'input[value]',
    'button',
    'a[href]',
    '[role]',
    'summary',
    'label',
  ].join(',')

  for (const element of root.querySelectorAll(attributeSelector)) {
    const values = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('alt'),
      element.getAttribute('value'),
      element.innerText,
    ]
    if (values.some(textMatches)) addCandidate(element)
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    if (!textMatches(node.nodeValue)) continue
    addCandidate(node.parentElement)
  }

  candidates.sort((left, right) => {
    if (left === right) return 0
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })

  const summaries = candidates.slice(0, maxResults).map((element, index) => ({
    index,
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || '',
    text: normalize(
      element.getAttribute('aria-label') ||
        element.innerText ||
        element.textContent ||
        element.getAttribute('title'),
    ).slice(0, 300),
  }))

  const target = candidates[nth]
  if (marker && target) target.setAttribute('data-ego-chrome-text-target', marker)

  return {
    found: Boolean(target),
    count: candidates.length,
    selected: target
      ? summaries.find((entry) => entry.index === nth) || {
          index: nth,
          tag: target.tagName.toLowerCase(),
          role: target.getAttribute('role') || '',
          text: normalize(
            target.getAttribute('aria-label') || target.innerText || target.textContent,
          ).slice(0, 300),
        }
      : null,
    matches: summaries,
  }
}

function textSearchArgs(text, options) {
  return {
    text,
    exact: options.exact === true,
    caseSensitive: options.caseSensitive === true,
    nth: Number.isInteger(options.nth) && options.nth >= 0 ? options.nth : 0,
    selector: typeof options.selector === 'string' && options.selector ? options.selector : null,
    marker: null,
    maxResults:
      Number.isInteger(options.maxResults) && options.maxResults > 0
        ? Math.min(options.maxResults, 100)
        : 20,
  }
}

function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('Text locator requires non-empty text')
}

export function serializeEvaluation(pageFunction, arg) {
  if (typeof pageFunction === 'function') {
    return `(${pageFunction.toString()})(${serializeArg(arg)})`
  }
  if (typeof pageFunction === 'string') return pageFunction
  throw new TypeError(`page.evaluate expects a function or string, got ${typeof pageFunction}`)
}

function serializeArg(arg) {
  if (arg === undefined) return 'undefined'
  const value = JSON.stringify(arg)
  if (value === undefined) throw new TypeError('page.evaluate argument must be JSON-serializable')
  return value
}

export function matchUrl(actual, wanted, mode = 'exact') {
  if (!actual) return false
  if (mode === 'includes') return actual.includes(wanted)
  try {
    const a = new URL(actual)
    const w = new URL(wanted)
    if (mode === 'origin') return a.origin === w.origin
    if (mode === 'origin+path') return a.origin === w.origin && trimSlash(a.pathname) === trimSlash(w.pathname)
    return a.href === w.href
  } catch {
    return actual === wanted
  }
}

function urlExpectationMatches(href, expected) {
  if (typeof expected === 'function') return Boolean(expected(new URL(href)))
  if (expected instanceof RegExp) return expected.test(href)
  if (typeof expected === 'string') return href === expected || href.includes(expected)
  throw new TypeError('page.waitForURL expects a string, RegExp, or predicate function')
}

function isTransientNavigationError(error) {
  return /Cannot access|No tab|closed|navigation|context|Execution context was destroyed|Inspected target navigated/i.test(
    error?.message || '',
  )
}

function trimSlash(pathname) {
  return pathname.replace(/\/+$/, '') || '/'
}

function isWebUrl(url) {
  return /^https?:/i.test(url)
}

function findTask(taskMap, nameOrId) {
  if (typeof nameOrId === 'string') return taskMap.get(nameOrId)
  return [...taskMap.values()].find((task) => task.id === nameOrId)
}
