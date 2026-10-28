---
name: ego-chrome
description: >-
  通过本地 ego-chrome 扩展和 CLI 操控用户当前正在使用的 Chrome 浏览器，复用现有登录态。适用于网页导航、表单操作、动态界面交互、数据提取和浏览器测试。尽量减少执行轮次与模型输入：把可预期的工作合并到一次调用，优先使用语义定位器和有界 DOM 读取，仅在状态确实未知时使用精简快照。
metadata:
  version: "0.4.1"
---

# ego-chrome

`ego-chrome` 通过 CLI 可调用的 Node.js 运行时暴露用户当前运行的 Chrome Profile。预载入的 `page`、`page.locator(...)` 和 `browser` 门面采用 Playwright 风格的命名，同时复用用户当前的登录态。

通过 PowerShell here-string 或 Bash heredoc 将浏览器任务管道传给 `ego-chrome nodejs`。JavaScript 直接写在 here-string / heredoc 中；不要创建临时脚本、不要导入 Playwright、不要另启浏览器，也不要臆造辅助函数名。

**here-string / heredoc 只是 JavaScript 的容器；shell 调用才是执行轮次。默认整个浏览器任务只使用一次 shell 调用。** 每个 `await` 都是脚本内部的操作，不是步骤边界。启动前，把所有可预期的观察、动作、等待、提取、验证和有界备选方案写进脚本。直接在 JavaScript 中使用浏览器返回的结果，并在同一进程内持续调整，直到任务完成。不要仅为查看中间输出或规划下一步而退出脚本。只有需要用户或外部介入，或发生脚本无法恢复的进程级故障时，才启动下一条命令。

**检查页面控件前，先选择对状态依赖最少的可靠路径。** 如果任务只规定结果或约束、没有要求特定交互，优先使用已经正确的状态，或能直接表达约束的已知稳定 URL / 站点路由；验证最终目标状态即可，不要通过 UI 重放等价的筛选、排序或导航。只有用户明确要求该交互、交互本身是测试对象，或不存在可靠的等价路径时，才操作页面控件。绝不要臆造脆弱的路由。

**已经满足的后置条件就视为完成。** 操作某个值可能已经正确的控件前，只读取判断当前状态所需的最少信息。如果已经符合要求，不要打开编辑器、重放交互或重复读取，直接处理剩余未满足的结果。除非用户明确要求“变更过程”或交互本身是测试对象，“设置”“选择”“确保”等词都指向所需的最终状态。

**冻结当前日期或相对日期任务的时间窗口。** 收集记录前，从用户/任务环境或明确验证过的当前页面状态中，一次性确定“今天/当前/最新”的时间锚点。将内容时间戳视为数据，而不是时钟。滚动、虚拟化、重载、缓存或结果批次变化后出现的较旧记录，不得替换这个时间锚点。

当用户明确要求使用 ego-chrome 时，默认 CLI 和运行时已经就绪。不要预先检查 Node 版本、包元数据、help 或 `--doctor`。只有第一条真实浏览器命令报告连接或安装错误后，才排查环境问题。

## 快速开始

```powershell
@'
await browser.openTab('https://example.com', { active: false, wait: true })
const heading = await page.getByRole('heading').first().innerText()
const info = await page.info()
if (!heading || !info.url) throw new Error('Page was not ready')
console.log(JSON.stringify({ heading, url: info.url }))
'@ | ego-chrome nodejs
```

所有可预期的工作都留在脚本内部。最终只输出一个简短 JSON 对象，包含用户所需的结果及足以证明任务完成的证据。不要输出中间快照、候选项列表或进度日志。

## 显式选择标签页

每次调用都必须先选择标签页，再使用 `page.*`：

```javascript
await browser.openTab(url, { active: false, wait: true })
await browser.openOrReuseTab(url, { active: false, match: 'exact', wait: true })
await browser.continueLastTab()
await browser.useActiveTab()
await browser.useTab(tabId)
```

- “打开”是指用 `browser.openTab()` 在新的后台标签页中打开。
- 只有用户要求复用，或确实需要避免重复打开时，才复用标签页。
- 只有确实需要后续调用接着处理时，才使用 `continueLastTab()`。
- 只有用户明确指向当前可见标签页时，才使用 `useActiveTab()`。
- `page.goto()` 只会在已选定的工作标签页中导航，不负责选择标签页。

## 最低 Token 观察阶梯

使用足以决定下一步动作的最低层级：

1. 已知 URL、语义定位器、选择器，或直接读取最终状态。
2. 有界集合读取：`count`、`allInnerTexts`、`evaluateAll`、`inputValue`、`getAttribute`。
3. 有界文本候选：`page.findText(...)`。
4. 增量变化：在基线快照或 observe 之后使用 `page.observe()`。
5. 仅在状态陌生时使用精简语义快照。
6. 精简快照不足以决策时，才使用普通快照。

绝不导出完整 HTML，也不要宽泛地执行 `querySelectorAll('*')`。集合读取只映射决策所需字段，并限制返回条数。

```javascript
await page.snapshot() // 精简快照，约 3500 字符
await page.snapshot({ mode: 'compact', maxChars: 2000 })
await page.snapshot({ mode: 'normal', maxChars: 12000 })
const change = await page.observe({ maxChanges: 12 })
```

