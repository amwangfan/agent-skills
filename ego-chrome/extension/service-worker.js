import { createSemanticSnapshot } from './snapshot.js'

const DEFAULT_PORT = 32145
const DEFAULT_CDP_TIMEOUT_MS = 25_000

const refsByTab = new Map()
const attachedTabs = new Set()
const attachPromises = new Map()
const backgroundStateByTab = new Map()
const originalDiscardabilityByTab = new Map()
const nextDialogActionByTab = new Map()
const lastDialogByTab = new Map()
const navigationWaitersByTab = new Map()

let pollGeneration = 0
let polling = false
let pollController = null

if (typeof chrome !== 'undefined' && chrome?.runtime?.onInstalled) {
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
  chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupTabState(tabId)
  })
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
      void restoreTabDiscardability(source.tabId)
      cleanupTabState(source.tabId)
    }
  })
  chrome.debugger.onEvent.addListener((source, method, params = {}) => {
    const tabId = source?.tabId
    if (!tabId) return

    if (method === 'Page.javascriptDialogOpening') {
      handleDialogOpening(tabId, params)
      return
    }

    if (method === 'Page.loadEventFired' || method === 'Page.navigatedWithinDocument') {
      handleNavigationEvent(tabId, method, params)
      return
    }
  })

  restartPolling()
}

function cleanupTabState(tabId) {
  attachedTabs.delete(tabId)
  attachPromises.delete(tabId)
  refsByTab.delete(tabId)
  backgroundStateByTab.delete(tabId)
  originalDiscardabilityByTab.delete(tabId)
  nextDialogActionByTab.delete(tabId)
  lastDialogByTab.delete(tabId)
  const waiters = navigationWaitersByTab.get(tabId)
  if (waiters) {
    navigationWaitersByTab.delete(tabId)
    for (const waiter of waiters) {
      waiter.reject(rpcError('TAB_CLOSED', `Tab ${tabId} was closed`))
    }
  }
}

function handleDialogOpening(tabId, params) {
  const configured = nextDialogActionByTab.get(tabId)
  nextDialogActionByTab.delete(tabId)

  // Default is safe dismiss, especially for beforeunload and unhandled dialogs
  const action = configured ? configured.action : 'dismiss'
  const accept = action === 'accept'
  const promptText = configured?.promptText

  lastDialogByTab.set(tabId, {
    type: params.type || 'alert',
    message: params.message || '',
    url: params.url || '',
    defaultPrompt: params.defaultPrompt,
    action,
    promptText,
    timestamp: Date.now(),
  })

  const cdpParams = { accept }
  if (promptText !== undefined && promptText !== null) {
    cdpParams.promptText = String(promptText)
  }

  // Use raw chrome.debugger.sendCommand to avoid recursive ensureAttached
  chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', cdpParams, () => {})
}

function handleNavigationEvent(tabId, method, params) {
  const waiters = navigationWaitersByTab.get(tabId)
  if (!waiters || waiters.size === 0) return

  if (method === 'Page.loadEventFired' || method === 'Page.navigatedWithinDocument') {
    for (const waiter of [...waiters]) {
      waiter.resolve()
    }
  }
}

function registerNavigationWaiter(tabId, timeoutMs, targetUrl) {
  let timer = null
  let resolvePromise
  let rejectPromise
  let settled = false

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  const cleanup = () => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    const waiters = navigationWaitersByTab.get(tabId)
    if (waiters) {
      waiters.delete(waiter)
      if (waiters.size === 0) navigationWaitersByTab.delete(tabId)
    }
  }

  timer = setTimeout(() => {
    cleanup()
    rejectPromise(rpcError('TIMEOUT', `Timed out loading ${targetUrl}`))
  }, timeoutMs)

  const waiter = {
    promise,
    resolve: (val) => {
      cleanup()
      resolvePromise(val)
    },
    reject: (err) => {
      cleanup()
      rejectPromise(err)
    },
    cancel: () => {
      cleanup()
    },
  }

  let waiters = navigationWaitersByTab.get(tabId)
  if (!waiters) {
    waiters = new Set()
    navigationWaitersByTab.set(tabId, waiters)
  }
  waiters.add(waiter)

  return waiter
}

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
      return openTabInExtension(params)
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
      return gotoPage(params.tabId, params.url, params)
    case 'page.setNextDialogAction':
    case 'page.setDialogAction': {
      const tabId = requireTabId(params.tabId)
      const action = params.action === 'accept' ? 'accept' : 'dismiss'
      const promptText = params.promptText !== undefined && params.promptText !== null ? String(params.promptText) : undefined
      nextDialogActionByTab.set(tabId, { action, promptText })
      return { configured: true, action, promptText }
    }
    case 'page.lastDialog': {
      const tabId = requireTabId(params.tabId)
      return lastDialogByTab.get(tabId) || null
    }
    case 'page.info':
      return pageInfo(params.tabId)
    case 'page.evaluate':
      return evaluatePage(params.tabId, String(params.expression))
    default:
      throw rpcError('METHOD_NOT_FOUND', `Unknown extension method: ${method}`)
  }
}

