import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_PORT = 32145

export function configPath(env = process.env) {
  const base = env.LOCALAPPDATA || env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'ego-chrome', 'config.json')
}

export async function readConfig(options = {}) {
  const path = options.path || configPath(options.env)
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    validateConfig(raw)
    return { ...raw, path }
  } catch (error) {
    if (error?.code === 'ENOENT' && options.create !== false) {
      return createConfig({ path })
    }
    throw error
  }
}

export async function createConfig(options = {}) {
  const path = options.path || configPath(options.env)
  const existing = await readExisting(path)
  if (existing && !options.force) {
    validateConfig(existing)
    return { ...existing, path }
  }

  const config = {
    host: '127.0.0.1',
    port: Number(options.port || existing?.port || DEFAULT_PORT),
    token: randomBytes(32).toString('hex'),
  }
  validateConfig(config)
  await atomicWriteJson(path, config)
  return { ...config, path }
}

async function readExisting(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temp, path)
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Invalid ego-chrome config')
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    throw new Error('ego-chrome bridge must bind to localhost')
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error(`Invalid ego-chrome port: ${config.port}`)
  }
  if (typeof config.token !== 'string' || !/^[a-f0-9]{64}$/i.test(config.token)) {
    throw new Error('Invalid ego-chrome token; run ego-chrome init --force')
  }
}
