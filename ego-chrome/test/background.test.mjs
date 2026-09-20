import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  parseKeySpec,
  dispatch,
  attachedTabs,
  refsByTab,
  hoverPage,
  isCheckedPage,
  setCheckedPage,
  selectOptionPage,
  normalizeSelectValues,
  setInputFilesPage,
  resolveTarget,
} from '../extension/service-worker.js'

const serviceWorkerUrl = new URL('../extension/service-worker.js', import.meta.url)

test('background automation does not require bringing the tab to front', async () => {
  const source = await readFile(serviceWorkerUrl, 'utf8')

  assert.match(source, /chrome\.tabs\.create\(\{ url: params\.url \|\| 'about:blank', active: params\.active === true \}\)/)
  assert.doesNotMatch(source, /Page\.bringToFront/)
  assert.match(source, /Emulation\.setFocusEmulationEnabled/)
  assert.match(source, /Emulation\.setIdleOverride/)
  assert.match(source, /Page\.setWebLifecycleState/)
  assert.match(source, /autoDiscardable: false/)
})

test('page info exposes actual foreground and document focus state', async () => {
  const source = await readFile(serviceWorkerUrl, 'utf8')

  assert.match(source, /visibilityState: document\.visibilityState/)
  assert.match(source, /documentHasFocus: document\.hasFocus\(\)/)
  assert.match(source, /tabActive: Boolean\(tab\.active\)/)
  assert.match(source, /windowFocused: Boolean\(windowInfo\?\.focused\)/)
  assert.match(source, /backgroundAutomation: backgroundStateByTab\.get\(tabId\)/)
})

test('parseKeySpec handles plus, Shift+character, and digit codes correctly', () => {
  const plusSpec = parseKeySpec('+')
  assert.equal(plusSpec.key, '+')
  assert.equal(plusSpec.code, 'Equal')
  assert.equal(plusSpec.virtualKeyCode, 187)
  assert.equal(plusSpec.text, '+')
  assert.equal(plusSpec.modifiers, 0)

  const ctrlPlus = parseKeySpec('Ctrl++')
  assert.equal(ctrlPlus.key, '+')
  assert.equal(ctrlPlus.code, 'Equal')
  assert.equal(ctrlPlus.modifiers, 2)
  assert.equal(ctrlPlus.text, '+')

  const shiftPlus = parseKeySpec('Shift++')
  assert.equal(shiftPlus.key, '+')
  assert.equal(shiftPlus.code, 'Equal')
  assert.equal(shiftPlus.modifiers, 8)
  assert.equal(shiftPlus.text, '+')

  const shiftA = parseKeySpec('Shift+a')
  assert.equal(shiftA.key, 'A')
  assert.equal(shiftA.code, 'KeyA')
  assert.equal(shiftA.virtualKeyCode, 65)
  assert.equal(shiftA.modifiers, 8)
  assert.equal(shiftA.text, 'A')

  const shiftOne = parseKeySpec('Shift+1')
  assert.equal(shiftOne.key, '!')
  assert.equal(shiftOne.code, 'Digit1')
  assert.equal(shiftOne.virtualKeyCode, 49)
  assert.equal(shiftOne.modifiers, 8)
  assert.equal(shiftOne.text, '!')

  const digitZero = parseKeySpec('0')
  assert.equal(digitZero.code, 'Digit0')
  assert.equal(digitZero.key, '0')
  assert.equal(digitZero.text, '0')

  const digitNine = parseKeySpec('9')
  assert.equal(digitNine.code, 'Digit9')
  assert.equal(digitNine.key, '9')
  assert.equal(digitNine.text, '9')

  const enter = parseKeySpec('Enter')
  assert.equal(enter.code, 'Enter')
  assert.equal(enter.virtualKeyCode, 13)

  const space = parseKeySpec('Space')
  assert.equal(space.key, ' ')
  assert.equal(space.text, ' ')
})