async function openTabInExtension(params) {
  const tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: params.active === true })
  const shouldWait = params.wait !== false && params.url && params.url !== 'about:blank'
  if (shouldWait) {
    const timeout = Number(params.timeout || 20_000)
    const completedTab = await waitForTabLoadComplete(tab.id, timeout, params.url)
    return sanitizeTab(completedTab)
  }
  return sanitizeTab(tab)
}

function waitForTabLoadComplete(tabId, timeoutMs, targetUrl) {
  return new Promise((resolve, reject) => {
    let timer = null
    let settled = false

    const cleanup = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
    }

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return
      const status = changeInfo.status || tab?.status
      const url = tab?.url || changeInfo.url || ''
      if (status === 'complete' && url && url !== 'about:blank') {
        cleanup()
        resolve(tab || { id: tabId, url, status })
      }
    }

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return
      cleanup()
      reject(rpcError('TAB_CLOSED', `Tab ${tabId} was closed before loading completed`))
    }

    timer = setTimeout(() => {
      cleanup()
      reject(rpcError('TIMEOUT', `Timed out loading ${targetUrl || 'page'}`))
    }, timeoutMs)

    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)

    chrome.tabs.get(tabId).then((currentTab) => {
      if (settled) return
      if (currentTab && currentTab.status === 'complete' && currentTab.url && currentTab.url !== 'about:blank') {
        cleanup()
        resolve(currentTab)
      }
    }).catch(() => {})
  })
}

async function gotoPage(tabId, url, options = {}) {
  tabId = requireTabId(tabId)
  refsByTab.delete(tabId)
  await ensureAttached(tabId)

  const targetUrl = String(url)
  const shouldWait = options.wait !== false
  const timeoutMs = Number(options.timeout || 20_000)

  let navWaiter = null
  if (shouldWait) {
    navWaiter = registerNavigationWaiter(tabId, timeoutMs, targetUrl)
  }

  try {
    const result = await sendCommand(tabId, 'Page.navigate', { url: targetUrl })
    if (result?.errorText) {
      if (navWaiter) navWaiter.cancel()
      throw rpcError('NAVIGATION_FAILED', `Navigation failed: ${result.errorText}`)
    }

    if (shouldWait && navWaiter) {
      if (!result.loaderId) {
        navWaiter.resolve(result)
      }
      await navWaiter.promise
    }
    return result
  } catch (error) {
    if (navWaiter) navWaiter.cancel()
    throw error
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
  try {
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
  } finally {
    await sendCommand(tabId, 'Runtime.releaseObjectGroup', { objectGroup: 'ego-chrome' }).catch(() => null)
  }
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
  if (parsed.text && !(parsed.modifiers & ~8)) {
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

async function sendCommand(tabId, method, params = {}, options = {}) {
  tabId = requireTabId(tabId)
  await ensureAttached(tabId)
  const timeoutMs = Number(options?.timeoutMs || options?.timeout || DEFAULT_CDP_TIMEOUT_MS)

  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(rpcError('CDP_TIMEOUT', `CDP command timed out after ${timeoutMs}ms: ${method}`))
    }, timeoutMs)

    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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

function verifyDebuggerSession(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}, () => {
      resolve(!chrome.runtime.lastError)
    })
  })
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return
  if (attachPromises.has(tabId)) return attachPromises.get(tabId)

  const attaching = (async () => {
    const tab = await chrome.tabs.get(tabId)
    const tabUrl = tab.url || tab.pendingUrl || ''
    if (!isControllableUrl(tabUrl)) throw rpcError('UNSUPPORTED_URL', `Chrome cannot debug this page: ${tabUrl}`)

    if (!originalDiscardabilityByTab.has(tabId)) {
      originalDiscardabilityByTab.set(tabId, tab.autoDiscardable !== false)
    }
    await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => null)
    if (tab.discarded) await chrome.tabs.reload(tabId).catch(() => null)

    try {
      let attachError = null
      await new Promise((resolve) => {
        chrome.debugger.attach({ tabId }, '1.3', () => {
          attachError = chrome.runtime.lastError || null
          resolve()
        })
      })
      if (attachError) {
        if (/already attached/i.test(attachError.message || '')) {
          const verified = await verifyDebuggerSession(tabId)
          if (!verified) {
            throw rpcError('ATTACH_FAILED', attachError.message)
          }
        } else {
          throw rpcError('ATTACH_FAILED', attachError.message)
        }
      }
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
  tabId = requireTabId(tabId)
  if (attachedTabs.has(tabId)) {
    await sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => null)
    await sendCommand(tabId, 'Emulation.clearIdleOverride').catch(() => null)
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => resolve()))
  }
  await restoreTabDiscardability(tabId)
  cleanupTabState(tabId)
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
  return tabs.filter((tab) => tab.id && isControllableUrl(tab.url || tab.pendingUrl || '')).map(sanitizeTab)
}

