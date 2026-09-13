import { createSemanticSnapshot } from './snapshot.js'

const DEFAULT_PORT = 32145
const refsByTab = new Map()
const attachedTabs = new Set()
const attachPromises = new Map()
const backgroundStateByTab = new Map()
const originalDiscardabilityByTab = new Map()
let pollGeneration = 0
let polling = false
let pollController = null

chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => {})
  chrome.alarms.create('ego-chrome-reconnect', { periodInMinutes: 1 })
  restartPolling()
})
chrome.runtime.onStartup.addListener(restartPolling)
chrome.action.onClicked.addListener(restartPolling)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ego-chrome-reconnect' && !polling) restartPolling()
})
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') restartPolling()
})
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId)
    attachPromises.delete(source.tabId)
    refsByTab.delete(source.tabId)
    backgroundStateByTab.delete(source.tabId)
    void restoreTabDiscardability(source.tabId)
  }
})

restartPolling()

function restartPolling() {
  pollGeneration += 1
  polling = false
  pollController?.abort()
  pollController = new AbortController()
  void pollBridge(pollGeneration, pollController.signal)
}

async function pollBridge(generation, signal) {
  const { token = '', port = DEFAULT_PORT } = await chrome.storage.local.get({ token: '', port: DEFAULT_PORT })
  if (generation !== pollGeneration) return
  if (!token) {
    setBadge('OFF', '#8a8a8a', 'Open options and paste the local bridge token')
    return
  }

  polling = true
  setBadge('…', '#a66b00', 'Connecting to ego-chrome bridge')
  const baseUrl = `http://127.0.0.1:${Number(port)}`
  let delay = 500

  while (generation === pollGeneration) {
    try {
      const response = await fetch(`${baseUrl}/extension/next`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal,
      })
      if (generation !== pollGeneration) break
      if (response.status === 204) {
        setBadge('ON', '#137333', 'Connected to ego-chrome bridge')
        delay = 500
        continue
      }
      if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`)
      setBadge('ON', '#137333', 'Connected to ego-chrome bridge')
      delay = 500
      const message = await response.json()
      const result = await handleRequest(message)
      await fetch(`${baseUrl}/extension/result`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(result),
      })
    } catch (error) {
      if (generation !== pollGeneration || error?.name === 'AbortError') break
      setBadge('OFF', '#8a8a8a', `ego-chrome bridge disconnected: ${error?.message || error}`)
      await sleep(delay)
      delay = Math.min(delay * 2, 15_000)
    }
  }
  if (generation === pollGeneration) polling = false
}

async function handleRequest(message) {
  if (!message?.id || typeof message.method !== 'string') {
    return { id: message?.id, error: { code: 'INVALID_REQUEST', message: 'Invalid bridge request' } }
  }
  try {
    return { id: message.id, result: await dispatch(message.method, message.params || {}) }
  } catch (error) {
    return {
      id: message.id,
      error: { code: error?.code || 'EXTENSION_ERROR', message: error?.message || String(error) },
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function dispatch(method, params) {
  switch (method) {
    case 'tabs.list':
      return listTabs()
    case 'tabs.active':
      return activeTab()
    case 'tabs.open':
      return sanitizeTab(await chrome.tabs.create({ url: params.url || 'about:blank', active: params.active === true }))
    case 'tabs.close':
      await detachTab(params.tabId)
      await chrome.tabs.remove(requireTabId(params.tabId))
      return { closed: true }
    case 'tabs.activate': {
      const tab = await chrome.tabs.update(requireTabId(params.tabId), { active: true })
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true })
      return sanitizeTab(tab)
    }
    case 'page.snapshot':
      return snapshotPage(params.tabId, params.options)
    case 'page.click':
      return clickPage(params.tabId, params.target, params.options)
    case 'page.fill':
      return fillPage(params.tabId, params.target, params.value)
    case 'page.press':
      return pressPage(params.tabId, params.key, params.options)
    case 'page.goto':
      refsByTab.delete(requireTabId(params.tabId))
      return sendCommand(params.tabId, 'Page.navigate', { url: String(params.url) })
    case 'page.info':
      return pageInfo(params.tabId)
    case 'page.evaluate':
      return evaluatePage(params.tabId, String(params.expression))
    default:
      throw rpcError('METHOD_NOT_FOUND', `Unknown extension method: ${method}`)
  }
}

async function snapshotPage(tabId, options = {}) {
  tabId = requireTabId(tabId)
  const info = await evaluatePage(tabId, `(() => ({ title: document.title, url: location.href }))()`)
  const snapshot = await createSemanticSnapshot(sendCommand, tabId, {
    ...options,
    pageTitle: info?.title,
    pageUrl: info?.url,
  })
  const map = new Map(snapshot.refs.map((ref) => [ref.ref, ref]))
  refsByTab.set(tabId, map)
  return snapshot.content
}

async function pageInfo(tabId) {
  tabId = requireTabId(tabId)
  await ensureAttached(tabId)
  const tab = await chrome.tabs.get(tabId)
  const windowInfo = await chrome.windows.get(tab.windowId).catch(() => null)
  const documentInfo = await evaluatePage(tabId, `(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    documentHasFocus: document.hasFocus(),
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    pageWidth: document.documentElement?.scrollWidth || innerWidth,
    pageHeight: document.documentElement?.scrollHeight || innerHeight
  }))()`)
  return {
    ...documentInfo,
    tabActive: Boolean(tab.active),
    windowFocused: Boolean(windowInfo?.focused),
    discarded: Boolean(tab.discarded),
    frozen: Boolean(tab.frozen),
    autoDiscardable: Boolean(tab.autoDiscardable),
    backgroundAutomation: backgroundStateByTab.get(tabId) || null,
  }
}

async function clickPage(tabId, target, options = {}) {
  tabId = requireTabId(tabId)
  const backendNodeId = await resolveTarget(tabId, target)
  await sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => null)
  const model = await sendCommand(tabId, 'DOM.getBoxModel', { backendNodeId })
  const point = quadCenter(model?.model?.content || model?.model?.border)
  const button = options.button || 'left'
  const clickCount = Number(options.clickCount || 1)
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons: buttonMask(button), clickCount })
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount })
  return { clicked: true, x: point.x, y: point.y }
}

async function fillPage(tabId, target, value) {
  tabId = requireTabId(tabId)
  const backendNodeId = await resolveTarget(tabId, target)
  const resolved = await sendCommand(tabId, 'DOM.resolveNode', { backendNodeId, objectGroup: 'ego-chrome' })
  const objectId = resolved?.object?.objectId
  if (!objectId) throw rpcError('ELEMENT_NOT_FOUND', `Could not resolve target: ${target}`)
  const result = await sendCommand(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(value) {
      const element = this;
      element.focus();
      if (element.isContentEditable) {
        element.textContent = value;
      } else {
        let prototype = element;
        let setter;
        while (prototype && !setter) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
          setter = descriptor?.set;
          prototype = Object.getPrototypeOf(prototype);
        }
        if (setter) setter.call(element, value);
        else element.value = value;
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`,
    arguments: [{ value: String(value ?? '') }],
    returnByValue: true,
    awaitPromise: true,
  })
  throwIfRuntimeException(result)
  return true
}