test('resilience patterns are present in service-worker source', async () => {
  const source = await readFile(serviceWorkerUrl, 'utf8')

  assert.match(source, /tab\.url \|\| tab\.pendingUrl/)
  assert.match(source, /chrome\.tabs\.onRemoved\.addListener/)
  assert.match(source, /Runtime\.releaseObjectGroup/)
  assert.match(source, /Page\.javascriptDialogOpening/)
  assert.match(source, /Page\.loadEventFired/)
  assert.match(source, /verifyDebuggerSession/)
  assert.match(source, /DEFAULT_CDP_TIMEOUT_MS/)
})

test('listTabs, activeTab, and sanitizeTab support pendingUrl in source and behavior', async () => {
  const source = await readFile(serviceWorkerUrl, 'utf8')

  assert.match(source, /isControllableUrl\(\s*tab\.url\s*\|\|\s*tab\.pendingUrl\s*\|\|\s*''\s*\)/)
  assert.match(source, /isControllableUrl\(\s*candidate\.url\s*\|\|\s*candidate\.pendingUrl\s*\|\|\s*''\s*\)/)
  assert.match(source, /url:\s*tab\.url\s*\|\|\s*tab\.pendingUrl\s*\|\|\s*''/)

  const originalChrome = globalThis.chrome
  try {
    globalThis.chrome = {
      tabs: {
        async query(queryInfo) {
          if (queryInfo.active && queryInfo.lastFocusedWindow) {
            return [{ id: 101, pendingUrl: 'https://example.com/pending-focused', windowId: 1, active: true }]
          }
          if (queryInfo.active) {
            return [{ id: 101, pendingUrl: 'https://example.com/pending-focused', windowId: 1, active: true }]
          }
          return [
            { id: 101, pendingUrl: 'https://example.com/pending-focused', windowId: 1, active: true },
            { id: 102, pendingUrl: 'https://example.com/pending-unfocused', windowId: 1, active: false },
            { id: 103, pendingUrl: 'chrome://newtab', windowId: 1, active: false },
            { id: 104, url: 'https://example.com/normal', windowId: 1, active: false },
          ]
        },
      },
    }

    const tabs = await dispatch('tabs.list')
    assert.deepEqual(tabs, [
      { id: 101, windowId: 1, title: '', url: 'https://example.com/pending-focused', active: true, pinned: false },
      { id: 102, windowId: 1, title: '', url: 'https://example.com/pending-unfocused', active: false, pinned: false },
      { id: 104, windowId: 1, title: '', url: 'https://example.com/normal', active: false, pinned: false },
    ])

    const active = await dispatch('tabs.active')
    assert.deepEqual(active, {
      id: 101,
      windowId: 1,
      title: '',
      url: 'https://example.com/pending-focused',
      active: true,
      pinned: false,
    })

    // Fallback in activeTab when active queries return no controllable tabs
    globalThis.chrome = {
      tabs: {
        async query(queryInfo) {
          if (queryInfo.active) {
            return [{ id: 201, url: 'chrome://settings', windowId: 1, active: true }]
          }
          return [
            { id: 202, pendingUrl: 'https://example.com/fallback-pending', windowId: 1, active: false },
          ]
        },
      },
    }
    const fallbackActive = await dispatch('tabs.active')
    assert.equal(fallbackActive.id, 202)
    assert.equal(fallbackActive.url, 'https://example.com/fallback-pending')
  } finally {
    if (originalChrome !== undefined) {
      globalThis.chrome = originalChrome
    } else {
      delete globalThis.chrome
    }
  }
})

