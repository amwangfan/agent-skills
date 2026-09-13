const ACTION_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
  'slider', 'spinbutton', 'treeitem', 'listbox', 'gridcell',
])

const STRUCTURAL_ROLES = new Set([
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form',
  'dialog', 'alertdialog', 'alert', 'heading', 'table', 'row', 'cell',
  'columnheader', 'rowheader', 'list', 'listitem', 'region', 'article',
])

const TEXT_ROLES = new Set(['StaticText', 'paragraph'])

export async function createSemanticSnapshot(sendCommand, tabId, options = {}) {
  await sendCommand(tabId, 'Accessibility.enable').catch(() => null)
  const [ax, dom] = await Promise.all([
    sendCommand(tabId, 'Accessibility.getFullAXTree'),
    sendCommand(tabId, 'DOMSnapshot.captureSnapshot', {
      computedStyles: ['display', 'visibility', 'opacity', 'pointer-events'],
      includeDOMRects: false,
      includePaintOrder: false,
    }).catch(() => ({ documents: [], strings: [] })),
  ])
  return buildSemanticSnapshot(ax, dom, options)
}

export function buildSemanticSnapshot(axResult, domSnapshot, options = {}) {
  const maxChars = clamp(Number(options.maxChars || 12_000), 1_000, 100_000)
  const includeText = options.includeText !== false
  const nodes = Array.isArray(axResult?.nodes) ? axResult.nodes : []
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const children = new Map()
  for (const node of nodes) {
    if (node.parentId) {
      const list = children.get(node.parentId) || []
      list.push(node.nodeId)
      children.set(node.parentId, list)
    }
  }

  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId))
  const lines = []
  const refs = []
  const usedBackendIds = new Set()
  let refSequence = 1

  const pageTitle = firstNamedRole(nodes, 'RootWebArea') || firstNamedRole(nodes, 'WebArea') || clean(options.pageTitle) || ''
  const pageUrl = firstNodeProperty(nodes, 'url') || clean(options.pageUrl)
  lines.push(`page${pageTitle ? ` ${quote(pageTitle)}` : ''}${pageUrl ? ` url=${quote(pageUrl)}` : ''}`)

  const visit = (node, depth, inheritedName = '') => {
    if (!node || node.ignored) return
    const role = axString(node.role)
    const name = clean(axString(node.name))
    const value = clean(axString(node.value))
    const properties = propertyMap(node.properties)
    const actionable = ACTION_ROLES.has(role)
    const structural = STRUCTURAL_ROLES.has(role)
    const text = includeText && TEXT_ROLES.has(role) && name && name !== inheritedName
    const backendNodeId = node.backendDOMNodeId
    const canReference = actionable && Number.isInteger(backendNodeId)

    let emitted = false
    let nextInheritedName = inheritedName
    if (actionable || structural || text) {
      const ref = canReference ? `@${refSequence++}` : ''
      const label = formatAxLine({ role, name, value, properties, ref })
      if (label) {
        lines.push(`${'  '.repeat(Math.min(depth, 6))}${label}`)
        emitted = true
        if (name) nextInheritedName = name
        if (canReference) {
          refs.push({
            ref,
            backendNodeId,
            role,
            name,
          })
          usedBackendIds.add(backendNodeId)
        }
      }
    }

    const childDepth = emitted && !text ? depth + 1 : depth
    const childIds = node.childIds || children.get(node.nodeId) || []
    for (const childId of childIds) {
      visit(byId.get(childId), childDepth, nextInheritedName)
    }
  }

  for (const root of roots) visit(root, 0)

  for (const fallback of domFallbacks(domSnapshot, usedBackendIds)) {
    if (lines.length === 1) lines.push('main')
    const ref = `@${refSequence++}`
    lines.push(`  ${ref} ${fallback.role} ${quote(fallback.name)} [dom-fallback]`)
    refs.push({ ref, backendNodeId: fallback.backendNodeId, role: fallback.role, name: fallback.name })
  }

  const limited = limitLines(lines, maxChars)
  return { content: limited.content, refs, truncated: limited.truncated }
}