不要每次动作后都重新生成快照。只有导航、大规模 DOM 替换、引用失效或状态确实未知时才重新快照。快照中的 `@N` 引用只对当前调用中最近一次快照有效。

## 优先使用语义定位器

优先选择稳定的语义定位器，而不是反复摸索选择器：

```javascript
await page.getByRole('button', { name: /save/i }).click()
await page.getByLabel('Email').fill('me@example.com')
const headings = await page.getByRole('heading').allInnerTexts()
```

对于页面特有的集合，应一次性提取结构化候选，在 JavaScript 中完成选择、操作和验证，不要退出当前调用：

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

## 动态界面

面对菜单、弹层、账号选择器、列表框、对话框和嵌套自定义元素时：

1. 先尝试 `getByRole` 或 `getByLabel`。
2. 可访问性语义较弱时，使用有界的 `findText()` 或 `clickText()`。
3. 只有新状态仍然未知时，才生成一次精简快照。

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

不要因为普通菜单、选择器、弹层或对话框出现就停止。继续完成正常选择流程。只有遇到密码、passkey、CAPTCHA、人身安全密钥、两步验证码、账户恢复确认、支付授权、破坏性操作确认或其他确实需要人工/涉密介入的检查点时，才询问用户。

## 执行规则

- `page.url()` 是异步方法，始终使用 `await page.url()`。`page.waitForURL(...)` 的谓词接收一个 URL 对象。
- `page.goto()` 和 `browser.openTab()` 已经原子化地等待文档就绪。
- 原生 JavaScript 对话框（`alert`、`confirm`、`prompt`）默认会被安全关闭。如确实需要接受，在触发动作前调用 `await page.setNextDialogAction('accept')`；必要时在动作后通过 `await page.lastDialog()` 验证。
- `page.waitForURL`、`page.waitForLoadState`、`page.waitForSelector` 和定位器的 `waitFor` 在超时时会返回假值。检查返回值，或立即验证目标状态。
- 在触发动作前注册导航或结果状态等待。优先使用基于状态的等待；`waitForTimeout` 只用于短暂等待页面稳定。
- 页面结构未知时，用 `evaluateAll`、`allInnerTexts`、`findText` 或一次精简快照收集相关控件/候选，再在 JavaScript 内推导后续动作，不要跨命令逐个尝试选择器。
- 成功动作应推动脚本继续执行。只在需要判断分支时读取状态，并在最后验证所需后置条件；不要每个动作后都读取。
- 失败时进行一次有针对性的观察，并实质性地调整策略。不要重复近乎相同的定位器、命令或快照。
- 如果点击可能导致当前标签页导航或打开新标签页，只点击一次，然后在同一脚本中结合 URL 与刷新后的 `browser.listTabs()` 判断结果。不要悄悄用直接导航替代用户要求的交互。
- 表单控件优先使用幂等的 `check()`、`uncheck()` 和 `selectOption()`，而不是通用点击。单选按钮不能取消选中。
- 只有必须悬停才能显示动态元素时，才使用 `hover()`。
- `setInputFiles()` 只能使用用户明确指定的本地路径；绝不要探索或探测文件系统来发现文件。桥接层通过 CDP 解析本地路径，不读取文件内容；但表单提交时，Chrome 和目标网站会读取并上传实际文件。
- 定位器会自动处理开放的 Shadow DOM，但仅在各自的 root 范围内工作；不支持跨 host 边界的复合 CSS 选择器。封闭的 Shadow DOM 无法访问，属于明确的能力边界。

## 交互路径

1. **语义路径：定位器与精简快照。** 用于常规 DOM 页面。
2. **直接 DOM：定位器集合与 `page.evaluate`。** 用于有界的结构化提取和整页状态读取。
3. **能力边界。** 没有独立视觉工具时，无法可靠理解 Canvas、WebGL、地图、远程桌面和纯视觉编辑器。不要猜测坐标。

只要下一步所需输入已经在当前脚本内可得，就应在同一次调用中组合使用上述路径。

## API 速览

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

await page.locator('input#agree').check()
await page.locator('input#agree').uncheck()
await page.locator('input#agree').isChecked()
await page.locator('select#country').selectOption('US')
await page.selectOption('select#country', { label: 'United States' })
await page.selectOption('select#country', { index: 1 })
await page.locator('.menu-trigger').hover()
await page.locator('input[type=file]').setInputFiles('C:\\path\\file.pdf')
await page.locator('input[type=file]').setInputFiles([])
await page.findText('Continue', { maxResults: 10 })
await page.clickText('Continue', { exact: true })
await page.observe({ maxChanges: 20 })
await page.setNextDialogAction('accept')
const dialog = await page.lastDialog()
```

`taskSpaces` 在 ego-chrome 中仅是兼容性标签，不会隔离标签页或会话。简单任务不要使用。

## 署名与许可

本技能的核心执行准则改编自 CitroLabs `ego-lite` / `ego-browser` 1.2.6，采用 MIT License。详见仓库中的 `THIRD_PARTY_NOTICES.md`。
