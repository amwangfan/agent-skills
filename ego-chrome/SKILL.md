---
name: ego-chrome
description: >-
  Control the user's current Chrome profile through the local ego-chrome extension and CLI. Use for navigation, forms, dynamic interfaces, extraction, and browser testing that benefit from existing login state. Minimize execution rounds and model input: keep predictable work in one invocation, prefer semantic locators and bounded DOM reads, and use compact snapshots only when the state is genuinely unknown.
metadata:
  version: "0.2.1"
---

# ego-chrome

`ego-chrome` exposes the user's running Chrome profile through a CLI-accessible Node.js runtime. The preloaded `page`, `page.locator(...)`, and `browser` facades use Playwright-style names while reusing the user's current login state.

Run browser work as a PowerShell here-string piped to `ego-chrome nodejs`. Put JavaScript directly in the here-string; do not create a temporary script, import Playwright, launch another browser, or invent helper names.

**A here-string is only the JavaScript container; the shell invocation is the execution round. Default to one shell invocation for the whole browser task.** Each `await` is an internal operation, not a step boundary. Before launch, encode every predictable observation, action, wait, extraction, verification, and bounded alternative in the script. Use browser results immediately in JavaScript and keep adapting in-process until the task completes; do not exit merely to inspect intermediate output or plan the next action. Start another command only for required user or external control, or a process-level failure the script cannot recover from.

**Choose the least-stateful reliable route before inspecting page controls.** When the task specifies an outcome or constraints but not a required interaction, prefer an already-correct state or a known stable URL or site route that directly encodes them; verify the resulting goal state instead of replaying equivalent filters, sorting, or navigation through the UI. Use page controls when the user requested that interaction, the interaction itself is under test, or no reliable equivalent is known. Never invent a brittle route.

**Treat an already-satisfied postcondition as completed work.** Before manipulating a control whose required value may already be visible, perform only the smallest read needed to decide that state. If it matches, do not open its editor, replay the interaction, or read it again; continue directly to the remaining unsatisfied outcomes. Words such as “set”, “select”, or “ensure” describe the required final state unless the user explicitly requires the transition or the interaction itself is under test.

**Freeze the time window for current or relative-date work.** Establish “today/current/latest” once from the user/task environment or explicitly verified current page state before collecting records. Treat content timestamps as data, not as the clock. Older records revealed by scrolling, virtualization, reload, cache, or a changed result batch must not replace that anchor.

When the user explicitly asks for ego-chrome, assume the CLI and runtime are ready. Do not preflight Node versions, package metadata, help, or `--doctor`. Investigate setup only after the first real browser command reports a connection or installation error.

## Quick start

```powershell
@'
await browser.openTab('https://example.com', { active: false, wait: true })
const heading = await page.getByRole('heading').first().innerText()
const info = await page.info()
if (!heading || !info.url) throw new Error('Page was not ready')
console.log(JSON.stringify({ heading, url: info.url }))
'@ | ego-chrome nodejs
```

Keep all predictable work inside the script. Emit one small final JSON object with only the requested result and enough evidence to prove completion. Do not print intermediate snapshots, candidate dumps, or progress logs.

## Explicit tab selection

Every invocation must select a tab before `page.*`:

```javascript
await browser.openTab(url, { active: false, wait: true })
await browser.openOrReuseTab(url, { active: false, match: 'exact', wait: true })
await browser.continueLastTab()
await browser.useActiveTab()
await browser.useTab(tabId)
```

- “Open” means `browser.openTab()` in a new background tab.
- Reuse only when the user asks for it or duplicate avoidance matters.
- `continueLastTab()` is only for a necessary follow-up invocation.
- `useActiveTab()` is only for an explicit reference to the visible tab.
- `page.goto()` navigates the already selected workflow tab; it never selects one.

## Lowest-token observation ladder

Use the lowest rung that can determine the next action:

1. Known URL, known semantic locator, known selector, or final-state read.
2. Bounded collection read: `count`, `allInnerTexts`, `evaluateAll`, `inputValue`, `getAttribute`.
3. Bounded text candidates: `page.findText(...)`.
4. Incremental change: `page.observe()` after a baseline snapshot or observe.
5. Compact semantic snapshot only for an unfamiliar state.
6. Normal snapshot only when compact output is inadequate.

Never dump full HTML or a broad `querySelectorAll('*')` result. Map collections to only the fields needed for the decision and bound the number of returned items.

```javascript
await page.snapshot()                                  // compact, about 3500 chars
await page.snapshot({ mode: 'compact', maxChars: 2000 })
await page.snapshot({ mode: 'normal', maxChars: 12000 })
const change = await page.observe({ maxChanges: 12 })
```