function createMockCdpContext(tabId = 1) {
  const calls = []
  const originalChrome = globalThis.chrome
  attachedTabs.add(tabId)

  let handler = () => ({})

  globalThis.chrome = {
    runtime: {
      lastError: null,
    },
    debugger: {
      sendCommand(target, method, params, callback) {
        calls.push({ method, params, tabId: target?.tabId })
        try {
          const res = handler(method, params, { calls, tabId: target?.tabId })
          callback(res ?? {})
        } catch (err) {
          globalThis.chrome.runtime.lastError = err
          callback(undefined)
          globalThis.chrome.runtime.lastError = null
        }
      },
    },
  }

  return {
    calls,
    setHandler(fn) {
      handler = fn
    },
    restore() {
      attachedTabs.delete(tabId)
      refsByTab.delete(tabId)
      if (originalChrome !== undefined) globalThis.chrome = originalChrome
      else delete globalThis.chrome
    },
  }
}

test('dispatch registers 0.3.0 RPC methods and rejects unknown methods', async () => {
  const ctx = createMockCdpContext(10)
  try {
    // Unknown method throws METHOD_NOT_FOUND (including unregistered page.check / page.uncheck)
    await assert.rejects(
      async () => dispatch('page.unknownMethod', { tabId: 10 }),
      (err) => err?.code === 'METHOD_NOT_FOUND'
    )
    await assert.rejects(
      async () => dispatch('page.check', { tabId: 10 }),
      (err) => err?.code === 'METHOD_NOT_FOUND'
    )
    await assert.rejects(
      async () => dispatch('page.uncheck', { tabId: 10 }),
      (err) => err?.code === 'METHOD_NOT_FOUND'
    )

    // Verify invalid tabId fails fast before calling CDP
    await assert.rejects(
      async () => dispatch('page.hover', { tabId: 'invalid', target: '#target' }),
      (err) => err?.code === 'INVALID_TAB'
    )
    await assert.rejects(
      async () => dispatch('page.isChecked', { tabId: 'invalid', target: '#target' }),
      (err) => err?.code === 'INVALID_TAB'
    )
    await assert.rejects(
      async () => dispatch('page.setChecked', { tabId: 'invalid', target: '#target', checked: true }),
      (err) => err?.code === 'INVALID_TAB'
    )
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 'invalid', target: '#target', values: ['a'] }),
      (err) => err?.code === 'INVALID_TAB'
    )
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 'invalid', target: '#target', files: [] }),
      (err) => err?.code === 'INVALID_TAB'
    )
  } finally {
    ctx.restore()
  }
})

test('page.hover calculates box center and dispatches trusted mouseMoved', async () => {
  const ctx = createMockCdpContext(1)
  try {
    ctx.setHandler((method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 10 } }
      if (method === 'DOM.scrollIntoViewIfNeeded') return {}
      if (method === 'DOM.getBoxModel') {
        return {
          model: {
            content: [10, 20, 50, 20, 50, 60, 10, 60],
          },
        }
      }
      if (method === 'Input.dispatchMouseEvent') return {}
      return {}
    })

    const result = await dispatch('page.hover', { tabId: 1, target: '#hover-me' })
    assert.deepEqual(result, { hovered: true, x: 30, y: 40 })

    const mouseMoves = ctx.calls.filter((c) => c.method === 'Input.dispatchMouseEvent')
    assert.equal(mouseMoves.length, 1)
    assert.deepEqual(mouseMoves[0].params, {
      type: 'mouseMoved',
      x: 30,
      y: 40,
      button: 'none',
      modifiers: 0,
    })
  } finally {
    ctx.restore()
  }
})

