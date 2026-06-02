# 如何讨论一个阶段

**目标：** 在规划开始之前收集某个阶段所需的实施决策，以便研究员和规划员无需再次询问您。

**前提条件：** `.planning/ROADMAP.md` 文件已存在。如果没有，请先运行 `/gsd-new-project`。

---

## 选择讨论模式

GSD Core 提供两种模式。根据对代码库的熟悉程度进行选择。

**如果您想预先表达自己的实施偏好**（访谈模式，默认）：

```bash
/gsd-discuss-phase 2
```

Claude 会识别阶段范围中的模糊地带，让您选择要讨论的内容，然后针对每个领域处理大约四个问题。

**如果代码库已有明确的模式，且大多数问题对您来说显而易见**（假设模式）：

```bash
node gsd-tools.cjs config-set workflow.discuss_mode assumptions
/gsd-discuss-phase 2
```

Claude 通过子代理读取 5–15 个相关代码库文件，形成带有证据和置信度级别的假设，并呈现给您确认或纠正。通常只需 2–4 次交互，而非 15–20 次。

切换回原模式：

```bash
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

请参阅[讨论模式说明](../workflow-discuss-mode.md)以获取完整对比，包括各模式可能节省时间的场景。

---

## 不经选择步骤直接讨论所有模糊地带

默认情况下，Claude 会呈现模糊地带并询问您希望覆盖哪些内容。如果您想跳过该选择提示，直接处理所有内容：

```bash
/gsd-discuss-phase 2 --all
```

---

## 加快处理简单明了的阶段

**如果该阶段已充分理解，您希望 Claude 无需提示即可选择推荐的默认值：**

```bash
/gsd-discuss-phase 3 --auto
```

Claude 为每个问题选择推荐答案并记录选择。适用于决策风险较低或已在先前阶段中隐含的阶段。

**如果您有远程会话限制（无 TUI 菜单）：**

```bash
/gsd-discuss-phase 2 --text
```

所有提示将以纯文本编号列表的形式呈现，而不是交互式选择器。

---

## 分组处理问题

如果您希望一次回答多个问题，而不是逐一回答：

```bash
/gsd-discuss-phase 2 --batch
```

Claude 每轮分组 2–5 个问题。

---

## 为每个问题添加权衡分析

如果您希望在做出决定之前查看选项对比表：

```bash
/gsd-discuss-phase 2 --analyze
```

---

## 从准备好的文件中批量回答

如果您已有准备好的答案文件，并希望一次性提交所有决策：

```bash
/gsd-discuss-phase 1 --power
```

---

## 在讨论之前查看 Claude 的假设

**如果您希望在任何交互式会话之前了解 Claude 的假设和计划** — 适用于在投入讨论时间之前验证对齐情况：

```bash
/gsd-discuss-phase 3 --assumptions
```

Claude 输出其假设（附带代码库证据和置信度级别）后退出。不会写入 CONTEXT.md。查看输出后，如有需要纠正的内容，再运行正常的讨论或假设模式会话。

---

## CONTEXT.md 的内容

讨论模式和假设模式都会在阶段目录中生成相同的 `{phase}-CONTEXT.md`。下游代理（研究员、规划员、计划检查员）以相同方式读取该文件，无论由哪种模式生成。它包含六个部分：

| 部分 | 用途 |
|---|---|
| `<domain>` | 阶段边界 — 本阶段交付的内容 |
| `<decisions>` | 会话中锁定的实施决策 |
| `<canonical_refs>` | 下游代理必须阅读的规格说明、ADR 和文档 |
| `<code_context>` | 可复用资产、模式和集成点 |
| `<specifics>` | 用户参考资料和偏好 |
| `<deferred>` | 记录留待未来阶段处理的想法 |

`<canonical_refs>` 部分是必填项。如果您在讨论中引用了某个文档、规格说明或 ADR，Claude 会立即将其添加并读取，以便为后续问题提供参考。

请参阅 [CONTEXT.md 模式](../reference/context-md.md)以获取完整的字段参考。

---

## 决策如何影响规划

当您接下来运行 `/gsd-plan-phase` 时，规划员会读取 CONTEXT.md 以了解哪些决策已锁定。它不会重新询问此处已回答的问题。研究员会首先读取该文件以了解需要调查的内容。

**如果运行 `/gsd-plan-phase` 时 CONTEXT.md 缺失**，系统将提供两种选择：不使用上下文继续（计划仅使用研究和需求，不包含您的设计偏好），或先运行 `/gsd-discuss-phase`。

---

## 如果您已有 PRD 或验收标准文档

完全跳过 discuss-phase，直接进入规划：

```bash
/gsd-plan-phase 1 --prd path/to/prd.md
```

规划员会从 PRD 综合生成 CONTEXT.md，并将所有需求视为锁定决策。

---

## 相关内容

- [规划一个阶段](plan-a-phase.md)
- [讨论模式](../workflow-discuss-mode.md)
- [CONTEXT.md 模式](../reference/context-md.md)
- [文档索引](../README.md)
