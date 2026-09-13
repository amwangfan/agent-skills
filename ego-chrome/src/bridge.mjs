import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/
const MAX_BODY_BYTES = 2 * 1024 * 1024
const EXTENSION_FRESH_MS = 35_000
const POLL_TIMEOUT_MS = 25_000

export function startBridge(config, options = {}) {
  const logger = options.logger || console
  const pending = new Map()
  const queue = []
  const pollWaiters = new Set()
  let extensionLastSeenAt = 0
  let selectedTabId = null

  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, config.token)) return json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
      const url = new URL(request.url, `http://${config.host}:${config.port}`)

      if (url.pathname.startsWith('/extension/')) {
        const origin = request.headers.origin || ''
        if (origin && !EXTENSION_ORIGIN.test(origin)) {
          return json(response, 403, { error: { code: 'INVALID_ORIGIN', message: 'Invalid extension origin' } })
        }
        extensionLastSeenAt = Date.now()
      }

      if (request.method === 'GET' && url.pathname === '/extension/next') {
        if (queue.length) return json(response, 200, queue.shift())
        const waiter = { response }
        waiter.timer = setTimeout(() => {
          pollWaiters.delete(waiter)
          if (!response.writableEnded) response.writeHead(204).end()
        }, POLL_TIMEOUT_MS)
        pollWaiters.add(waiter)
        response.on('close', () => {
          if (response.writableEnded) return
          clearTimeout(waiter.timer)
          pollWaiters.delete(waiter)
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/extension/result') {
        const message = await readJson(request)
        const route = pending.get(message.id)
        if (!route) return json(response, 404, { error: { code: 'UNKNOWN_ROUTE', message: 'Unknown RPC route' } })
        pending.delete(message.id)
        clearTimeout(route.timer)
        json(route.response, message.error ? 500 : 200, message.error ? { error: message.error } : { result: message.result })
        return json(response, 200, { ok: true })
      }

      if (request.method === 'POST' && url.pathname === '/rpc') {
        const message = await readJson(request)
        if (typeof message.method !== 'string') {
          return json(response, 400, { error: { code: 'INVALID_REQUEST', message: 'RPC method is required' } })
        }
        if (message.method === 'bridge.status') {
          return json(response, 200, {
            result: {
              bridge: 'connected',
              extension: Date.now() - extensionLastSeenAt < EXTENSION_FRESH_MS ? 'connected' : 'disconnected',
            },
          })
        }
        if (message.method === 'bridge.session.currentTab') {
          return json(response, 200, { result: selectedTabId ? { tabId: selectedTabId } : null })
        }
        if (message.method === 'bridge.session.selectTab') {
          const tabId = Number(message.params?.tabId)
          if (!Number.isInteger(tabId) || tabId <= 0) {
            return json(response, 400, { error: { code: 'INVALID_TAB', message: `Invalid tab id: ${message.params?.tabId}` } })
          }
          selectedTabId = tabId
          return json(response, 200, { result: { tabId } })
        }
        if (message.method === 'bridge.session.clearTab') {
          const tabId = Number(message.params?.tabId)
          if (!message.params?.tabId || selectedTabId === tabId) selectedTabId = null
          return json(response, 200, { result: { cleared: true } })
        }
        if (Date.now() - extensionLastSeenAt >= EXTENSION_FRESH_MS) {
          return json(response, 503, {
            error: {
              code: 'EXTENSION_DISCONNECTED',
              message: 'Chrome extension is not connected. Start Chrome and click the ego-chrome extension icon.',
            },
          })
        }

        const id = randomUUID()
        const requestMessage = { id, method: message.method, params: message.params || {} }
        const timer = setTimeout(() => {
          const route = pending.get(id)
          if (!route) return
          pending.delete(id)
          json(route.response, 504, { error: { code: 'EXTENSION_TIMEOUT', message: `Chrome extension timed out: ${message.method}` } })
        }, options.requestTimeoutMs || 30_000)
        pending.set(id, { response, timer })
        deliver(requestMessage, queue, pollWaiters)
        response.on('close', () => {
          if (response.writableEnded) return
          const route = pending.get(id)
          if (route?.response === response) {
            clearTimeout(route.timer)
            pending.delete(id)
          }
        })
        return
      }

      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } })
    } catch (error) {
      if (!response.writableEnded) {
        json(response, error?.statusCode || 500, {
          error: { code: error?.code || 'BRIDGE_ERROR', message: error?.message || String(error) },
        })
      }
    }
  })

  server.listen(config.port, config.host, () => {
    const address = server.address()
    logger.info?.(`[ego-chrome] bridge listening on http://${config.host}:${address.port}`)
  })
  return server
}

function deliver(message, queue, waiters) {
  const waiter = waiters.values().next().value
  if (!waiter) {
    queue.push(message)
    return
  }
  waiters.delete(waiter)
  clearTimeout(waiter.timer)
  json(waiter.response, 200, message)
}

function authorized(request, expectedToken) {
  const value = request.headers.authorization || ''
  const actual = value.startsWith('Bearer ') ? value.slice(7) : ''
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expectedToken)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large')
      error.statusCode = 413
      error.code = 'PAYLOAD_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    const error = new Error('Invalid JSON request')
    error.statusCode = 400
    error.code = 'INVALID_JSON'
    throw error
  }
}

function json(response, status, value) {
  if (response.writableEnded) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}