test('page.isChecked detects checked state for native and aria elements, and releases object group', async () => {
  const ctx = createMockCdpContext(1)
  try {
    let currentElement = {
      tagName: 'input',
      type: 'checkbox',
      checked: true,
      getAttribute(a) { return a === 'type' ? 'checkbox' : null },
    }

    ctx.setHandler((method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 10 } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-check' } }
      if (method === 'Runtime.callFunctionOn') {
        const fn = eval('(' + params.functionDeclaration + ')')
        try {
          const val = fn.call(currentElement)
          return { result: { value: val } }
        } catch (err) {
          return { exceptionDetails: { exception: { description: err.message } } }
        }
      }
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    // Native checkbox checked
    const checked = await dispatch('page.isChecked', { tabId: 1, target: '#chk' })
    assert.equal(checked, true)
    assert.ok(ctx.calls.some((c) => c.method === 'Runtime.releaseObjectGroup' && c.params?.objectGroup === 'ego-chrome-check-inspect'))

    // Native checkbox unchecked
    currentElement.checked = false
    const unchecked = await dispatch('page.isChecked', { tabId: 1, target: '#chk' })
    assert.equal(unchecked, false)

    // Aria switch
    currentElement = {
      tagName: 'div',
      getAttribute(a) {
        if (a === 'role') return 'switch'
        if (a === 'aria-checked') return 'true'
        return null
      },
    }
    const ariaChecked = await dispatch('page.isChecked', { tabId: 1, target: '#switch' })
    assert.equal(ariaChecked, true)

    // Non-checkable element throws NOT_CHECKABLE
    currentElement = {
      tagName: 'button',
      getAttribute() { return null },
    }
    await assert.rejects(
      async () => dispatch('page.isChecked', { tabId: 1, target: '#btn' }),
      (err) => err?.code === 'NOT_CHECKABLE'
    )
  } finally {
    ctx.restore()
  }
})

test('page.setChecked is idempotent and toggles state with trusted click', async () => {
  const ctx = createMockCdpContext(1)
  try {
    const element = {
      tagName: 'input',
      type: 'checkbox',
      checked: true,
      getAttribute(a) { return a === 'type' ? 'checkbox' : null },
    }

    ctx.setHandler((method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 10 } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } }
      if (method === 'Runtime.callFunctionOn') {
        const fn = eval('(' + params.functionDeclaration + ')')
        try {
          const val = fn.call(element)
          return { result: { value: val } }
        } catch (err) {
          return { exceptionDetails: { exception: { description: err.message } } }
        }
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (method === 'DOM.scrollIntoViewIfNeeded') return {}
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed') {
          element.checked = !element.checked
        }
        return {}
      }
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    // 1. Idempotent: already checked -> no click
    const res1 = await dispatch('page.setChecked', { tabId: 1, target: '#chk', checked: true })
    assert.deepEqual(res1, { checked: true, changed: false })
    assert.equal(ctx.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').length, 0)

    // 2. Uncheck: checked -> false with click
    const res2 = await dispatch('page.setChecked', { tabId: 1, target: '#chk', checked: false })
    assert.deepEqual(res2, { checked: false, changed: true })
    assert.equal(element.checked, false)
    assert.ok(ctx.calls.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed'))

    // 3. Idempotent: already unchecked -> no click
    const countBefore = ctx.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').length
    const res3 = await dispatch('page.setChecked', { tabId: 1, target: '#chk', checked: false })
    assert.deepEqual(res3, { checked: false, changed: false })
    assert.equal(ctx.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').length, countBefore)

    // 4. Check again: false -> true with click
    const res4 = await dispatch('page.setChecked', { tabId: 1, target: '#chk', checked: true })
    assert.deepEqual(res4, { checked: true, changed: true })
    assert.equal(element.checked, true)
  } finally {
    ctx.restore()
  }
})

test('page.setChecked rejects unchecking already checked native radio button', async () => {
  const ctx = createMockCdpContext(1)
  try {
    const radioElement = {
      tagName: 'input',
      type: 'radio',
      checked: true,
      getAttribute(a) { return a === 'type' ? 'radio' : null },
    }

    ctx.setHandler((method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 10 } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-radio' } }
      if (method === 'Runtime.callFunctionOn') {
        const fn = eval('(' + params.functionDeclaration + ')')
        return { result: { value: fn.call(radioElement) } }
      }
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    // Setting checked=true on already checked radio: idempotent, no error, no click
    const resTrue = await dispatch('page.setChecked', { tabId: 1, target: '#radio', checked: true })
    assert.deepEqual(resTrue, { checked: true, changed: false })
    assert.equal(ctx.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').length, 0)

    // Setting checked=false on checked native radio: must throw CANNOT_UNCHECK_RADIO
    await assert.rejects(
      async () => dispatch('page.setChecked', { tabId: 1, target: '#radio', checked: false }),
      (err) => {
        assert.equal(err?.code, 'CANNOT_UNCHECK_RADIO')
        assert.match(err?.message, /cannot uncheck/i)
        return true
      }
    )
    // Verify no click was attempted
    assert.equal(ctx.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').length, 0)
  } finally {
    ctx.restore()
  }
})

test('page.selectOption supports single and multi-select, descriptors, and event dispatch', async () => {
  const ctx = createMockCdpContext(1)
  try {
    const dispatchedEvents = []
    let selectElement = {
      tagName: 'select',
      multiple: false,
      options: [
        { value: 'apple', text: 'Apple', label: 'Apple', selected: true },
        { value: 'banana', text: 'Banana', label: 'Banana', selected: false },
        { value: 'cherry', text: 'Cherry', label: 'Cherry', selected: false },
      ],
      get selectedOptions() {
        return this.options.filter((o) => o.selected)
      },
      dispatchEvent(e) {
        dispatchedEvents.push(e.type)
      },
    }

    ctx.setHandler((method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 10 } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-select' } }
      if (method === 'Runtime.callFunctionOn') {
        const fn = eval('(' + params.functionDeclaration + ')')
        const args = (params.arguments || []).map((a) => a.value)
        try {
          const val = fn.apply(selectElement, args)
          return { result: { value: val } }
        } catch (err) {
          return { exceptionDetails: { exception: { description: err.message } } }
        }
      }
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    // 1. Select by label on single-select -> dispatches input and change
    const res1 = await dispatch('page.selectOption', {
      tabId: 1,
      target: '#fruit',
      values: [{ label: 'Banana' }],
    })
    assert.deepEqual(res1, ['banana'])
    assert.deepEqual(dispatchedEvents, ['input', 'change'])
    assert.equal(selectElement.options[0].selected, false)
    assert.equal(selectElement.options[1].selected, true)

    // 2. Select same option again -> no change, returns current value without dispatching events
    dispatchedEvents.length = 0
    const res2 = await dispatch('page.selectOption', {
      tabId: 1,
      target: '#fruit',
      values: [{ value: 'banana' }],
    })
    assert.deepEqual(res2, ['banana'])
    assert.equal(dispatchedEvents.length, 0)

    // 3. Option not found -> throws OPTION_NOT_FOUND
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: [{ value: 'mango' }] }),
      (err) => err?.code === 'OPTION_NOT_FOUND'
    )

    // 4. Multiple descriptors on single-select -> throws INVALID_OPTIONS
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: [{ value: 'apple' }, { value: 'cherry' }] }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )

    // 4b. Empty descriptor object {} or unknown key -> throws INVALID_OPTIONS
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: [{}] }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: [{ value: 'apple', extraKey: true }] }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )

    // 4c. Negative or non-integer index -> throws INVALID_OPTIONS
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: [{ index: -1 }] }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: [{ index: 'invalid' }] }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )

    // 4d. Unidentifiable items (null, boolean) -> throws INVALID_OPTIONS
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: [null] }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: [true] }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )

    // 4e. null or undefined values -> throws INVALID_OPTIONS
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: null }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit', values: undefined }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#fruit' }),
      (err) => err?.code === 'INVALID_OPTIONS'
    )

    // 4f. Explicit empty array clears select
    dispatchedEvents.length = 0
    const resCleared = await dispatch('page.selectOption', {
      tabId: 1,
      target: '#fruit',
      values: [],
    })
    assert.deepEqual(resCleared, [])
    assert.deepEqual(dispatchedEvents, ['input', 'change'])
    assert.equal(selectElement.options[0].selected, false)
    assert.equal(selectElement.options[1].selected, false)
    assert.equal(selectElement.options[2].selected, false)

    // 5. Multi-select with index and value descriptors
    selectElement = {
      tagName: 'select',
      multiple: true,
      options: [
        { value: 'r', text: 'Red', label: 'Red', selected: false },
        { value: 'g', text: 'Green', label: 'Green', selected: false },
        { value: 'b', text: 'Blue', label: 'Blue', selected: false },
      ],
      get selectedOptions() {
        return this.options.filter((o) => o.selected)
      },
      dispatchEvent(e) {
        dispatchedEvents.push(e.type)
      },
    }
    dispatchedEvents.length = 0
    const resMulti = await dispatch('page.selectOption', {
      tabId: 1,
      target: '#colors',
      values: [{ index: 0 }, { value: 'b' }],
    })
    assert.deepEqual(resMulti, ['r', 'b'])
    assert.deepEqual(dispatchedEvents, ['input', 'change'])

    // 6. Non-select target -> throws NOT_SELECT_ELEMENT
    selectElement = {
      tagName: 'input',
    }
    await assert.rejects(
      async () => dispatch('page.selectOption', { tabId: 1, target: '#not-select', values: ['a'] }),
      (err) => err?.code === 'NOT_SELECT_ELEMENT'
    )

    // Object group release verified
    assert.ok(ctx.calls.some((c) => c.method === 'Runtime.releaseObjectGroup' && c.params?.objectGroup === 'ego-chrome-select'))
  } finally {
    ctx.restore()
  }
})

