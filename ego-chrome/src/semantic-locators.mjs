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
        const findElement = (root) => {
          if (!root) return null
          if (typeof root.querySelector === 'function') {
            try {
              const el = root.querySelector(value)
              if (el) return el
            } catch {}
          }
          const walker = (node) => {
            if (!node) return null
            if (node.shadowRoot) {
              const found = findElement(node.shadowRoot)
              if (found) return found
            }
            const children = node.children || []
            for (let i = 0; i < children.length; i++) {
              const found = walker(children[i])
              if (found) return found
            }
            return null
          }
          return walker(root)
        }
        const start = document.body || document.documentElement || document
        const element = findElement(start)
        if (!element) throw new Error(`Element not found: ${value}`)
        if (typeof element.focus === 'function') element.focus()
      }, target)
      return page.press(key, options)
    }),
    hover: (options) => withSemanticTarget(page, query, selectedIndex, (target) => page.hover(target, options)),
    check: (options) => withSemanticTarget(page, query, selectedIndex, (target) => page.check(target, options)),
    uncheck: (options) => withSemanticTarget(page, query, selectedIndex, (target) => page.uncheck(target, options)),
    setChecked: (checked, options) => withSemanticTarget(page, query, selectedIndex, (target) => page.setChecked(target, checked, options)),
    isChecked: () => withSemanticTarget(page, query, selectedIndex, (target) => page.isChecked(target)),
    selectOption: (values) => withSemanticTarget(page, query, selectedIndex, (target) => page.selectOption(target, values)),
    setInputFiles: (files) => withSemanticTarget(page, query, selectedIndex, (target) => page.setInputFiles(target, files)),
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
    await page.evaluate(semanticQueryOperation, { operation: 'unmark', marker }).catch(() => {})
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
    try {
      const matched = await page.evaluate(semanticQueryOperation, { operation: 'state', query, index, state })
      if (matched) return true
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error
    }
    if (Date.now() >= deadline) return false
    await page.waitForTimeout(100)
  }
}

export function isTransientNavigationError(error) {
  const message = typeof error === 'string' ? error : error?.message || ''
  return /Cannot access|No tab|closed|navigation|context|Execution context was destroyed|Execution context destroyed|Inspected target navigated/i.test(
    message,
  )
}

