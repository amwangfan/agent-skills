import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { startBridge } from '../src/bridge.mjs'
import { RpcClient } from '../src/rpc-client.mjs'
import { waitForExtension } from '../src/cli.mjs'

const token = 'a'.repeat(64)
const headers = { authorization: `Bearer ${token}` }
const extHeaders = {
  authorization: `Bearer ${token}`,
  origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'content-type': 'application/json',
}

async function rpc(base, method, params = {}, extra = {}) {
  const response = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, ...extra }),
  })
  return { response, body: await response.json() }
}

async function probeExtensionSeen(base) {
  await fetch(`${base}/extension/result`, {
    method: 'POST',
    headers: extHeaders,
    body: JSON.stringify({ id: 'probe-init' }),
  })
}

test('bridge reports extension connection and forwards RPC', async (t) => {
  const server = startBridge({ host: '127.0.0.1', port: 0, token }, { logger: { info() {} } })
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const selected = await rpc(base, 'bridge.session.selectTab', { tabId: 7 })
  assert.equal(selected.response.status, 200)
  assert.deepEqual(selected.body, { result: { tabId: 7 } })
  assert.deepEqual((await rpc(base, 'bridge.session.currentTab')).body, { result: { tabId: 7 } })

  const poll = fetch(`${base}/extension/next`, {
    headers: { ...headers, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  const forwarded = fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'tabs.list', params: {} }),
  })

  const pollResponse = await poll
  assert.equal(pollResponse.status, 200)
  const request = await pollResponse.json()
  assert.equal(request.method, 'tabs.list')

  const resultResponse = await fetch(`${base}/extension/result`, {
    method: 'POST',
    headers: { ...headers, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'content-type': 'application/json' },
    body: JSON.stringify({ id: request.id, result: [{ id: 7 }] }),
  })
  assert.equal(resultResponse.status, 200)

  const rpcResponse = await forwarded
  assert.equal(rpcResponse.status, 200)
  assert.deepEqual(await rpcResponse.json(), { result: [{ id: 7 }] })

  assert.deepEqual((await rpc(base, 'bridge.session.clearTab', { tabId: 7 })).body, { result: { cleared: true } })
  assert.deepEqual((await rpc(base, 'bridge.session.currentTab')).body, { result: null })
})

test('aborted queued request is removed and not delivered to extension', async (t) => {
  const server = startBridge({ host: '127.0.0.1', port: 0, token }, { logger: { info() {} } })
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  await probeExtensionSeen(base)

  const controller = new AbortController()
  const queued1 = once(server, 'queued')
  const aborted1 = once(server, 'aborted')
  const req1 = fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'tabs.get', params: { tabId: 101 } }),
    signal: controller.signal,
  })

  // Ensure req1 has arrived at server and is placed in queue
  await queued1

  // Abort client request 1 while confirmed in queue, and wait for server to process close
  controller.abort()
  await Promise.all([req1.catch(() => {}), aborted1])

  // Queue request 2 (valid)
  const queued2 = once(server, 'queued')
  const req2 = fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'tabs.get', params: { tabId: 102 } }),
  })
  await queued2

  // Extension polls: must receive request 2, skipping aborted request 1
  const pollResponse = await fetch(`${base}/extension/next`, { headers: extHeaders })
  assert.equal(pollResponse.status, 200)
  const message = await pollResponse.json()
  assert.equal(message.params.tabId, 102)

  // Reply to request 2
  await fetch(`${base}/extension/result`, {
    method: 'POST',
    headers: extHeaders,
    body: JSON.stringify({ id: message.id, result: { id: 102 } }),
  })
  const res2 = await req2
  assert.equal(res2.status, 200)
  assert.deepEqual(await res2.json(), { result: { id: 102 } })
})

test('bridge timeout cleans up queued message and returns 504 EXTENSION_TIMEOUT', async (t) => {
  const server = startBridge({ host: '127.0.0.1', port: 0, token }, { logger: { info() {} } })
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  await probeExtensionSeen(base)

  // Request 1 with short timeout
  const res1 = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'tabs.query', params: { q: 'timeout' }, timeoutMs: 50 }),
  })
  assert.equal(res1.status, 504)
  const body1 = await res1.json()
  assert.equal(body1.error?.code, 'EXTENSION_TIMEOUT')

  // Request 2 (valid)
  const queued2 = once(server, 'queued')
  const req2 = fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'tabs.query', params: { q: 'valid' } }),
  })
  await queued2

  // Extension polls: receives request 2, not the timed-out request 1
  const pollResponse = await fetch(`${base}/extension/next`, { headers: extHeaders })
  assert.equal(pollResponse.status, 200)
  const message = await pollResponse.json()
  assert.equal(message.params.q, 'valid')

  await fetch(`${base}/extension/result`, {
    method: 'POST',
    headers: extHeaders,
    body: JSON.stringify({ id: message.id, result: [] }),
  })
  const res2 = await req2
  assert.equal(res2.status, 200)
})

