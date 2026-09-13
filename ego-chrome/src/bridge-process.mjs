#!/usr/bin/env node
import { readConfig } from './config.mjs'
import { startBridge } from './bridge.mjs'

try {
  const config = await readConfig()
  const server = startBridge(config)
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} catch (error) {
  console.error(error?.stack || error)
  process.exitCode = 1
}
