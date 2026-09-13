import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { startBridge } from '../src/bridge.mjs'

const token = 'a'.repeat(64)
const headers = { authorization: `Bearer ${token}` }

async function rpc(base, method, params = {}) {
  const response = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  return { response, body: await response.json() }
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
