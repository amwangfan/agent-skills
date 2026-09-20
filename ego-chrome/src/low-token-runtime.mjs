import {
  createRuntime as createBaseRuntime,
  deepQueryAll,
  deepQueryOne,
  evaluateWithDeepQuery,
  isTransientNavigationError,
} from './runtime.mjs'

const SNAPSHOT_DEFAULTS = {
  compact: { maxChars: 3_500, includeText: false },
  normal: { maxChars: 12_000, includeText: true },
  debug: { maxChars: 30_000, includeText: true },
}

export function createRuntime(rpc, options = {}) {
  const base = createBaseRuntime(rpc, options)
  let previousObservation = null

  const baseSnapshot = base.page.snapshot.bind(base.page)
  const baseLocator = base.page.locator.bind(base.page)

  async function snapshot(options = {}) {
    const mode = normalizeMode(options.mode)
    const defaults = SNAPSHOT_DEFAULTS[mode]
    const content = await baseSnapshot({
      ...options,
      maxChars: options.maxChars ?? defaults.maxChars,
      includeText: options.includeText ?? defaults.includeText,
    })
    previousObservation = observationState(content)
    return content
  }

  async function observe(options = {}) {
    const mode = normalizeMode(options.mode || 'compact')
    const defaults = SNAPSHOT_DEFAULTS[mode]
    const content = await baseSnapshot({
      ...options,
      maxChars: options.maxChars ?? Math.min(defaults.maxChars, 2_500),
      includeText: options.includeText ?? defaults.includeText,
    })
    const current = observationState(content)
    const previous = previousObservation
    previousObservation = current

    if (!previous) {
      return {
        changed: true,
        initial: true,
        snapshot: content,
        added: [],
        removed: [],
      }
    }

    const diff = diffLines(previous.lines, current.lines)
    const maxChanges = Number.isInteger(options.maxChanges) && options.maxChanges > 0
      ? Math.min(options.maxChanges, 100)
      : 20
    const totalChanges = diff.added.length + diff.removed.length
    return {
      changed: totalChanges > 0,
      initial: false,
      added: diff.added.slice(0, maxChanges),
      removed: diff.removed.slice(0, maxChanges),
      totalChanges,
      snapshot: options.full === true || totalChanges > maxChanges ? content : undefined,
    }
  }

  function locator(selector) {
    if (typeof selector !== 'string' || !selector) throw new TypeError('page.locator requires a selector')
    return createLowTokenLocator(base.page, baseLocator, selector)
  }

  return {
    ...base,
    page: {
      ...base.page,
      snapshot,
      observe,
      locator,
    },
  }
}

function createLowTokenLocator(page, baseLocator, selector, index = null) {
  const fallback = index === null ? baseLocator(selector) : null
  return {
    first: () => createLowTokenLocator(page, baseLocator, selector, 0),
    nth: (value) => {
      if (!Number.isInteger(value)) throw new TypeError('locator.nth requires an integer')
      return createLowTokenLocator(page, baseLocator, selector, value)
    },
    last: () => createLowTokenLocator(page, baseLocator, selector, -1),
    click: (options) => index === null
      ? fallback.click(options)
      : withIndexedTarget(page, selector, index, (target) => page.click(target, options)),
    fill: (value, options) => index === null
      ? fallback.fill(value, options)
      : withIndexedTarget(page, selector, index, (target) => page.fill(target, value, options)),
    hover: (options) => index === null
      ? fallback.hover(options)
      : withIndexedTarget(page, selector, index, (target) => page.hover(target, options)),
    check: (options) => index === null
      ? fallback.check(options)
      : withIndexedTarget(page, selector, index, (target) => page.check(target, options)),
    uncheck: (options) => index === null
      ? fallback.uncheck(options)
      : withIndexedTarget(page, selector, index, (target) => page.uncheck(target, options)),
    setChecked: (checked, options) => index === null
      ? fallback.setChecked(checked, options)
      : withIndexedTarget(page, selector, index, (target) => page.setChecked(target, checked, options)),
    isChecked: () => index === null
      ? fallback.isChecked()
      : withIndexedTarget(page, selector, index, (target) => page.isChecked(target)),
    selectOption: (values) => index === null
      ? fallback.selectOption(values)
      : withIndexedTarget(page, selector, index, (target) => page.selectOption(target, values)),
    setInputFiles: (files) => index === null
      ? fallback.setInputFiles(files)
      : withIndexedTarget(page, selector, index, (target) => page.setInputFiles(target, files)),
    press: (key, options) => index === null
      ? fallback.press(key, options)
      : withIndexedTarget(page, selector, index, async (target) => {
          await page.evaluate(evaluateWithDeepQuery(({ target: value }) => {
            const element = deepQueryOne(value)
            if (!element) throw new Error(`Element not found: ${value}`)
            element.focus()
          }, { target }))
          return page.press(key, options)
        }),
    count: () => page.count(selector),
    textContent: () => index === null
      ? fallback.textContent()
      : evaluateIndexed(page, selector, index, (element) => element.textContent),
    innerText: () => evaluateIndexed(page, selector, index, (element) => element.innerText),
    inputValue: () => evaluateIndexed(page, selector, index, (element) => element.value ?? null),
    getAttribute: (name) => evaluateIndexed(page, selector, index, (element, value) => element.getAttribute(value), name),
    isVisible: () => evaluateIndexed(page, selector, index, (element) => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
    }),
    allInnerTexts: () => page.evaluate(evaluateWithDeepQuery(({ selector }) =>
      deepQueryAll(selector).map((element) => element.innerText), { selector })),
    allTextContents: () => page.evaluate(evaluateWithDeepQuery(({ selector }) =>
      deepQueryAll(selector).map((element) => element.textContent), { selector })),
    evaluate: (fn, arg) => evaluateIndexed(page, selector, index, fn, arg),
    evaluateAll: (fn, arg) => page.evaluate(evaluateWithDeepQuery(({ selector, source, arg }) =>
      (0, eval)(`(${source})`)(deepQueryAll(selector), arg), {
        selector,
        source: fn.toString(),
        arg,
      })),
    waitFor: (options) => index === null
      ? fallback.waitFor(options)
      : waitForIndexed(page, selector, index, options),
  }
}