test('page.setInputFiles validates input[type=file], sets files via CDP, and does not return paths', async () => {
  const ctx = createMockCdpContext(1)
  try {
    let inputElement = {
      tagName: 'input',
      type: 'file',
      getAttribute(a) { return a === 'type' ? 'file' : null },
    }

    ctx.setHandler((method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 15 } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-file' } }
      if (method === 'Runtime.callFunctionOn') {
        const fn = eval('(' + params.functionDeclaration + ')')
        try {
          const val = fn.call(inputElement)
          return { result: { value: val } }
        } catch (err) {
          return { exceptionDetails: { exception: { description: err.message } } }
        }
      }
      if (method === 'DOM.setFileInputFiles') return {}
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    // 1. Valid file paths
    const files = ['C:\\workspace\\test.pdf', 'C:\\workspace\\report.docx']
    const res = await dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files })
    assert.deepEqual(res, { count: 2 })
    // Ensure file paths are NOT exposed in result
    assert.equal(res.files, undefined)

    const cdpFileCall = ctx.calls.find((c) => c.method === 'DOM.setFileInputFiles')
    assert.ok(cdpFileCall)
    assert.deepEqual(cdpFileCall.params, {
      files,
      backendNodeId: 15,
    })

    // 2. Empty array to clear
    const clearRes = await dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files: [] })
    assert.deepEqual(clearRes, { count: 0 })

    // 3. Reject non-file input
    inputElement = {
      tagName: 'input',
      type: 'text',
      getAttribute(a) { return a === 'type' ? 'text' : null },
    }
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 1, target: '#text-input', files: ['C:\\a.txt'] }),
      (err) => err?.code === 'INVALID_TARGET'
    )

    // 4. Reject non-string items or empty strings in files array with INVALID_FILES
    inputElement = {
      tagName: 'input',
      type: 'file',
      getAttribute(a) { return a === 'type' ? 'file' : null },
    }
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files: [{}] }),
      (err) => err?.code === 'INVALID_FILES'
    )
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files: [123] }),
      (err) => err?.code === 'INVALID_FILES'
    )
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files: [''] }),
      (err) => err?.code === 'INVALID_FILES'
    )
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files: ['   '] }),
      (err) => err?.code === 'INVALID_FILES'
    )
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files: '' }),
      (err) => err?.code === 'INVALID_FILES'
    )
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files: null }),
      (err) => err?.code === 'INVALID_FILES'
    )
    await assert.rejects(
      async () => dispatch('page.setInputFiles', { tabId: 1, target: '#file-input', files: undefined }),
      (err) => err?.code === 'INVALID_FILES'
    )

    // Object group release verified
    assert.ok(ctx.calls.some((c) => c.method === 'Runtime.releaseObjectGroup' && c.params?.objectGroup === 'ego-chrome-files'))
  } finally {
    ctx.restore()
  }
})

