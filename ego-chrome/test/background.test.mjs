import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseKeySpec, dispatch } from '../extension/service-worker.js'

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
