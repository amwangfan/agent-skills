# ego-chrome

> **📌 二次开发与致谢声明 (Attribution & Fork Notes)**  
> 本项目是基于 [CitroLabs ego-lite / ego-browser](https://github.com/citrolabs/ego-lite) 进行的**二次开发 (Second Development / Derivative Work)**。  
> 
> **与原版的主要差异与二开特性：**
> 1. **无需定制/重编译 Chromium**：原版 ego 依赖定制化浏览器环境；本项目重构为轻量级 **Chrome MV3 扩展 (Manifest V3 Extension) + 本地 Node.js CLI 桥接**，直接附加至用户正在运行的普通 Google Chrome，零侵入性。
> 2. **直接复用当前 Chrome 个人 Profile**：完美继承当前浏览器的所有登录态、Cookies、密码、已安装插件以及本地存储，无需反复处理登录验证码。
> 3. **极低 Token 消耗的语义快照**：采用 Accessibility Tree（无障碍树）与紧凑 DOM 回退生成语义文本快照，避免截图输入对大模型带来海量上下文/Token 开销。
> 4. **内置 Chrome 插件本体**：本项目仓库内置了完整的 Chrome 插件本体源码（位于 `extension/` 目录），可在 Chrome 中直接开启“开发者模式”并“加载已解压的扩展程序”即可使用。
> 5. **Agent Skill 开箱即用**：项目根目录提供 `SKILL.md`，可作为标准 Agent Skill 被 DeepSeek Harness、Claude Code、Codex 等各大 AI Agent 直接载入。

---

A personal, local-first Chrome extension and Agent skill for browser automation with two priorities:

1. reuse the login state in your current Chrome profile;
2. keep model input small with semantic text snapshots instead of screenshots.

The project is adapted and redesigned from CitroLabs ego-lite's interaction model. A Manifest V3 extension attaches to selected tabs through `chrome.debugger`, reads the accessibility tree plus a compact DOM fallback, and exposes a small Playwright-like JavaScript API through the `ego-chrome` CLI.

## Current capabilities

- Reuses current Chrome cookies, site storage, extensions, and logged-in sessions.
- Opens automation tabs in the background by default.
- Produces compact semantic snapshots with temporary `@N` references.
- Clicks and fills elements by snapshot ref or CSS selector.
- Finds and clicks visible text in dynamic menus and custom elements with a real CDP mouse event.
- Supports trusted key presses, URL waits, page evaluation, targeted text extraction, selectors, and waits.
- Requires explicit tab selection before any page operation, preventing accidental takeover of an unrelated tab.
- Remembers the last automation tab for explicit continuation across CLI invocations while the bridge is running.
- Includes an installable Codex skill under `skills/ego-chrome`.
- Does not expose screenshot capture in its default API.

## Architecture

```text
Codex
  │
  │ JavaScript piped to ego-chrome
  ▼
Local Node CLI ── HTTP RPC ── Local bridge ── long poll ── Chrome MV3 extension
                                                             │
                                                             ▼
                                                   chrome.debugger / CDP
                                                             │
                                                             ▼
                                                   current Chrome profile
```

The bridge binds only to `127.0.0.1` and requires a random 256-bit token. The extension stores the token in `chrome.storage.local` and maintains a localhost long-poll connection to the bridge. This avoids Windows Native Messaging registration and is intended for personal use on one machine.

## Requirements

- Windows 10 or 11.
- Google Chrome 120 or newer.
- Node.js 20 or newer.
- Codex with Agent Skills support.

## Install

### 1. Clone and install the CLI

```powershell
git clone https://github.com/amwangfan/ego-chrome-extension.git
cd ego-chrome-extension
npm install
npm link
```

`npm link` makes `ego-chrome` available globally for the current Node installation.

### 2. Create the bridge token

```powershell
ego-chrome init
```

The configuration is stored at:

```text
%LOCALAPPDATA%\ego-chrome\config.json
```

Copy the 64-character token printed by the command.

### 3. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `extension` directory.
5. Open the extension's **Details**, then **Extension options**.
6. Paste the token from `ego-chrome init` and save.

The toolbar badge shows:

- `ON`: connected to the local bridge;
- `OFF`: the bridge is not running, the token is missing, or the connection failed;
- `…`: connecting.

The CLI starts the local bridge automatically on first use. Clicking the extension icon requests a reconnect.

### 4. Check the connection

```powershell
ego-chrome --doctor
```

A healthy result resembles:

```json
{
  "bridge": "connected",
  "extension": "connected",
  "tabs": 8,
  "port": 32145
}
```

### 5. Install the Codex skill

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1
```

The script copies the skill to:

```text
~\.agents\skills\ego-chrome
```

Restart Codex after installation. Rerun the script after updating the repository.

## Upgrade

```powershell
git pull
npm install
npm link
powershell -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1
```

Runtime-only updates do not require reloading the Chrome extension. If files under `extension/` changed, reload the unpacked extension from `chrome://extensions`.

The bridge is a detached Node process. After runtime or bridge changes, stop the old process once so the next CLI invocation starts the new code:

```powershell
$bridgePid = (
  Get-NetTCPConnection -LocalPort 32145 -State Listen -ErrorAction SilentlyContinue
).OwningProcess

if ($bridgePid) {
  Stop-Process -Id $bridgePid -Force
}
```

## Quick start

PowerShell uses a here-string piped to the CLI:

```powershell
@'
await browser.openTab('https://example.com', {
  active: false,
  wait: true,
})
console.log(await page.snapshot({ maxChars: 2500 }))
'@ | ego-chrome nodejs
```

Bash-compatible shells can use a heredoc:

```bash
ego-chrome nodejs <<'EOF'
await browser.openTab('https://example.com', { active: false, wait: true })
console.log(await page.snapshot({ maxChars: 2500 }))
EOF
```

## Explicit tab safety

Every CLI invocation must select an automation tab before using `page.*`.

```javascript
await browser.openTab(url, { active: false, wait: true })
await browser.openOrReuseTab(url, { active: false, match: 'exact', wait: true })
await browser.continueLastTab()
await browser.useActiveTab()
await browser.useTab(tabId)
```

The intended meanings are:

- `openTab`: create a new background tab for a new destination;
- `openOrReuseTab`: explicitly reuse a matching tab when desired;
- `continueLastTab`: continue the previous automation tab in a follow-up CLI invocation;
- `useActiveTab`: explicitly opt into controlling the currently visible user tab;
- `useTab`: select a known tab ID.

`page.goto()` only navigates inside a tab that was explicitly selected in the current invocation.

If no tab is selected, page operations fail with:

```text
No automation tab selected
```

This is deliberate. The runtime never silently falls back to the active user tab or the previously remembered tab.

## Semantic snapshots

A typical result looks like:

```text
page "Account settings" url="https://example.com/account"
main
  heading "Profile" [level=1]
  @1 textbox "Display name" [value="Example User"]
  @2 button "Save"
```

Refs are temporary. A new snapshot rebuilds them, and navigation may make older refs stale.

The snapshot engine uses:

1. `Accessibility.getFullAXTree` for roles, accessible names, values, and states;
2. `DOMSnapshot.captureSnapshot` to recover meaningful clickable elements omitted by the accessibility tree;
3. `backendDOMNodeId` references for actions.

No image is sent to Codex.

## Dynamic menus and text locators

Modern sites often render menus with nested custom elements. A CSS selector may find a text child rather than the element that owns the click handler.

Use the generic text APIs:

```javascript
const candidates = await page.findText('Settings', {
  exact: false,
  selector: '[role="menuitem"], [role="option"], button, a, li',
  maxResults: 20,
})

console.log(candidates)

await page.clickText('Settings', {
  exact: true,
  selector: '[role="menuitem"], button, a, li',
  nth: 0,
})

await page.getByText('Continue', { exact: true }).click()
```

`findText()` returns compact candidate summaries. `clickText()` temporarily marks the chosen visible element and then calls the normal CDP-backed click path. The final interaction is a real browser mouse event, not a synthetic JavaScript `.click()`.

Options:

- `exact`: require normalized full-text equality;
- `caseSensitive`: preserve case during matching;
- `nth`: choose one match by DOM order;
- `selector`: restrict candidates to matching ancestors;
- `maxResults`: cap returned candidate summaries.

## Navigation waits

`page.waitForLoadState()` checks the readiness of the current document. It does not prove that a newly triggered navigation has started.

For an action expected to navigate, start a URL or result-element wait before the action:

```javascript
const navigated = page.waitForURL(
  (url) => url.pathname === '/complete',
  { timeout: 15000 },
)

await page.locator('button[type=submit]').click()

if (!(await navigated)) {
  throw new Error('Expected navigation did not occur')
}
```

Locator `press()` focuses the element and sends a trusted CDP key event:

```javascript
const search = page.locator('textarea[name=q], input[name=q]')
await search.fill('example')
await search.press('Enter')
```

## API

### `browser`

```javascript
await browser.listTabs()
await browser.currentTab()
await browser.openTab(url, { active: false, wait: true })
await browser.openOrReuseTab(url, { active: false, match: 'exact', wait: true })
await browser.continueLastTab()
await browser.useActiveTab()
await browser.useTab(tabId)
await browser.closeTab(tabId)
await browser.activateTab(tabId)
```

Matching modes are `exact`, `origin`, `origin+path`, and `includes`.

### `page`

```javascript
await page.snapshot({ maxChars: 12000, includeText: true })
await page.click('@1')
await page.click('button[type=submit]')
await page.fill('@2', 'value')
await page.findText('Menu item', { exact: false })
await page.clickText('Menu item', { exact: true, nth: 0 })
await page.getByText('Continue', { exact: true }).click()
await page.press('Enter')
await page.goto('https://example.com')
await page.info()
await page.url()
await page.title()
await page.evaluate(() => document.title)
await page.textContent('.message')
await page.count('table tbody tr')
await page.waitForSelector('.ready', { state: 'visible', timeout: 10000 })
await page.waitForURL('/complete', { timeout: 10000 })
await page.waitForURL(/\/orders\/\d+$/, { timeout: 10000 })
await page.waitForURL((url) => url.searchParams.get('saved') === '1')
await page.waitForLoadState({ timeout: 20000 })
await page.waitForTimeout(250)
```

CSS locator facade:

```javascript
const email = page.locator('input[name=email]')
await email.fill('me@example.com')
await email.press('Enter')
await page.locator('button[type=submit]').click()
const status = await page.locator('.status').textContent()
```

### `taskSpaces`

```javascript
const task = await taskSpaces.useOrCreate('short goal name')
await taskSpaces.complete(task.name, { keep: true })
```

Task spaces are optional compatibility labels inside one CLI invocation. They do not isolate cookies, local storage, tabs, or site sessions.

## Login state and privacy

The extension controls tabs inside your current Chrome profile, so sites see the same login cookies and storage as your normal tabs.

The project does not export cookies or credentials. Snapshot content and explicit page reads are returned to the local Codex process because Codex needs that information to perform the requested task.

Treat the extension's `debugger` permission as sensitive. Rotate the bridge token with:

```powershell
ego-chrome init --force
```

Then update the token in the extension options.

## Troubleshooting

### Badge stays `OFF`

Run:

```powershell
ego-chrome --doctor
```

Verify that the extension options contain the same token and port as `%LOCALAPPDATA%\ego-chrome\config.json`, then click the extension icon.

### `Another debugger is already attached`

Close DevTools for that tab and temporarily disable other browser automation extensions.

### `Unknown or stale ref`

The page changed after the last snapshot. Take one new snapshot and use the new ref.

### `No automation tab selected`

Choose the appropriate explicit browser method. For a new destination, use `browser.openTab()`. For a follow-up command, use `browser.continueLastTab()`.

### Action succeeded but Codex ran extra commands

Verify the postcondition with `page.waitForURL()` or `page.waitForSelector()` in the same invocation. `page.waitForLoadState()` alone does not prove that an action-triggered navigation occurred.

### Port 32145 is already in use

Change `port` in `%LOCALAPPDATA%\ego-chrome\config.json`, then enter the same port in the extension options.

## Important limitations

- Opening DevTools or attaching another debugger to the same tab can disconnect automation.
- Deep cross-origin iframe snapshot merging is not implemented yet.
- Canvas, WebGL, maps, remote desktops, and visual-only surfaces are not semantically observable.
- Browser-internal pages such as `chrome://settings` cannot be controlled.
- Background tabs share the same cookie and storage state. This is intentional for login reuse, not security isolation.
- The remembered tab survives only while the local bridge process remains running.
- The bridge is personal-use software and has not received a security audit.

## Development

```powershell
npm install
npm run check
npm test
```

After changing extension files, reload the unpacked extension. After changing the skill, rerun `scripts/install-skill.ps1` and restart Codex.

## Roadmap

1. Recursive cross-origin iframe attachment and snapshot merging.
2. Incremental snapshot diffs.
3. Tab-group-backed task spaces.
4. Semantic role and label locators.
5. Downloads, uploads, dialogs, and network waits.
6. Explicit visual fallback for exceptional pages, disabled by default.

## License

MIT
