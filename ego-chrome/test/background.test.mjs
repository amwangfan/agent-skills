import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const serviceWorkerUrl = new URL('../extension/service-worker.js', import.meta.url)

test('background automation does not require bringing the tab to front', async () => {
  const source = await readFile(serviceWorkerUrl, 'utf8')

  assert.match(source, /chrome\.tabs\.create\(\{ url: params\.url \|\| 'about:blank', active: params\.active === true \}\)/)
  assert.doesNotMatch(source, /Page\.bringToFront/)
  assert.match(source, /Emulation\.setFocusEmulationEnabled/)
  assert.match(source, /Emulation\.setIdleOverride/)
  assert.match(source, /Page\.setWebLifecycleState/)
  assert.match(source, /autoDiscardable: false/)
})

test('page info exposes actual foreground and document focus state', async () => {
  const source = await readFile(serviceWorkerUrl, 'utf8')

  assert.match(source, /visibilityState: document\.visibilityState/)
  assert.match(source, /documentHasFocus: document\.hasFocus\(\)/)
  assert.match(source, /tabActive: Boolean\(tab\.active\)/)
  assert.match(source, /windowFocused: Boolean\(windowInfo\?\.focused\)/)
  assert.match(source, /backgroundAutomation: backgroundStateByTab\.get\(tabId\)/)
})
