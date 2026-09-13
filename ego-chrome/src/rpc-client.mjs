export class RpcClient {
  constructor(config, options = {}) {
    this.config = config
    this.timeoutMs = options.timeoutMs || 20_000
  }

  async connect() {
    await this.request('bridge.status', {}, { timeoutMs: 2_000 })
    return this
  }

  async request(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`http://${this.config.host}:${this.config.port}/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.error) {
        const error = new Error(body.error?.message || `ego-chrome bridge returned HTTP ${response.status}`)
        error.code = body.error?.code || `HTTP_${response.status}`
        error.data = body.error?.data
        throw error
      }
      return body.result
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`ego-chrome request timed out: ${method}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  close() {}
}