function formatAxLine({ role, name, value, properties, ref }) {
  if (TEXT_ROLES.has(role)) return clean(name).slice(0, 240)
  const shownRole = role === 'RootWebArea' || role === 'WebArea' || role === 'generic' ? '' : role
  if (!shownRole && !ref) return ''
  const parts = []
  if (ref) parts.push(ref)
  if (shownRole) parts.push(shownRole)
  if (name) parts.push(quote(name.slice(0, 240)))
  if (value && value !== name && role !== 'heading') parts.push(`[value=${quote(value.slice(0, 160))}]`)
  for (const key of ['checked', 'selected', 'expanded', 'disabled', 'required', 'readonly', 'level']) {
    if (!properties.has(key)) continue
    const property = properties.get(key)
    if (property === false || property === undefined || property === null) continue
    parts.push(property === true ? `[${key}]` : `[${key}=${String(property)}]`)
  }
  return parts.join(' ')
}

function domFallbacks(snapshot, usedBackendIds) {
  const strings = snapshot?.strings || []
  const result = []
  for (const document of snapshot?.documents || []) {
    const nodes = document.nodes || {}
    const clickable = new Set(nodes.isClickable?.index || [])
    for (const nodeIndex of clickable) {
      const backendNodeId = nodes.backendNodeId?.[nodeIndex]
      if (!Number.isInteger(backendNodeId) || usedBackendIds.has(backendNodeId)) continue
      const tag = stringAt(strings, nodes.nodeName?.[nodeIndex]).toLowerCase()
      const attrs = decodeAttributes(strings, nodes.attributes?.[nodeIndex])
      const name = clean(attrs['aria-label'] || attrs.title || attrs.placeholder || attrs.alt || attrs.name || attrs.value)
      if (!name) continue
      const role = attrs.role || inferRole(tag)
      result.push({ backendNodeId, role, name })
      usedBackendIds.add(backendNodeId)
      if (result.length >= 100) return result
    }
  }
  return result
}

function inferRole(tag) {
  if (tag === 'a') return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'input' || tag === 'textarea') return 'textbox'
  return 'clickable'
}

function decodeAttributes(strings, encoded) {
  const attrs = {}
  if (!Array.isArray(encoded)) return attrs
  for (let index = 0; index < encoded.length; index += 2) {
    const key = stringAt(strings, encoded[index]).toLowerCase()
    const value = stringAt(strings, encoded[index + 1])
    if (key) attrs[key] = value
  }
  return attrs
}

function firstNamedRole(nodes, role) {
  return clean(axString(nodes.find((node) => axString(node.role) === role)?.name))
}

function firstNodeProperty(nodes, name) {
  for (const node of nodes) {
    const value = propertyMap(node.properties).get(name)
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function propertyMap(properties = []) {
  const map = new Map()
  for (const property of properties) {
    map.set(property.name, axValue(property.value))
  }
  return map
}

function axString(value) {
  const resolved = axValue(value)
  return resolved === undefined || resolved === null ? '' : String(resolved)
}

function axValue(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value
  return value
}

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 ? String(strings[index] || '') : ''
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function quote(value) {
  return JSON.stringify(String(value))
}

function limitLines(lines, maxChars) {
  const kept = []
  let length = 0
  let truncated = false
  for (const line of lines) {
    const addition = (kept.length ? 1 : 0) + line.length
    if (length + addition > maxChars) {
      truncated = true
      break
    }
    kept.push(line)
    length += addition
  }
  if (truncated) {
    const marker = '[snapshot truncated; use a smaller page region or direct extraction]'
    while (kept.length > 1 && length + marker.length + 1 > maxChars) {
      const removed = kept.pop()
      length -= removed.length + 1
    }
    kept.push(marker)
  }
  return { content: kept.join('\n'), truncated }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