async function withIndexedTarget(page, selector, index, action) {
  const marker = `ego-index-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const selected = await page.evaluate(evaluateWithDeepQuery(({ selector, index, marker }) => {
    const nodes = deepQueryAll(selector)
    const resolved = index < 0 ? nodes.length + index : index
    const element = nodes[resolved]
    if (!element) return { found: false, count: nodes.length }
    element.setAttribute('data-ego-chrome-index-target', marker)
    return { found: true, count: nodes.length }
  }, { selector, index, marker }))

  if (!selected.found) {
    throw new Error(`Locator index not found: ${selector}; count=${selected.count}; index=${index}`)
  }

  try {
    return await action(`[data-ego-chrome-index-target="${marker}"]`)
  } finally {
    await page.evaluate(evaluateWithDeepQuery(({ marker }) => {
      deepQueryOne(`[data-ego-chrome-index-target="${marker}"]`)?.removeAttribute('data-ego-chrome-index-target')
    }, { marker })).catch(() => {})
  }
}

async function evaluateIndexed(page, selector, index, fn, arg) {
  return page.evaluate(evaluateWithDeepQuery(({ selector, index, source, arg }) => {
    const nodes = deepQueryAll(selector)
    const resolved = index === null ? 0 : index < 0 ? nodes.length + index : index
    const element = nodes[resolved]
    if (!element) throw new Error(`Element not found: ${selector}; index=${resolved}`)
    return (0, eval)(`(${source})`)(element, arg)
  }, { selector, index, source: fn.toString(), arg }))
}

async function waitForIndexed(page, selector, index, options = {}) {
  const timeout = options.timeout ?? 10_000
  const state = options.state || 'attached'
  const deadline = Date.now() + timeout
  while (true) {
    try {
      const matched = await page.evaluate(evaluateWithDeepQuery(({ selector, index, state }) => {
        const nodes = deepQueryAll(selector)
        const resolved = index < 0 ? nodes.length + index : index
        const element = nodes[resolved]
        const visible = Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
        if (state === 'detached') return !element
        if (state === 'hidden') return !element || !visible
        if (state === 'visible') return visible
        return Boolean(element)
      }, { selector, index, state }))
      if (matched) return true
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error
    }
    if (Date.now() >= deadline) return false
    await page.waitForTimeout(100)
  }
}

function observationState(content) {
  return {
    lines: String(content || '')
      .split(/\r?\n/)
      .map((line) => ({ line, key: normalizeObservationLine(line) }))
      .filter((item) => item.key),
  }
}

function normalizeObservationLine(line) {
  return String(line || '')
    .trim()
    .replace(/^@\d+\s+/, '')
    .replace(/\s+/g, ' ')
}

function diffLines(previous, current) {
  const previousBuckets = bucketLines(previous)
  const currentBuckets = bucketLines(current)
  const added = []
  const removed = []

  for (const [key, items] of currentBuckets) {
    const previousCount = previousBuckets.get(key)?.length || 0
    if (items.length > previousCount) added.push(...items.slice(previousCount).map((item) => item.line))
  }
  for (const [key, items] of previousBuckets) {
    const currentCount = currentBuckets.get(key)?.length || 0
    if (items.length > currentCount) removed.push(...items.slice(currentCount).map((item) => item.key))
  }
  return { added, removed }
}

function bucketLines(items) {
  const buckets = new Map()
  for (const item of items) {
    const list = buckets.get(item.key) || []
    list.push(item)
    buckets.set(item.key, list)
  }
  return buckets
}

function normalizeMode(mode) {
  return Object.prototype.hasOwnProperty.call(SNAPSHOT_DEFAULTS, mode) ? mode : 'compact'
}