async function pressPage(tabId, keySpec, options = {}) {
  tabId = requireTabId(tabId)
  const parsed = parseKeySpec(String(keySpec))
  const common = {
    key: parsed.key,
    code: parsed.code,
    windowsVirtualKeyCode: parsed.virtualKeyCode,
    nativeVirtualKeyCode: parsed.virtualKeyCode,
    modifiers: parsed.modifiers,
  }
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common })
  if (parsed.text && !parsed.modifiers) {
    await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'char', ...common, text: parsed.text, unmodifiedText: parsed.text })
  }
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  if (options.delay) await new Promise((resolve) => setTimeout(resolve, Number(options.delay)))
  return true
}

async function evaluatePage(tabId, expression) {
  const response = await sendCommand(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  throwIfRuntimeException(response)
  const result = response?.result || {}
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value
  if (Object.prototype.hasOwnProperty.call(result, 'unserializableValue')) return result.unserializableValue
  return null
}

async function resolveTarget(tabId, target) {
  if (typeof target !== 'string' || !target.trim()) throw rpcError('INVALID_TARGET', 'Target must be an @ref or CSS selector')
  const value = target.trim()
  if (/^@\d+$/.test(value)) {
    const ref = refsByTab.get(tabId)?.get(value)
    if (!ref) throw rpcError('STALE_REF', `Unknown or stale ref ${value}; call page.snapshot() again`)
    return ref.backendNodeId
  }
  const document = await sendCommand(tabId, 'DOM.getDocument', { depth: 1, pierce: true })
  const queried = await sendCommand(tabId, 'DOM.querySelector', { nodeId: document.root.nodeId, selector: value })
  if (!queried.nodeId) throw rpcError('ELEMENT_NOT_FOUND', `Element not found: ${value}`)
  const described = await sendCommand(tabId, 'DOM.describeNode', { nodeId: queried.nodeId })
  const backendNodeId = described?.node?.backendNodeId
  if (!backendNodeId) throw rpcError('ELEMENT_NOT_FOUND', `Element has no backend node: ${value}`)
  return backendNodeId
}

async function sendCommand(tabId, method, params = {}) {
  tabId = requireTabId(tabId)
  await ensureAttached(tabId)
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError
      if (error) {
        if (/not attached|No tab with given id|closed/i.test(error.message || '')) attachedTabs.delete(tabId)
        reject(rpcError('CDP_ERROR', `${method}: ${error.message}`))
      } else {
        resolve(result || {})
      }
    })
  })
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return
  if (attachPromises.has(tabId)) return attachPromises.get(tabId)

  const attaching = (async () => {
    const tab = await chrome.tabs.get(tabId)
    if (!isControllableUrl(tab.url)) throw rpcError('UNSUPPORTED_URL', `Chrome cannot debug this page: ${tab.url}`)

    if (!originalDiscardabilityByTab.has(tabId)) {
      originalDiscardabilityByTab.set(tabId, tab.autoDiscardable !== false)
    }
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => null)
    if (tab.discarded) await chrome.tabs.reload(tabId).catch(() => null)

    try {
      await new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, '1.3', () => {
          const error = chrome.runtime.lastError
          if (error) reject(rpcError('ATTACH_FAILED', error.message))
          else resolve()
        })
      })
      attachedTabs.add(tabId)
      await sendCommand(tabId, 'Page.enable').catch(() => null)
      await sendCommand(tabId, 'DOM.enable').catch(() => null)
      backgroundStateByTab.set(tabId, {
        autoDiscardableDisabled: true,
        lifecycleActivated: await tryBackgroundCommand(tabId, 'Page.setWebLifecycleState', { state: 'active' }),
        focusEmulation: await tryBackgroundCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }),
        idleOverride: await tryBackgroundCommand(tabId, 'Emulation.setIdleOverride', {
          isUserActive: true,
          isScreenUnlocked: true,
        }),
      })
    } catch (error) {
      await restoreTabDiscardability(tabId)
      throw error
    }
  })()

  attachPromises.set(tabId, attaching)
  try {
    await attaching
  } finally {
    attachPromises.delete(tabId)
  }
}

