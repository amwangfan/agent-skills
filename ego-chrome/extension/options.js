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
  status.textContent = 'Saved. Click the extension icon if the badge does not change to ON.'
})