test('resolveTarget supports DOM.querySelector fast path, Open Shadow DOM search, @ref, and releases objectGroup', async () => {
  const ctx = createMockCdpContext(1)
  try {
    let querySelectorNodeId = 10
    let evaluateResult = null

    ctx.setHandler((method, params) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: querySelectorNodeId }
      if (method === 'DOM.describeNode') {
        if (params.nodeId === 10) return { node: { backendNodeId: 100 } }
        if (params.objectId === 'shadow-obj') return { node: { backendNodeId: 200 } }
        return {}
      }
      if (method === 'Runtime.evaluate') {
        return evaluateResult || { result: { type: 'object', subtype: 'null' } }
      }
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    // 1. Fast path: DOM.querySelector succeeds
    querySelectorNodeId = 10
    const backendId1 = await resolveTarget(1, '#main-button')
    assert.equal(backendId1, 100)
    assert.equal(ctx.calls.filter((c) => c.method === 'Runtime.evaluate').length, 0)

    // 2. Open Shadow DOM fallback: DOM.querySelector fails (nodeId: 0), Runtime.evaluate finds element
    querySelectorNodeId = 0
    evaluateResult = { result: { type: 'object', objectId: 'shadow-obj' } }
    const backendId2 = await resolveTarget(1, 'custom-element >>> button')
    assert.equal(backendId2, 200)
    assert.ok(ctx.calls.some((c) => c.method === 'Runtime.evaluate'))
    assert.ok(ctx.calls.some((c) => c.method === 'DOM.describeNode' && c.params?.objectId === 'shadow-obj'))
    assert.ok(ctx.calls.some((c) => c.method === 'Runtime.releaseObjectGroup' && c.params?.objectGroup === 'ego-chrome-resolve'))

    // 3. Not found in light or shadow DOM -> throws ELEMENT_NOT_FOUND
    querySelectorNodeId = 0
    evaluateResult = { result: { type: 'object', subtype: 'null' } }
    await assert.rejects(
      async () => resolveTarget(1, '#non-existent'),
      (err) => err?.code === 'ELEMENT_NOT_FOUND'
    )

    // 4. @ref lookup
    refsByTab.set(1, new Map([['@1', { backendNodeId: 300 }]]))
    const refId = await resolveTarget(1, '@1')
    assert.equal(refId, 300)

    // Stale @ref lookup
    await assert.rejects(
      async () => resolveTarget(1, '@999'),
      (err) => err?.code === 'STALE_REF'
    )
  } finally {
    ctx.restore()
  }
})

test('normalizeSelectValues validates values and only allows explicit empty array to clear', () => {
  assert.throws(() => normalizeSelectValues(null), (err) => err?.code === 'INVALID_OPTIONS')
  assert.throws(() => normalizeSelectValues(undefined), (err) => err?.code === 'INVALID_OPTIONS')
  assert.deepEqual(normalizeSelectValues([]), [])
  assert.deepEqual(normalizeSelectValues('foo'), [{ value: 'foo' }])
  assert.deepEqual(normalizeSelectValues(0), [{ index: 0 }])
  assert.deepEqual(normalizeSelectValues({ label: 'Bar' }), [{ label: 'Bar' }])
  assert.throws(() => normalizeSelectValues(true), (err) => err?.code === 'INVALID_OPTIONS')
})