async function detachTab(tabId) {
  if (attachedTabs.has(tabId)) {
    await sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => null)
    await sendCommand(tabId, 'Emulation.clearIdleOverride').catch(() => null)
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => resolve()))
  }
  attachedTabs.delete(tabId)
  refsByTab.delete(tabId)
  backgroundStateByTab.delete(tabId)
  await restoreTabDiscardability(tabId)
}

async function tryBackgroundCommand(tabId, method, params = {}) {
  try {
    await sendCommand(tabId, method, params)
    return true
  } catch {
    return false
  }
}

async function restoreTabDiscardability(tabId) {
  if (!originalDiscardabilityByTab.has(tabId)) return
  const autoDiscardable = originalDiscardabilityByTab.get(tabId)
  originalDiscardabilityByTab.delete(tabId)
  await chrome.tabs.update(tabId, { autoDiscardable }).catch(() => null)
}

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return tabs.filter((tab) => tab.id && isControllableUrl(tab.url)).map(sanitizeTab)
}

async function activeTab() {
  const current = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const tab = current.find((candidate) => candidate.id && isControllableUrl(candidate.url))
    || (await chrome.tabs.query({ active: true })).find((candidate) => candidate.id && isControllableUrl(candidate.url))
    || (await listTabs())[0]
  if (!tab) throw rpcError('NO_TAB', 'No controllable Chrome tab is available')
  return sanitizeTab(tab)
}

function sanitizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || '',
    url: tab.url || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
  }
}

function isControllableUrl(url = '') {
  return /^(https?:|file:|about:blank)/i.test(url)
}

function requireTabId(value) {
  const tabId = Number(value)
  if (!Number.isInteger(tabId) || tabId <= 0) throw rpcError('INVALID_TAB', `Invalid tab id: ${value}`)
  return tabId
}

function quadCenter(quad) {
  if (!Array.isArray(quad) || quad.length < 8) throw rpcError('NO_BOX', 'Element has no visible box model')
  return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 }
}

function buttonMask(button) {
  return button === 'right' ? 2 : button === 'middle' ? 4 : 1
}

function throwIfRuntimeException(response) {
  if (!response?.exceptionDetails && response?.result?.subtype !== 'error') return
  const details = response.exceptionDetails
  const message = details?.exception?.description || details?.text || response?.result?.description || 'Page JavaScript failed'
  throw rpcError('PAGE_EVALUATION_ERROR', message)
}

function parseKeySpec(spec) {
  const parts = spec.split('+').map((part) => part.trim()).filter(Boolean)
  const key = parts.pop() || ''
  let modifiers = 0
  for (const modifier of parts) {
    if (/^(alt)$/i.test(modifier)) modifiers |= 1
    else if (/^(control|ctrl)$/i.test(modifier)) modifiers |= 2
    else if (/^(meta|command|cmd|windows)$/i.test(modifier)) modifiers |= 4
    else if (/^shift$/i.test(modifier)) modifiers |= 8
  }
  const named = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8],
    Delete: ['Delete', 46], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38],
    ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35],
    PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: [' ', 32],
  }
  const definition = named[key] || [key, key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0]
  return {
    key: definition[0],
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    virtualKeyCode: definition[1],
    modifiers,
    text: key.length === 1 ? key : key === 'Space' ? ' ' : '',
  }
}

function rpcError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function setBadge(text, color, title) {
  chrome.action.setBadgeText({ text }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {})
  chrome.action.setTitle({ title }).catch(() => {})
}
