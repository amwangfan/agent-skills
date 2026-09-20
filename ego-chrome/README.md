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
- Provides atomic navigation waiting in `page.goto()` and `browser.openTab()`.
- Safely auto-dismisses native JavaScript dialogs (`alert`, `confirm`, `prompt`) by default, with opt-in acceptance via `page.setNextDialogAction('accept')` and evidence inspection via `page.lastDialog()`.
- Produces compact semantic snapshots with temporary `@N` references.
- Clicks, fills, hovers, checks, unchecks, and selects form elements by snapshot ref or locator.
- Supports recursive element resolution inside open Shadow DOM roots for semantic locators and selectors (scoped within each open root; compound selectors crossing host boundaries are not supported).
- Supports local file uploads via `setInputFiles()`.
- Finds and clicks visible text in dynamic menus and custom elements with a real CDP mouse event.
- Supports trusted key presses, URL waits, page evaluation, targeted text extraction, selectors, and waits.
- Requires explicit tab selection before any page operation, preventing accidental takeover of an unrelated tab.
- Remembers the last automation tab for explicit continuation across CLI invocations while the bridge is running.
- Includes an installable Agent skill under `skills/ego-chrome`.
- Does not expose screenshot capture in its default API.

## Architecture

```text
Agent / AI Agent
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
- An AI Agent runtime with Agent Skills support (e.g. DeepSeek Harness, Claude Code, Codex).

## Install

### 1. Clone and install the CLI

```powershell
git clone https://github.com/amwangfan/agent-skills.git
cd agent-skills/ego-chrome
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

### 5. Install the Agent skill

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1
```

The script copies the skill to:

```text
~\.agents\skills\ego-chrome
```

Restart your agent or reload skills after installation. Rerun the script after updating the repository.

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

No image is sent to the model or agent.

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

## Navigation waits and dialogs

`page.goto()` and `browser.openTab(url, { wait: true })` wait atomically for document readiness.

For an action expected to navigate an already loaded page, start a URL or result-element wait before the action:

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

### Native dialogs

Native JavaScript dialogs (`window.alert`, `window.confirm`, `window.prompt`) are handled safely by default: the runtime automatically dismisses them so automation does not hang.

If an upcoming action requires accepting a confirmation or prompt, configure the expected action before triggering it:

```javascript
await page.setNextDialogAction('accept')
await page.locator('button#confirm-delete').click()

const dialog = await page.lastDialog()
console.log(dialog) // { type: 'confirm', message: 'Delete this item?', action: 'accept', ... }
```

## Form controls and hover

The runtime provides dedicated methods for form controls and mouse hovering:

### Checkbox and radio (`check`, `uncheck`, `isChecked`)

- `check()` and `uncheck()` are **idempotent**: calling `check()` on an already-checked element or `uncheck()` on an already-unchecked element does not toggle it again and is safely repeatable.
- Radio buttons (`input[type="radio"]`) can be checked with `check()`, but **cannot be unchecked** with `uncheck()` (reflecting standard HTML semantics where radio selections cannot be cleared by unchecking).
- `isChecked()` returns whether the checkbox or radio input is currently checked.

```javascript
// Idempotent checkbox interactions
const agree = page.locator('input#agree')
await agree.check()
await agree.uncheck()
const checked = await agree.isChecked()

// Radio buttons can be checked, but cannot be unchecked
await page.locator('input[type=radio]#option-a').check()
```

### Dropdown selection (`selectOption`)

`selectOption` selects `<option>` elements within a `<select>` dropdown. In alignment with Playwright conventions, a plain string matches the option's `value` attribute, while matching by visible text requires `{ label: ... }`:

```javascript
// By string (matches option value attribute; use { label: '...' } for visible text)
await page.selectOption('select#country', 'US')

// By explicit value attribute
await page.locator('select#country').selectOption({ value: 'US' })

// By visible label text (label must use an object descriptor)
await page.locator('select#country').selectOption({ label: 'United States' })

// By 0-based index
await page.locator('select#country').selectOption({ index: 2 })

// Multi-select with an array of values
await page.locator('select#skills').selectOption(['javascript', 'python'])
```

### Hover (`hover`)

`page.hover(selector)` and `locator.hover()` dispatch a CDP mouse move over the element. Use hover only when hovering is strictly required to reveal dynamic menus, dropdown triggers, or tooltips:

```javascript
await page.locator('.dropdown-trigger').hover()
await page.hover('button.menu-button')
```

## File uploads (`setInputFiles`)

`page.setInputFiles(selector, files)` and `locator.setInputFiles(files)` set files on `<input type="file">` elements using Chrome DevTools Protocol (`DOM.setFileInputFiles`):

```javascript
// Single file upload with an absolute local path
await page.setInputFiles('input[type=file]', 'C:\\path\\to\\document.pdf')

