# 如何在正式提交前进行技术验证与界面草图

**目标：** 在将某个阶段锁定到具体方案之前，通过聚焦的可行性实验（spike）和一次性 HTML 原型（sketch）来降低实现风险。

**前提条件：** 无。`/gsd-spike` 和 `/gsd-sketch` 会自行创建所需的存储目录，不要求已初始化 GSD 项目。

---

## 决策：spike、sketch，还是两者都用

| 你想回答的问题… | 使用 |
|---|---|
| "这个技术方案真的可行吗？" | `/gsd-spike` |
| "这个布局 / 交互 / 视觉处理感觉对吗？" | `/gsd-sketch` |
| "正确的技术方案是什么，它应该长什么样？" | 两者都用，顺序是：先 spike，再 sketch |

Spike 通过可执行代码和 VALIDATED / INVALIDATED / PARTIAL 结论来回答二元可行性问题。Sketch 通过 2–3 个可在浏览器中对比的 HTML 变体来回答视觉问题。两者互为补充——spike 证明方案可构建，sketch 证明设计值得构建。

---

## 运行 spike

### 交互式引导（默认）

```bash
/gsd-spike
```

GSD 会询问技术问题，将其分解为 2–5 个独立实验，以 **Given / When / Then** 假设形式呈现，并在开始构建前请求确认。

### 直接提供想法

```bash
/gsd-spike "can we stream LLM tokens through SSE"
```

### 跳过引导，直接运行

```bash
/gsd-spike --quick "websocket vs SSE latency"
```

`--quick` 跳过分解对话，直接将参数作为单个 spike 问题处理。当问题已经足够具体、无需进一步细化时使用此选项。

### 每个实验产出内容

`.planning/spikes/NNN-descriptive-name/` 中的每个 spike 包含：

- 可运行的代码（非伪代码）
- 在编写任何代码之前写好的 **Given / When / Then** 假设
- 记录边界情况、方向调整和意外发现的调查轨迹
- 附有证据的 **VALIDATED**、**INVALIDATED** 或 **PARTIAL** 结论
- 包含 frontmatter、运行说明和结果的 `README.md`

所有 spike 均在 `.planning/spikes/MANIFEST.md` 中建立索引。

### 打包调查结果

当你获得有效信号后，将调查结果封装成项目本地技能，以便后续会话自动加载：

```bash
/gsd-spike --wrap-up
```

此命令会写入 `.claude/skills/spike-findings-[project]/`。该技能会被自动发现，并在后续的 `/gsd-sketch`、`/gsd-ui-phase` 和 `/gsd-plan-phase` 运行时加载——无需显式引用。

---

## 运行 sketch

### 风格引导（默认）

```bash
/gsd-sketch
```

GSD 会开启一段简短对话，在编写任何代码之前探索感觉、视觉参考和核心用户操作。它每次只问一个问题，只有在你说"开始"后才动手构建。

### 直接提供设计方向

```bash
/gsd-sketch "dashboard layout"
```

### 跳过风格引导，直接运行

```bash
/gsd-sketch --quick "sidebar navigation"
```

`--quick` 完全跳过引导对话，直接使用参数作为设计方向。

### 非 Claude 运行时（Codex、Gemini CLI 等）

```bash
/gsd-sketch --text "onboarding flow"
```

`--text` 将交互式提示替换为纯文本编号列表。当你的运行时不支持 `AskUserQuestion` 时使用此选项。

### 每个草图产出内容

`.planning/sketches/NNN-descriptive-name/` 中的每个 sketch 包含：

- 带有 2–3 个变体、可通过选项卡导航访问的 `index.html`——直接在浏览器中打开，无需构建步骤
- 功能性交互元素（悬停、点击、过渡动画）
- 使用来自先前 spike 调查结果的字段名和数据结构的近似真实内容
- 来自 `.planning/sketches/themes/default.css` 的共享 CSS 变量
- 包含设计问题、变体说明和关注点的 `README.md`

所有 sketch 均在 `.planning/sketches/MANIFEST.md` 中建立索引。

### 打包获胜的设计决策

选定变体后，将视觉决策捕获到项目本地技能中：

```bash
/gsd-sketch --wrap-up
```

此命令会写入 `.claude/skills/sketch-findings-[project]/`。该技能由 `/gsd-ui-phase` 自动获取——经过预验证的决策（布局、色彩方案、排版、间距）被视为已锁定，不会再次询问。

---

## 组合流程：spike → sketch → phase

当你对技术可行性和视觉方向都不确定时，推荐使用以下顺序：

```bash
/gsd-spike "SSE vs WebSocket for real-time feed"
/gsd-spike --wrap-up

/gsd-sketch "real-time feed UI"
/gsd-sketch --wrap-up

/gsd-discuss-phase N
/gsd-plan-phase N
```

spike 调查结果会为 sketch 提供参考（真实数据结构、真实交互状态、实际约束）。两次 wrap-up 均会持久化决策，规划器和 UI 研究员会自动加载，因此在 `/gsd-discuss-phase` 或 `/gsd-ui-phase` 期间无需重新解释选择。

---

## spike 或 sketch 如何流入某个阶段

Spike 和 sketch 的产物不需要手动引用。GSD 会在以下两个时间点自动读取它们：

1. **`/gsd-sketch`** — 在构建原型前加载 `.claude/skills/spike-findings-*/`，使变体反映已验证的约束（流式状态、真实字段名等）
2. **`/gsd-ui-phase N`** — 在生成 UI 设计契约前加载 `.claude/skills/sketch-findings-*/`；经过预验证的设计决策被视为已锁定

当存在 `spike-findings-*` 技能时，规划器也会读取 spike 调查结果，从而使已验证的技术选择（采用哪个库、哪种协议、哪种数据格式）直接流入任务计划，无需反复解释。

---

## 相关文档

- [设计 UI 阶段](design-a-ui-phase.md)
- [规划阶段](plan-a-phase.md)
- [命令参考](../COMMANDS.md)
- [文档索引](../README.md)