test('timeoutMs in request body affects Bridge timer and forwarded request body', async (t) => {
  const server = startBridge({ host: '127.0.0.1', port: 0, token }, { logger: { info() {} } })
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  await probeExtensionSeen(base)

  const reqPromise = fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'page.eval', params: { expr: '1+1' }, timeoutMs: 120 }),
  })

  const pollResponse = await fetch(`${base}/extension/next`, { headers: extHeaders })
  assert.equal(pollResponse.status, 200)
  const message = await pollResponse.json()
  assert.equal(message.method, 'page.eval')
  assert.equal(message.timeoutMs, 120)

  // Extension does not reply; Bridge should time out at ~120ms
  const start = Date.now()
  const rpcRes = await reqPromise
  const elapsed = Date.now() - start
  assert.equal(rpcRes.status, 504)
  const body = await rpcRes.json()
  assert.equal(body.error?.code, 'EXTENSION_TIMEOUT')
  assert.ok(elapsed >= 80, `Expected elapsed >= 80ms, got ${elapsed}ms`)
})

test('RpcClient forwards timeoutMs and receives structured EXTENSION_TIMEOUT with grace', async (t) => {
  const server = startBridge({ host: '127.0.0.1', port: 0, token }, { logger: { info() {} } })
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  await probeExtensionSeen(base)

  const client = new RpcClient({ host: '127.0.0.1', port: server.address().port, token })
  const rpcPromise = client.request('tabs.get', { tabId: 42 }, { timeoutMs: 80 })

  const pollResponse = await fetch(`${base}/extension/next`, { headers: extHeaders })
  assert.equal(pollResponse.status, 200)
  const message = await pollResponse.json()
  assert.equal(message.timeoutMs, 80)

  // Extension does not reply -> Bridge returns 504, client receives structured error before client abort
  await assert.rejects(rpcPromise, (err) => {
    assert.equal(err.code, 'EXTENSION_TIMEOUT')
    assert.match(err.message, /Chrome extension timed out: tabs\.get/)
    return true
  })
})

test('RpcClient AbortController aborts when server does not respond at all', async (t) => {
  const hungServer = createServer((req, res) => {
    // deliberately do nothing, simulating hung bridge process
  })
  hungServer.listen(0, '127.0.0.1')
  await once(hungServer, 'listening')
  t.after(() => hungServer.close())

  const client = new RpcClient(
    { host: '127.0.0.1', port: hungServer.address().port, token },
    { timeoutMs: 40, graceMs: 40 }
  )

  await assert.rejects(
    client.request('test.hang'),
    /ego-chrome request timed out: test\.hang/
  )
})

test('waitForExtension polls and resolves when extension connects or deadline expires', async () => {
  let callCount = 0
  const mockConnectingClient = {
    async request(method) {
      if (method === 'bridge.status') {
        callCount += 1
        return {
          bridge: 'connected',
          extension: callCount >= 3 ? 'connected' : 'disconnected',
        }
      }
      throw new Error(`Unexpected method ${method}`)
    },
  }

  const resultConnected = await waitForExtension(mockConnectingClient, 1_000, 20)
  assert.equal(resultConnected.extension, 'connected')
  assert.ok(callCount >= 3)

  const mockDisconnectedClient = {
    async request(method) {
      if (method === 'bridge.status') {
        return { bridge: 'connected', extension: 'disconnected' }
      }
      throw new Error(`Unexpected method ${method}`)
    },
  }

  const resultDisconnected = await waitForExtension(mockDisconnectedClient, 60, 20)
  assert.equal(resultDisconnected.extension, 'disconnected')
})

test('bridge clamps timeoutMs within reasonable bounds', async (t) => {
  const server = startBridge({ host: '127.0.0.1', port: 0, token }, { logger: { info() {} } })
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  await probeExtensionSeen(base)

  // 1. Negative timeout clamped to min (10ms)
  const req1Promise = fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'tabs.min', params: {}, timeoutMs: -10 }),
  })
  const poll1 = await fetch(`${base}/extension/next`, { headers: extHeaders })
  const msg1 = await poll1.json()
  assert.equal(msg1.timeoutMs, 10)

  await fetch(`${base}/extension/result`, {
    method: 'POST',
    headers: extHeaders,
    body: JSON.stringify({ id: msg1.id, result: { ok: true } }),
  })
  const res1 = await req1Promise
  assert.equal(res1.status, 200)

  // 2. Huge timeout clamped to max (300,000ms)
  const req2Promise = fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'tabs.max', params: {}, timeoutMs: 999_999_999 }),
  })
  const poll2 = await fetch(`${base}/extension/next`, { headers: extHeaders })
  const msg2 = await poll2.json()
  assert.equal(msg2.timeoutMs, 300_000)

  await fetch(`${base}/extension/result`, {
    method: 'POST',
    headers: extHeaders,
    body: JSON.stringify({ id: msg2.id, result: { ok: true } }),
  })
  const res2 = await req2Promise
  assert.equal(res2.status, 200)
})