// Multiple file upload
await page.locator('input[type=file][multiple]').setInputFiles([
  'C:\\path\\to\\file1.png',
  'C:\\path\\to\\file2.png',
])

// Clear selected files
await page.locator('input[type=file]').setInputFiles([])
```

> **⚠️ File Upload Security & Scope:**
> `setInputFiles` only validates and resolves the local filesystem path(s) and sends them to Chrome via CDP (`DOM.setFileInputFiles`); the ego-chrome bridge itself does **not** read or transport file contents. However, when the form is submitted or processed by the page, Google Chrome and the target website will naturally read and upload the actual file content. The paths must be local absolute paths that the running Chrome process has direct permissions to access.

## Shadow DOM traversal

- **Open Shadow DOM**: The locator engine recursively traverses open shadow roots (`Element.shadowRoot`). Selectors and semantic matchers evaluate within each open root scope to locate elements residing inside open shadow roots. Note that selectors are evaluated within individual root boundaries; complex compound selectors that attempt to cross host boundaries in a single selector expression (e.g. `host > shadow-child`) are not supported.
- **Closed Shadow DOM**: Closed shadow roots (`mode: "closed"`) cannot be accessed via standard DOM APIs and are **not supported**. Closed shadow DOM boundaries represent an explicit capability limit.

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
await page.hover('button.menu-trigger')
await page.fill('@2', 'value')
await page.check('input#agree')
await page.uncheck('input#agree')
await page.isChecked('input#agree')
await page.selectOption('select#country', 'US')
await page.selectOption('select#country', { value: 'US' })
await page.selectOption('select#country', { label: 'United States' })
await page.selectOption('select#country', { index: 2 })
await page.setInputFiles('input[type=file]', 'C:\\path\\to\\file.pdf')
await page.setInputFiles('input[type=file]', ['C:\\path\\to\\file1.png', 'C:\\path\\to\\file2.png'])
await page.setInputFiles('input[type=file]', [])
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
await page.setNextDialogAction('accept')
await page.lastDialog()
```

CSS locator facade:

```javascript
const email = page.locator('input[name=email]')
await email.fill('me@example.com')
await email.press('Enter')
await page.locator('button[type=submit]').click()
await page.locator('button.menu-trigger').hover()
await page.locator('input#agree').check()
await page.locator('input#agree').uncheck()
const isChecked = await page.locator('input#agree').isChecked()
await page.locator('select#country').selectOption('US')
await page.locator('select#country').selectOption({ label: 'United States' })
await page.locator('select#country').selectOption({ index: 2 })
await page.locator('input[type=file]').setInputFiles('C:\\path\\to\\file.pdf')
await page.locator('input[type=file]').setInputFiles(['C:\\path\\to\\file1.png', 'C:\\path\\to\\file2.png'])
await page.locator('input[type=file]').setInputFiles([])
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

The project does not export cookies or credentials. Snapshot content and explicit page reads are returned to the local agent process because the agent needs that information to perform the requested task.

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

### Action succeeded but the agent ran extra commands

Verify the postcondition with `page.waitForURL()` or `page.waitForSelector()` in the same invocation. `page.waitForLoadState()` alone does not prove that an action-triggered navigation occurred.

### Port 32145 is already in use

Change `port` in `%LOCALAPPDATA%\ego-chrome\config.json`, then enter the same port in the extension options.

## Important limitations

- Opening DevTools or attaching another debugger to the same tab can disconnect automation.
- Deep cross-origin iframe snapshot merging is not implemented yet.
- Closed Shadow DOM trees cannot be traversed or inspected (open Shadow DOM is recursively supported within each root scope).
- Downloads and network idle/activity waits are not yet implemented.
- File uploads (`setInputFiles`) require Chrome to have direct filesystem access to local absolute paths; the ego-chrome bridge itself does not read file bytes, but Chrome and the target website will read and upload the file when the form is submitted.
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

After changing extension files, reload the unpacked extension. After changing the skill, rerun `scripts/install-skill.ps1` and restart your agent.

## Roadmap

1. Recursive cross-origin iframe attachment and snapshot merging.
2. Incremental snapshot diffs.
3. Tab-group-backed task spaces.
4. Downloads and network idle/activity waits.
5. Explicit visual fallback for exceptional pages, disabled by default.

## License

MIT
