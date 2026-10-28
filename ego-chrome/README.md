# ego-chrome

> **二次开发与致谢声明**  
> 本项目基于 [CitroLabs ego-lite / ego-browser](https://github.com/citrolabs/ego-lite) 的交互模型进行二次开发。核心执行准则改编自 ego-browser 1.2.6，采用 MIT License。详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

ego-chrome 是一套本地优先的 Chrome 扩展与 Agent Skill，主要目标是：复用用户当前 Chrome Profile 的登录态，并通过语义快照减少模型输入和 Token 消耗。

项目使用 Manifest V3 扩展连接本地 Node.js CLI 桥接服务，通过 Chrome DevTools Protocol（CDP）控制选定标签页，提供一组 Playwright 风格的 JavaScript API。

## 主要能力

- **复用现有登录态**：直接使用当前 Chrome Profile 的 Cookies、站点存储和登录会话。
- **低 Token 交互**：基于无障碍树和精简 DOM 回退生成语义快照，不需要把截图发送给模型。
- **后台打开标签页**：自动化任务默认在后台标签页运行。
- **语义定位器与 DOM 操作**：支持点击、填写、悬停、复选框、下拉选择、文本查找和结构化提取。
- **动态界面支持**：可处理常见菜单、弹层和自定义元素；支持开放的 Shadow DOM。
- **显式标签页选择**：每次调用必须明确选择标签页，避免误操作用户正在查看的标签页。
- **原生对话框处理**：默认安全关闭 JavaScript 对话框；需要时可显式接受并检查结果。
- **文件上传**：支持通过 CDP 设置本地文件输入框。
- **Agent Skill**：仓库内提供 `SKILL.md`，可供支持 Agent Skills 的智能体加载。

## 工作架构

```text
Agent / AI Agent
  │ JavaScript 管道输入
  ▼
本地 Node.js CLI ── HTTP RPC ── 本地桥接服务
                                      │
                                 Chrome 扩展
                                      │
                              chrome.debugger / CDP
                                      │
                              当前 Chrome Profile
```

桥接服务只绑定到 `127.0.0.1`，并要求随机生成的 256 位令牌。扩展通过本地连接与桥接服务通信。请将令牌视为敏感凭据，不要公开分享。

## 环境要求

- Windows 10 或 Windows 11
- Google Chrome 120 或更新版本
- Node.js 20 或更新版本
- 支持 Agent Skills 的 AI Agent 运行环境，例如 Claude Code、Codex 等

## 安装

### 1. 下载项目并安装 CLI

```powershell
git clone https://github.com/amwangfan/agent-skills.git
cd agent-skills/ego-chrome
npm install
npm link
```

`npm link` 会将 `ego-chrome` 命令链接到当前 Node.js 安装环境。

### 2. 创建本地桥接令牌

```powershell
ego-chrome init
```

配置文件默认位于：

```text
%LOCALAPPDATA%\ego-chrome\config.json
```

请复制命令输出的 64 位十六进制令牌。

### 3. 加载 Chrome 扩展

1. 在 Chrome 中打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本仓库中的 `extension/` 目录。
5. 打开扩展详情中的“扩展程序选项”，粘贴上一步生成的令牌并保存。

工具栏状态提示：

- `ON`：已连接本地桥接服务。
- `OFF`：桥接服务未运行、令牌缺失或连接失败。
- `…`：正在连接。

首次运行 CLI 时会自动启动本地桥接服务。点击扩展图标可请求重新连接。

### 4. 检查连接

```powershell
ego-chrome --doctor
```

正常情况下，输出会显示桥接服务和扩展的连接状态、标签页数量及端口。

### 5. 安装 Agent Skill

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-skill.ps1
```

默认安装到：

```text
~\.agents\skills\ego-chrome
```

安装后请重启 Agent 或重新加载技能。更新仓库后，再运行一次安装脚本即可同步 Skill。

## 快速开始

PowerShell：

```powershell
@'
await browser.openTab('https://example.com', { active: false, wait: true })
console.log(await page.snapshot({ maxChars: 2500 }))
'@ | ego-chrome nodejs
```

Bash：

```bash
ego-chrome nodejs <<'EOF'
await browser.openTab('https://example.com', { active: false, wait: true })
console.log(await page.snapshot({ maxChars: 2500 }))
EOF
```

所有可预期的观察、动作、等待、提取和验证都应尽量放在同一次调用中。不要仅为了查看中间输出而退出脚本；最终只输出完成任务所需的结果。

## 标签页安全规则

每次调用都必须先选择标签页，再使用 `page.*`：

```javascript
await browser.openTab(url, { active: false, wait: true })
await browser.openOrReuseTab(url, { active: false, match: 'exact', wait: true })
await browser.continueLastTab()
await browser.useActiveTab()
await browser.useTab(tabId)
```

- `openTab`：为新目标创建后台标签页。
- `openOrReuseTab`：按指定匹配方式复用标签页。
- `continueLastTab`：在后续 CLI 调用中继续上次的自动化标签页。
- `useActiveTab`：明确选择当前可见标签页。
- `useTab`：按已知 ID 选择标签页。
- `page.goto()`：只在本次调用中已选定的标签页内导航，不会自动选择标签页。

如果没有选择标签页，页面操作会报错 `No automation tab selected`。运行时不会静默接管用户当前标签页或自动使用上次记忆的标签页。

## 语义快照与定位器

快照通常会以文本形式描述页面结构、角色、可访问名称和状态，并给可交互元素分配临时引用（例如 `@1`、`@2`）。引用在生成新快照后可能失效；页面导航或 DOM 大幅变化后，应重新观察并使用新引用。

优先使用语义定位器：

```javascript
await page.getByRole('button', { name: /save/i }).click()
await page.getByLabel('Email').fill('me@example.com')
const headings = await page.getByRole('heading').allInnerTexts()
```

遇到动态菜单或自定义元素时，可使用 `findText()` 查找候选，并通过 `clickText()` 触发真实浏览器鼠标事件：

```javascript
const candidates = await page.findText('Settings', {
  exact: false,
  selector: '[role="menuitem"], [role="option"], button, a, li',
  maxResults: 20,
})
await page.clickText('Settings', {
  exact: true,
  selector: '[role="menuitem"], button, a, li',
  nth: 0,
})
```

## 常用 API

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

匹配模式包括 `exact`、`origin`、`origin+path` 和 `includes`。

### `page`

```javascript
await page.snapshot({ maxChars: 12000, includeText: true })
await page.click('@1')
await page.fill('@2', 'value')
await page.hover('button.menu-trigger')
await page.check('input#agree')
await page.uncheck('input#agree')
await page.isChecked('input#agree')
await page.selectOption('select#country', 'US')
await page.selectOption('select#country', { label: 'United States' })
await page.setInputFiles('input[type=file]', 'C:\\path\\to\\file.pdf')
await page.findText('Menu item', { exact: false })
await page.clickText('Menu item', { exact: true, nth: 0 })
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
await page.waitForLoadState({ timeout: 20000 })
await page.waitForTimeout(250)
await page.setNextDialogAction('accept')
await page.lastDialog()
```

以上为常用接口示例，具体可用方法以仓库中的运行时代码为准。

## 隐私与安全

扩展在当前 Chrome Profile 中操作标签页，因此网站会看到与普通浏览器标签页相同的登录 Cookies 和站点存储。项目不会主动导出 Cookies 或凭据；为完成用户请求而读取的快照内容和页面信息会返回给本地 Agent 进程。

Chrome 的 `debugger` 权限非常强，请只安装和使用自己信任的代码，并保护好桥接令牌。需要轮换令牌时执行：

```powershell
ego-chrome init --force
```

然后将新令牌同步更新到扩展设置页面。

文件上传只会由桥接服务通过 CDP 设置文件路径；桥接服务本身不读取或传输文件内容。但当页面提交或处理文件时，Chrome 和目标网站仍会读取并上传实际文件。只使用用户明确指定、且 Chrome 进程有权访问的本地绝对路径。

## 故障排查

### 扩展状态一直是 `OFF`

运行 `ego-chrome --doctor`，确认扩展设置中的令牌和端口与 `%LOCALAPPDATA%\ego-chrome\config.json` 一致，然后点击扩展图标重新连接。

### `Another debugger is already attached`

关闭该标签页的 DevTools，并暂时停用其他浏览器自动化扩展。

### `Unknown or stale ref`

页面在上次快照后发生了变化。重新生成一次快照，并使用新引用。

### `No automation tab selected`

显式选择浏览器标签页。新目标使用 `browser.openTab()`；后续调用使用 `browser.continueLastTab()`。

### 动作成功，但 Agent 又执行了多余命令

在同一次调用中通过 `page.waitForURL()` 或 `page.waitForSelector()` 验证后置条件。仅调用 `page.waitForLoadState()` 不能证明动作触发的导航已经发生。

### 端口 32145 已被占用

修改 `%LOCALAPPDATA%\ego-chrome\config.json` 中的 `port`，并在扩展设置中填入相同端口。

## 当前限制

- 在同一标签页打开 DevTools 或附加另一个 debugger，可能导致自动化断开。
- 尚未实现深层跨域 iframe 的快照合并。
- 不支持遍历或检查封闭 Shadow DOM；开放 Shadow DOM 在各自 root 范围内递归支持。
- 尚未实现下载控制及网络空闲/活动等待。
- 文件上传要求 Chrome 能直接访问给定的本地绝对路径。
- Canvas、WebGL、地图、远程桌面和纯视觉界面无法通过语义接口可靠观察。
- 无法控制 `chrome://settings` 等浏览器内部页面。
- 后台标签页共享 Cookies 和站点存储，这是复用登录态的设计，不构成安全隔离。
- 只有本地桥接进程仍在运行时，才能记住上次使用的标签页。
- 本项目面向个人使用，尚未经过正式安全审计。

## 开发

```powershell
npm install
npm run check
npm test
```

修改扩展文件后，请在 `chrome://extensions` 中重新加载已解压扩展。修改 Skill 后，请重新运行 `scripts/install-skill.ps1` 并重启 Agent。

## 后续规划

1. 递归附加跨域 iframe 并合并快照。
2. 增量快照差异。
3. 基于标签页组的任务空间。
4. 下载与网络空闲/活动等待。
5. 为特殊页面提供默认关闭的显式视觉回退。

## 许可

MIT