Do not snapshot after every action. Re-snapshot only after navigation, a major DOM replacement, a stale ref, or a materially unknown state. Snapshot `@N` refs belong only to the latest snapshot in the current invocation.

## Semantic locators first

Prefer stable semantic locators over selector discovery:

```javascript
await page.getByRole('button', { name: /save/i }).click()
await page.getByLabel('Email').fill('me@example.com')
const headings = await page.getByRole('heading').allInnerTexts()
```

For page-specific collections, extract structured candidates once, choose in JavaScript, act, and verify without leaving the invocation:

```powershell
@'
await browser.openTab('https://example.com/search', { active: false, wait: true })
const cards = page.locator('article')
const items = await cards.evaluateAll((nodes) => nodes.slice(0, 20).map((node) => ({
  title: node.querySelector('h2')?.textContent?.trim(),
  href: node.querySelector('a')?.href,
})))
const chosenIndex = items.findIndex((item) => item.title && item.href)
if (chosenIndex < 0) throw new Error('No usable result')
const before = await page.url()
const navigated = page.waitForURL((url) => url.href !== before, { timeout: 15000 })
await cards.nth(chosenIndex).click()
if (!(await navigated)) throw new Error('Chosen result did not navigate')
console.log(JSON.stringify({ chosen: items[chosenIndex], opened: await page.url() }))
'@ | ego-chrome nodejs
```

## Dynamic interfaces

For menus, popups, account choosers, listboxes, dialogs, and nested custom elements:

1. Try `getByRole` or `getByLabel`.
2. Use a bounded `findText()` or `clickText()` when accessible semantics are weak.
3. Use one compact snapshot only if the new state remains unknown.

```javascript
const candidates = await page.findText('Settings', {
  exact: false,
  selector: '[role="menuitem"], [role="option"], button, a, li',
  maxResults: 10,
})
if (!candidates.count) throw new Error('Settings action was not found')
await page.clickText('Settings', {
  exact: true,
  selector: '[role="menuitem"], button, a, li',
})
```

Do not stop merely because an ordinary menu, chooser, popup, or dialog opened. Continue through normal selections. Ask the user only for a password, passkey, CAPTCHA, security key, two-factor code, recovery confirmation, payment authorization, destructive confirmation, or another genuine human/secret checkpoint.

## Execution rules

- `page.url()` is asynchronous; always use `await page.url()`. A `page.waitForURL(...)` predicate receives a `URL` object.
- `page.waitForURL`, `page.waitForLoadState`, `page.waitForSelector`, and locator `waitFor` return a falsy value on timeout. Check the result or immediately verify the required state.
- Register navigation or result-state waits before the action that triggers them. Prefer state-based waits; use `waitForTimeout` only for brief settling.
- When page structure is unknown, collect relevant controls or candidates once with `evaluateAll`, `allInnerTexts`, `findText`, or one compact snapshot. Derive the next actions in JavaScript instead of enumerating selector guesses across commands.
- Let a successful action carry the script forward. Read state when it determines a branch and once for the required final postconditions, not after every action.
- On failure, use one targeted observation to change strategy materially. Do not repeat near-identical locators, commands, or snapshots.
- When a required click may navigate the current tab or open another one, click once and resolve the result from the URL plus a refreshed `browser.listTabs()` inside the same script. Do not silently replace a user-requested interaction with direct navigation.

## Interaction paths

1. **Semantic: locators and compact snapshots.** Use for normal DOM pages.
2. **Direct DOM: locator collections and `page.evaluate`.** Use for bounded structured extraction and page-wide state.
3. **Capability boundary.** Canvas, WebGL, maps, remote desktops, and visual-only editors cannot be reliably understood without a separate visual tool. Do not guess coordinates.

Combine available paths within the same invocation whenever their next inputs are already available to the script.

## API highlights

```javascript
await page.getByRole('button', { name: /continue/i }).click()
await page.getByLabel('Search').fill('query')
await page.getByRole('heading').first().innerText()
await page.getByRole('option').nth(1).click()

const rows = page.locator('table tbody tr')
await rows.count()
await rows.allInnerTexts()
await rows.evaluateAll((nodes) => nodes.slice(0, 50).map((node) => node.innerText))
await rows.first().innerText()
await rows.nth(1).click()

await page.findText('Continue', { maxResults: 10 })
await page.clickText('Continue', { exact: true })
await page.observe({ maxChanges: 20 })
```

`taskSpaces` are compatibility labels only in ego-chrome. They do not isolate tabs or sessions. Do not add them to simple tasks.

## Attribution

Core execution guidance in this skill is adapted from CitroLabs `ego-lite` / `ego-browser` 1.2.6 under the MIT License. See the repository's `THIRD_PARTY_NOTICES.md`.
