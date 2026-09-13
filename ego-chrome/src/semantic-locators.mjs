export function createSemanticLocator(page, query, index = null) {
  const selectedIndex = index === null ? 0 : index
  return {
    first: () => createSemanticLocator(page, query, 0),
    nth: (value) => {
      if (!Number.isInteger(value)) throw new TypeError('locator.nth requires an integer')
      return createSemanticLocator(page, query, value)
    },
    last: () => createSemanticLocator(page, query, -1),
    count: () => page.evaluate(semanticQueryOperation, { operation: 'count', query }),
    allInnerTexts: () => page.evaluate(semanticQueryOperation, { operation: 'allInnerTexts', query }),
    allTextContents: () => page.evaluate(semanticQueryOperation, { operation: 'allTextContents', query }),
    click: (options) => withSemanticTarget(page, query, selectedIndex, (target) => page.click(target, options)),
    fill: (value, options) => withSemanticTarget(page, query, selectedIndex, (target) => page.fill(target, value, options)),
    press: (key, options) => withSemanticTarget(page, query, selectedIndex, async (target) => {
      await page.evaluate((value) => {
        const element = document.querySelector(value)
        if (!element) throw new Error(`Element not found: ${value}`)
        element.focus()
      }, target)
      return page.press(key, options)
    }),
    innerText: () => evaluateSemantic(page, query, selectedIndex, (element) => element.innerText),
    textContent: () => evaluateSemantic(page, query, selectedIndex, (element) => element.textContent),
    inputValue: () => evaluateSemantic(page, query, selectedIndex, (element) => element.value ?? null),
    getAttribute: (name) => evaluateSemantic(page, query, selectedIndex, (element, value) => element.getAttribute(value), name),
    isVisible: () => evaluateSemantic(page, query, selectedIndex, (element) => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && element.getClientRects().length > 0
    }),
    evaluate: (fn, arg) => evaluateSemantic(page, query, selectedIndex, fn, arg),
    evaluateAll: (fn, arg) => page.evaluate(semanticQueryOperation, {
      operation: 'evaluateAll',
      query,
      source: fn.toString(),
      arg,
    }),
    waitFor: (options) => waitForSemantic(page, query, selectedIndex, options),
  }
}

export function serializeMatcher(value, exact = false) {
  if (value === undefined || value === null) return null
  if (value instanceof RegExp) return { kind: 'regex', source: value.source, flags: value.flags }
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Semantic locator name must be text or RegExp')
  return {
    kind: 'text',
    value: String(value).replace(/\s+/g, ' ').trim(),
    exact: exact === true,
    caseSensitive: false,
  }
}

