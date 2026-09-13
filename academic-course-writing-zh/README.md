# academic-course-writing-zh

一个面向中文高专业度课程论文的可移植 Agent Skill。

重点适合：
- 电子信息；
- 微电子；
- 集成电路；
- 先进封装；
- 计算机/算法；
- 自动化；
- 其他工科课程论文。

它与普通 “humanizer” 的区别：

1. 不以骗过 AI 检测器为目标；
2. 优先保护技术事实和证据边界；
3. 不通过随机换词制造“人味”；
4. 可以读取作者本人旧作，提取抽象 Style Profile；
5. 明确区分课程论文与真正科研论文，避免虚构创新、实验和结果；
6. 重点消除“空泛背景 + 均匀段落 + 强行三点 + 自动升华”等模板感。

## 文件结构

academic-course-writing-zh/
├── SKILL.md
├── README.md
├── human-samples/
│   └── README.md
├── references/
│   ├── human-native-style.md
│   ├── technical-fidelity.md
│   ├── course-paper-genres.md
│   ├── anti-ai-patterns.md
│   ├── revision-checklist.md
│   └── source-notes.md
└── examples/
    └── before-after.md

## 使用

支持标准 Markdown Skill 的 harness，可直接把整个目录放进对应 skills 目录。

示例：

- 使用 `$academic-course-writing-zh` 帮我写这篇微电子课程论文的提纲，先建立每节的技术问题和证据链。
- 使用 `$academic-course-writing-zh` 润色这一节，保留所有术语、公式、引用和结论强度，重点降低模板化 AI 文风。
- 先读取 `human-samples/` 中我自己以前写的文章，建立 Style Profile，再按我的风格改写本章。
- 检查全文哪些地方像“AI 式学术写作”，不要为了去 AI 而乱换专业术语。

## 推荐用法

效果最好的是把你本人完全独立写过的 2–5 段专业文字放进 `human-samples/`。

这些样本不需要特别“漂亮”，真实即可。Skill 会优先学习：
- 句法；
- 节奏；
- 连接方式；
- 判断语气；
- 段落展开习惯；

而不是复制具体措辞。

## 版本

v0.1.0 — 初始整合版
