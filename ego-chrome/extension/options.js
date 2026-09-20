const form = document.querySelector('#settings-form')
const tokenInput = document.querySelector('#token')
const portInput = document.querySelector('#port')
const status = document.querySelector('#status')

const saved = await chrome.storage.local.get({ token: '', port: 32145 })
tokenInput.value = saved.token
portInput.value = saved.port

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const token = tokenInput.value.trim()
  const port = Number(portInput.value)
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    status.textContent = 'The token must contain exactly 64 hexadecimal characters.'
    return
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    status.textContent = 'Choose a port from 1024 to 65535.'
    return
  }
  await chrome.storage.local.set({ token, port })
  status.textContent = 'Saved. Checking bridge connection...'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'bridge.status', params: {} }),
      signal: controller.signal,
    })

    if (response.status === 401) {
      status.textContent = 'Saved, but unauthorized (401): the token was rejected by the bridge.'
      return
    }

    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.error) {
      status.textContent = `Saved, but bridge returned an error (${response.status}): ${data.error?.message || 'unknown error'}`
      return
    }

    if (data.result?.bridge === 'connected') {
      const extStatus = data.result.extension === 'connected' ? 'connected' : 'connecting'
      status.textContent = `Saved and connected to bridge on port ${port} (bridge: connected, extension: ${extStatus}).`
    } else {
      status.textContent = `Saved and connected to bridge on port ${port}.`
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      status.textContent = `Saved, but connection check timed out. Bridge at http://127.0.0.1:${port} is unreachable. Run a normal ego-chrome command or 'ego-chrome --doctor' to start/check the bridge.`
    } else {
      status.textContent = `Saved, but local bridge is unreachable on port ${port}. Run a normal ego-chrome command or 'ego-chrome --doctor' to start/check the bridge.`
    }
  } finally {
    clearTimeout(timer)
  }
})
