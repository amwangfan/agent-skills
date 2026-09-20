export class RpcClient {
  constructor(config, options = {}) {
    this.config = config
    this.timeoutMs = options.timeoutMs || 20_000
    this.graceMs = typeof options.graceMs === 'number' ? options.graceMs : undefined
  }

  async connect() {
    await this.request('bridge.status', {}, { timeoutMs: 2_000 })
    return this
  }

  async request(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs
    const graceMs = typeof options.graceMs === 'number'
      ? options.graceMs
      : (typeof this.graceMs === 'number' ? this.graceMs : Math.max(200, Math.min(1_000, Math.round(timeoutMs * 0.1))))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs + graceMs)

    let onAbort = null
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort(options.signal.reason)
      } else {
        onAbort = () => controller.abort(options.signal.reason)
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    try {
      const response = await fetch(`http://${this.config.host}:${this.config.port}/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method, params, timeoutMs }),
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
        if (options.signal?.aborted) {
          throw (options.signal.reason instanceof Error ? options.signal.reason : new Error(`ego-chrome request aborted: ${method}`))
        }
        throw new Error(`ego-chrome request timed out: ${method}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (options.signal && onAbort) {
        options.signal.removeEventListener('abort', onAbort)
      }
    }
  }

  close() {}
}