export function semanticQueryOperation(payload) {
  const { operation, query, index = 0, marker, source, arg, state } = payload

  if (operation === 'unmark') {
    const attr = 'data-ego-chrome-semantic-target'
    const sel = `[${attr}="${marker}"]`
    if (typeof document !== 'undefined' && document.querySelector) {
      const el = document.querySelector(sel)
      if (el) {
        el.removeAttribute(attr)
        return true
      }
    }
    const remove = (node) => {
      if (!node) return false
      if (typeof node.removeAttribute === 'function' && node.getAttribute?.(attr) === marker) {
        node.removeAttribute(attr)
        return true
      }
      if (node.shadowRoot && remove(node.shadowRoot)) {
        return true
      }
      const children = node.children ? Array.from(node.children) : []
      for (const child of children) {
        if (remove(child)) return true
      }
      return false
    }
    const root = document.body || document.documentElement || document
    remove(root)
    return true
  }

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
    if (tag === 'dialog') return 'dialog'
    if (tag === 'table') return 'table'
    if (tag === 'tr') return 'row'
    if (tag === 'td') return 'cell'
    if (tag === 'th') {
      const scope = element.getAttribute('scope')?.toLowerCase()
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader'
      return 'columnheader'
    }
    if (tag === 'ul' || tag === 'ol' || tag === 'menu') return 'list'
    if (tag === 'li') return 'listitem'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'header') return element.closest?.('article, aside, main, nav, section') ? '' : 'banner'
    if (tag === 'footer') return element.closest?.('article, aside, main, nav, section') ? '' : 'contentinfo'
    if (tag === 'aside') return 'complementary'
    if (tag === 'article') return 'article'
    if (tag === 'img') return element.getAttribute('alt') === '' ? '' : 'img'
    if (tag === 'progress') return 'progressbar'
    return ''
  }

  const findElementById = (element, id) => {
    if (!id) return null
    const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : null
    if (rootNode && rootNode !== document) {
      if (typeof rootNode.getElementById === 'function') {
        const target = rootNode.getElementById(id)
        if (target) return target
      }
      if (typeof rootNode.querySelector === 'function') {
        try {
          const idSelector = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
          const target = rootNode.querySelector(`#${idSelector}`)
          if (target) return target
        } catch {}
      }
    }
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      const docTarget = document.getElementById(id)
      if (docTarget) return docTarget
    }
    return null
  }

  const labelledBy = (element) => String(element.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => {
      const target = findElementById(element, id)
      return target ? (target.innerText || target.textContent || '') : ''
    })
    .filter(Boolean)
    .join(' ')

  const resolveLabels = (scope, id) => {
    if (!scope || typeof scope.querySelectorAll !== 'function') return []
    try {
      const idSelector = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
      return Array.from(scope.querySelectorAll(`label[for="${idSelector}"]`))
    } catch {
      const explicitLabels = scope.querySelectorAll('label[for]')
      return Array.from(explicitLabels).filter((label) => label.getAttribute('for') === id)
    }
  }

  const labelsFor = (element) => {
    const labels = element.labels ? Array.from(element.labels) : []
    if (element.id) {
      const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : null
      let explicitLabels = []
      if (rootNode && rootNode !== document) {
        explicitLabels = resolveLabels(rootNode, element.id)
      }
      if (explicitLabels.length === 0 && typeof document !== 'undefined') {
        explicitLabels = resolveLabels(document, element.id)
      }
      for (const label of explicitLabels) {
        if (!labels.includes(label)) labels.push(label)
      }
    }
    const wrapped = element.closest?.('label')
    if (wrapped && !labels.includes(wrapped)) labels.push(wrapped)
    return labels.map((label) => label.innerText || label.textContent || '').join(' ')
  }

  const tableCaption = (element) => {
    if (element.tagName.toLowerCase() === 'table') {
      const caption = element.querySelector?.('caption')
      if (caption) return caption.innerText || caption.textContent || ''
    }
    return ''
  }
  const buttonValue = (element) => {
    const tag = element.tagName.toLowerCase()
    const type = String(element.getAttribute('type') || '').toLowerCase()
    return tag === 'input' && ['button', 'submit', 'reset'].includes(type) ? element.value : ''
  }
  const accessibleName = (element) => normalize(
    labelledBy(element) ||
      element.getAttribute('aria-label') ||
      labelsFor(element) ||
      tableCaption(element) ||
      element.getAttribute('alt') ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      buttonValue(element) ||
      element.innerText ||
      element.textContent,
  )
  const labelName = (element) => normalize(
    labelledBy(element) ||
      element.getAttribute('aria-label') ||
      labelsFor(element) ||
      element.getAttribute('placeholder') ||
      element.getAttribute('title'),
  )
  const isLabelable = (element) => {
    const tag = element.tagName.toLowerCase()
    return ['input', 'textarea', 'select', 'button', 'meter', 'output', 'progress'].includes(tag) ||
      element.isContentEditable ||
      tag.includes('-') ||
      ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox'].includes(roleOf(element))
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
    const root = document.body || document.documentElement || document
    const allowHidden = query.includeHidden || (operation === 'state' && (state === 'attached' || state === 'detached'))

    const candidates = []
    const seen = new Set()

    const matchesCandidate = (element) => {
      if (!allowHidden && !visible(element)) return false
      if (query.kind === 'role') {
        if (roleOf(element) !== query.role) return false
        return matches(accessibleName(element), query.matcher)
      }
      if (!isLabelable(element)) return false
      return matches(labelName(element), query.matcher)
    }

    const walk = (node) => {
      if (!node) return
      const children = node.children ? Array.from(node.children) : []
      for (const child of children) {
        if (!seen.has(child)) {
          seen.add(child)
          if (matchesCandidate(child)) {
            candidates.push(child)
          }
        }
        if (child.shadowRoot) {
          walk(child.shadowRoot)
        }
        walk(child)
      }
    }

    if (root && root.shadowRoot) {
      walk(root.shadowRoot)
    }
    walk(root)
    return candidates
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
