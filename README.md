# Agent Skills

精选与实用的可移植 AI Agent 技能库（Agent Skills Collection），支持各大支持通用 Skill / Prompt 插件规范的 Agent 平台（如 DeepSeek Harness、Claude Code、Cursor 等）。

---

## 📦 已收录技能目录

| 技能名称 | 说明 | 适用场景 | 快速入口 |
| :--- | :--- | :--- | :--- |
| **`academic-course-writing-zh`** | 面向中文工科、电子信息及其他高专业度课程论文的写作、润色与“去 AI 模板化”校准 Skill。 | 论文起草、逻辑梳理、文风校准、降低 AI 味、保护证据与术语保真 | [查看详情](./academic-course-writing-zh/README.md) |

---

## 🚀 技能使用说明

### 1. academic-course-writing-zh (中文专业课程论文与文风校准)
- **核心定位**：不靠堆砌错字和口语等伪自然手段，而是从论证逻辑、信息密度、学术语气和证据边界出发，让论文具备真实人类专业作者的思考与表达感。
- **主要特性**：
  - **证据保真**：严格禁止虚构文献、DOI、数据与公式；
  - **身份定位**：严格区分课程综述/实验报告与原创科研，杜绝“本文首次提出/填补空白”等虚假声称；
  - **去模板化**：排查空泛宏大背景（“随着……的不断发展”）、机械三段论、无来源权威口吻等典型 AI 特征；
  - **样本校准**：支持放入 2–5 段作者本人历史写作样本（放入 `human-samples/`），提取并校准专属 Style Profile；
  - **多工作模式**：支持 `PLAN`（提纲梳理）、`DRAFT`（段落起草）、`REWRITE/POLISH`（润色与微调）、`REVIEW`（风险评审）、`STYLE-CALIBRATE`（文风画像）。

---

## 🛠️ 安装与集成方法

每个技能均为独立的自包含目录，包含完整的 `SKILL.md`、参考规范（`references/`）和样例（`examples/`）。

可以直接将对应的技能目录复制到你的 Agent 系统的 skills 存放路径下即可使用。例如在 DeepSeek Harness 中，放置到对应 preset 或 global 的 skills 目录：

```bash
# 复制特定技能到你的环境
cp -r academic-course-writing-zh <path-to-your-agent-skills>/
```

---

## 📄 开源许可

本项目遵循 [MIT 许可证](LICENSE)。
