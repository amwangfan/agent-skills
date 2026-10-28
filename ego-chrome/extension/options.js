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
    status.textContent = '令牌必须恰好包含 64 个十六进制字符。'
    return
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    status.textContent = '请选择 1024 至 65535 之间的端口。'
    return
  }
  await chrome.storage.local.set({ token, port })
  status.textContent = '设置已保存，正在检查桥接连接……'

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
      status.textContent = '设置已保存，但认证失败（401）：桥接服务拒绝了该令牌。'
      return
    }

    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.error) {
      status.textContent = `设置已保存，但桥接服务返回错误（${response.status}）：${data.error?.message || '未知错误'}`
      return
    }

    if (data.result?.bridge === 'connected') {
      const extStatus = data.result.extension === 'connected' ? '已连接' : '正在连接'
      status.textContent = `设置已保存，已连接到端口 ${port} 的桥接服务（桥接：已连接，扩展：${extStatus}）。`
    } else {
      status.textContent = `设置已保存，已连接到端口 ${port} 的桥接服务。`
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      status.textContent = `设置已保存，但连接检查超时。无法访问 http://127.0.0.1:${port}。请运行一次正常的 ego-chrome 命令或执行 'ego-chrome --doctor' 来启动/检查桥接服务。`
    } else {
      status.textContent = `设置已保存，但无法连接端口 ${port} 上的本地桥接服务。请运行一次正常的 ego-chrome 命令或执行 'ego-chrome --doctor' 来启动/检查桥接服务。`
    }
  } finally {
    clearTimeout(timer)
  }
})
