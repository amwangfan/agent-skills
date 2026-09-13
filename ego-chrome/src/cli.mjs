#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createConfig, readConfig } from './config.mjs'
import { RpcClient } from './rpc-client.mjs'
import { createRuntime } from './semantic-runtime.mjs'
import { startBridge } from './bridge.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const HELP = `ego-chrome

Usage:
  ego-chrome init [--force]
  ego-chrome --doctor
  ego-chrome bridge
  ego-chrome -e "console.log(await page.title())"
  <script> | ego-chrome
  <script> | ego-chrome nodejs

PowerShell example:
  @'
  await browser.openOrReuseTab('https://example.com', { active: false })
  console.log(await page.snapshot())
  '@ | ego-chrome
`

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error?.stack || error?.message || String(error))
  process.exitCode = 1
}

async function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP)
    return 0
  }

  if (argv[0] === 'init') {
    const config = await createConfig({ force: argv.includes('--force') })
    console.log(JSON.stringify({ config: config.path, host: config.host, port: config.port, token: config.token }, null, 2))
    return 0
  }

  if (argv[0] === 'bridge') {
    const config = await readConfig()
    const server = startBridge(config)
    await new Promise((resolve, reject) => {
      server.once('close', resolve)
      server.once('error', reject)
    })
    return 0
  }

  if (argv[0] === '--doctor') {
    const config = await readConfig()
    await ensureBridge(config)
    const client = new RpcClient(config, { timeoutMs: 5_000 })
    try {
      const status = await client.request('bridge.status')
      let tabs = null
      if (status.extension === 'connected') {
        tabs = (await client.request('tabs.list')).length
      }
      console.log(JSON.stringify({ ...status, tabs, config: config.path, port: config.port }, null, 2))
      return status.extension === 'connected' ? 0 : 2
    } finally {
      client.close()
    }
  }

  if (argv[0] === 'nodejs') argv.shift()
  let code = ''
  if (argv[0] === '-e' || argv[0] === '--eval') {
    code = argv.slice(1).join(' ')
  } else if (argv.length === 1 && argv[0].endsWith('.js')) {
    code = await readFile(argv[0], 'utf8')
  } else if (argv.length === 0) {
    code = await readStdin()
  } else {
    process.stderr.write(HELP)
    return 2
  }

  if (!code.trim()) {
    process.stderr.write(HELP)
    return 2
  }

  const config = await readConfig()
  await ensureBridge(config)
  const client = new RpcClient(config)
  try {
    await client.connect()
    const status = await client.request('bridge.status')
    if (status.extension !== 'connected') {
      throw new Error('Chrome extension is not connected. Open Chrome, configure the token, and click the extension icon.')
    }
    const context = createRuntime(client)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const names = Object.keys(context)
    const values = Object.values(context)
    const fn = new AsyncFunction(...names, `"use strict";\n${code}`)
    await fn(...values)
    return 0
  } finally {
    client.close()
  }
}

async function ensureBridge(config) {
  if (await canConnect(config)) return

  const child = spawn(process.execPath, [join(here, 'bridge-process.mjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  child.unref()

  const deadline = Date.now() + 3_000
  let lastError
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      if (await canConnect(config)) return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Could not start ego-chrome bridge on ${config.host}:${config.port}${lastError ? `: ${lastError.message}` : ''}`)
}

async function canConnect(config) {
  const client = new RpcClient(config, { timeoutMs: 1_000 })
  try {
    await client.connect()
    await client.request('bridge.status', {}, { timeoutMs: 1_000 })
    return true
  } catch {
    return false
  } finally {
    client.close()
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