async function withSemanticTarget(page, query, index, action) {
  const marker = `ego-semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const selected = await page.evaluate(semanticQueryOperation, { operation: 'mark', query, index, marker })
  if (!selected.found) {
    throw new Error(`Semantic locator did not match; count=${selected.count}; index=${index}`)
  }
  try {
    return await action(`[data-ego-chrome-semantic-target="${marker}"]`)
  } finally {
    await page.evaluate((value) => {
      document.querySelector(`[data-ego-chrome-semantic-target="${value}"]`)?.removeAttribute('data-ego-chrome-semantic-target')
    }, marker).catch(() => {})
  }
}

async function evaluateSemantic(page, query, index, fn, arg) {
  return page.evaluate(semanticQueryOperation, {
    operation: 'evaluateOne',
    query,
    index,
    source: fn.toString(),
    arg,
  })
}

async function waitForSemantic(page, query, index, options = {}) {
  const timeout = options.timeout ?? 10_000
  const state = options.state || 'attached'
  const deadline = Date.now() + timeout
  while (true) {
    const matched = await page.evaluate(semanticQueryOperation, { operation: 'state', query, index, state })
    if (matched) return true
    if (Date.now() >= deadline) return false
    await page.waitForTimeout(100)
  }
}

function semanticQueryOperation(payload) {
  const { operation, query, index = 0, marker, source, arg, state } = payload

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
  const visible = (element) => {
    if (!(element instanceof Element)) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && element.getClientRects().length > 0
  }
  const roleOf = (element) => {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0]
    if (explicit) return explicit.toLowerCase()
    const tag = element.tagName.toLowerCase()
    const type = String(element.getAttribute('type') || '').toLowerCase()
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type))) return 'button'
    if (tag === 'a' && element.hasAttribute('href')) return 'link'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      if (type === 'search') return 'searchbox'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (['button', 'submit', 'reset', 'image', 'hidden'].includes(type)) return ''
      return 'textbox'
    }
    if (tag === 'select') return element.multiple || Number(element.size) > 1 ? 'listbox' : 'combobox'
    if (tag === 'option') return 'option'
    if (tag === 'summary') return 'button'
    if (element.isContentEditable) return 'textbox'
    return ''
  }
  const labelledBy = (element) => String(element.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || '')
    .join(' ')
  const labelsFor = (element) => {
    const labels = element.labels ? Array.from(element.labels) : []
    const wrapped = element.closest('label')
    if (wrapped && !labels.includes(wrapped)) labels.push(wrapped)
    return labels.map((label) => label.innerText || label.textContent).join(' ')
  }
  const buttonValue = (element) => {
    const tag = element.tagName.toLowerCase()
    const type = String(element.getAttribute('type') || '').toLowerCase()
    return tag === 'input' && ['button', 'submit', 'reset'].includes(type) ? element.value : ''
  }
  const accessibleName = (element) => normalize(
    element.getAttribute('aria-label') ||
      labelledBy(element) ||
      labelsFor(element) ||
      element.getAttribute('alt') ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      buttonValue(element) ||
      element.innerText ||
      element.textContent,
  )
  const labelName = (element) => normalize(
    element.getAttribute('aria-label') ||
      labelledBy(element) ||
      labelsFor(element) ||
      element.getAttribute('placeholder') ||
      element.getAttribute('title'),
  )
  const isLabelable = (element) => {
    const tag = element.tagName.toLowerCase()
    return ['input', 'textarea', 'select', 'button'].includes(tag) || element.isContentEditable || ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch'].includes(roleOf(element))
  }
  const matches = (value, matcher) => {
    if (!matcher) return true
    const normalized = normalize(value)
    if (matcher.kind === 'regex') return new RegExp(matcher.source, matcher.flags).test(normalized)
    const actual = matcher.caseSensitive ? normalized : normalized.toLowerCase()
    const expected = matcher.caseSensitive ? matcher.value : matcher.value.toLowerCase()
    return matcher.exact ? actual === expected : actual.includes(expected)
  }
  const collect = () => {
    const root = document.body || document.documentElement
    const selector = 'button, a[href], input, textarea, select, option, summary, [role], [contenteditable="true"], h1, h2, h3, h4, h5, h6'
    return Array.from(root.querySelectorAll(selector)).filter((element) => {
      if (!query.includeHidden && !visible(element)) return false
      if (query.kind === 'role') {
        if (roleOf(element) !== query.role) return false
        return matches(accessibleName(element), query.matcher)
      }
      if (!isLabelable(element)) return false
      return matches(labelName(element), query.matcher)
    })
  }

  const nodes = collect()
  const resolved = index < 0 ? nodes.length + index : index
  const element = nodes[resolved]

  if (operation === 'count') return nodes.length
  if (operation === 'allInnerTexts') return nodes.map((node) => node.innerText)
  if (operation === 'allTextContents') return nodes.map((node) => node.textContent)
  if (operation === 'mark') {
    if (!element) return { found: false, count: nodes.length }
    element.setAttribute('data-ego-chrome-semantic-target', marker)
    return { found: true, count: nodes.length }
  }
  if (operation === 'evaluateOne') {
    if (!element) throw new Error(`Semantic element not found; count=${nodes.length}; index=${index}`)
    return (0, eval)(`(${source})`)(element, arg)
  }
  if (operation === 'evaluateAll') return (0, eval)(`(${source})`)(nodes, arg)
  if (operation === 'state') {
    const isVisible = Boolean(element && visible(element))
    if (state === 'detached') return !element
    if (state === 'hidden') return !element || !isVisible
    if (state === 'visible') return isVisible
    return Boolean(element)
  }
  throw new Error(`Unknown semantic locator operation: ${operation}`)
}