async function activeTab() {
  const current = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const tab = current.find((candidate) => candidate.id && isControllableUrl(candidate.url || candidate.pendingUrl || ''))
    || (await chrome.tabs.query({ active: true })).find((candidate) => candidate.id && isControllableUrl(candidate.url || candidate.pendingUrl || ''))
    || (await listTabs())[0]
  if (!tab) throw rpcError('NO_TAB', 'No controllable Chrome tab is available')
  return sanitizeTab(tab)
}

function sanitizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || '',
    url: tab.url || tab.pendingUrl || '',
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
  const raw = String(spec || '').trim()
  if (!raw) {
    return { key: '', code: '', virtualKeyCode: 0, modifiers: 0, text: '' }
  }

  let key = ''
  let modifierParts = []

  if (raw === '+') {
    key = '+'
  } else if (raw.endsWith('++')) {
    key = '+'
    modifierParts = raw.slice(0, -2).split('+').map((p) => p.trim()).filter(Boolean)
  } else {
    const parts = raw.split('+').map((part) => part.trim()).filter(Boolean)
    key = parts.pop() || ''
    modifierParts = parts
  }

  let modifiers = 0
  for (const modifier of modifierParts) {
    if (/^(alt)$/i.test(modifier)) modifiers |= 1
    else if (/^(control|ctrl)$/i.test(modifier)) modifiers |= 2
    else if (/^(meta|command|cmd|windows)$/i.test(modifier)) modifiers |= 4
    else if (/^shift$/i.test(modifier)) modifiers |= 8
  }

  const hasShift = Boolean(modifiers & 8)
  const shiftDigits = { '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' }
  const shiftSymbols = { '=': '+', '-': '_', '[': '{', ']': '}', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~', '\\': '|' }

  let code = key
  let virtualKeyCode = 0
  let text = ''

  const named = {
    Enter: ['Enter', 13, 'Enter'],
    Tab: ['Tab', 9, 'Tab'],
    Escape: ['Escape', 27, 'Escape'],
    Backspace: ['Backspace', 8, 'Backspace'],
    Delete: ['Delete', 46, 'Delete'],
    ArrowLeft: ['ArrowLeft', 37, 'ArrowLeft'],
    ArrowUp: ['ArrowUp', 38, 'ArrowUp'],
    ArrowRight: ['ArrowRight', 39, 'ArrowRight'],
    ArrowDown: ['ArrowDown', 40, 'ArrowDown'],
    Home: ['Home', 36, 'Home'],
    End: ['End', 35, 'End'],
    PageUp: ['PageUp', 33, 'PageUp'],
    PageDown: ['PageDown', 34, 'PageDown'],
    Space: [' ', 32, 'Space'],
  }

  if (named[key]) {
    const def = named[key]
    key = def[0]
    virtualKeyCode = def[1]
    code = def[2]
    text = key === ' ' ? ' ' : ''
  } else if (/^[0-9]$/.test(key)) {
    code = `Digit${key}`
    virtualKeyCode = key.charCodeAt(0)
    if (hasShift && shiftDigits[key]) {
      key = shiftDigits[key]
      text = key
    } else {
      text = key
    }
  } else if (/^[a-zA-Z]$/.test(key)) {
    code = `Key${key.toUpperCase()}`
    virtualKeyCode = key.toUpperCase().charCodeAt(0)
    key = hasShift ? key.toUpperCase() : key
    text = key
  } else if (key === '+' || key.toLowerCase() === 'plus') {
    key = '+'
    code = 'Equal'
    virtualKeyCode = 187
    text = '+'
  } else if (key === '=') {
    code = 'Equal'
    virtualKeyCode = 187
    if (hasShift) {
      key = '+'
      text = '+'
    } else {
      text = '='
    }
  } else if (key.length === 1) {
    code = key
    virtualKeyCode = key.charCodeAt(0)
    if (hasShift && shiftSymbols[key]) {
      key = shiftSymbols[key]
    }
    text = key
  }

  return {
    key,
    code,
    virtualKeyCode,
    modifiers,
    text,
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

export {
  parseKeySpec,
  isControllableUrl,
  cleanupTabState,
  handleDialogOpening,
  handleNavigationEvent,
  registerNavigationWaiter,
  waitForTabLoadComplete,
  gotoPage,
  openTabInExtension,
  ensureAttached,
  detachTab,
  sendCommand,
  verifyDebuggerSession,
  attachedTabs,
  nextDialogActionByTab,
  lastDialogByTab,
  navigationWaitersByTab,
  refsByTab,
  backgroundStateByTab,
  originalDiscardabilityByTab,
  dispatch,
}
