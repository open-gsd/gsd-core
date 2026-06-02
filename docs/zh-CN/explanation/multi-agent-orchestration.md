# GSD Core 中的多智能体编排

> **说明文档** — 本文档阐述 GSD Core *为何*围绕多智能体编排进行设计，以及*各组件如何协同工作*。这不是操作指南。有关配置，请参阅
> [配置模型配置文件](../how-to/configure-model-profiles.md) 和
> [配置参考](../CONFIGURATION.md)。有关完整的智能体清单，
> 请参阅 [清单](../INVENTORY.md)。

---

## 本设计解决的问题

AI 编程智能体会逐渐退化。这并非因为模型变差，而是因为
*上下文窗口被填满*。随着对话的增长，早期的决策和代码
会被中间步骤的噪音挤出或稀释。当智能体在复杂任务中写到第五个文件时，
它可能已经忘记了第一条消息中说明的约束条件。这种现象有时被称为*上下文腐化*。

GSD Core 的多智能体设计正是对这一问题的直接回应。与其让一个
长期运行的智能体承担整个会话，不如让一个轻量编排器派生出
短暂存在的专用智能体，每个智能体都拥有**全新的 200K token 上下文窗口**，
并且*只获取完成其特定工作所需的工件*。编排器自身从不承担繁重工作；
它加载上下文、派生合适的智能体、收集结果，并在 `.planning/` 中更新共享状态。

---

## 编排器 → 智能体模式

`get-shit-done/workflows/` 中的每个工作流都遵循相同的结构：

```text
Orchestrator (workflow .md file)
    │
    ├── Load context
    │   gsd-tools.cjs init <workflow> <phase>
    │   → JSON: project info, config, state, phase details
    │
    ├── Resolve model
    │   gsd-tools.cjs resolve-model <agent-name>
    │   → opus | sonnet | haiku | inherit
    │
    ├── Spawn specialised agent (Task/SubAgent call)
    │   ├── Agent definition (agents/*.md)
    │   ├── Context payload (init JSON)
    │   ├── Model assignment
    │   └── Tool permissions
    │
    ├── Collect result
    │
    └── Update state
        gsd-tools.cjs state update / state patch / state advance-plan
```

编排器被刻意设计为轻量级。它不对领域进行推理，
不编写代码，也不解读结果——仅将结果路由到下一个步骤。
这种边界使每一层的职责清晰，并防止编排器的上下文积累领域噪音。

### 智能体清单

GSD Core 的智能体按功能类别划分，对应
研究 → 规划 → 执行 → 验证的流水线：

| 类别 | 智能体 | 典型并行度 |
|---|---|---|
| 研究员 | `gsd-project-researcher`、`gsd-phase-researcher`、`gsd-ui-researcher`、`gsd-advisor-researcher` | 4 个并行（技术栈、功能、架构、潜在问题） |
| 综合员 | `gsd-research-synthesizer` | 顺序执行，在研究员完成后运行 |
| 规划员 | `gsd-planner`、`gsd-roadmapper` | 顺序执行 |
| 检查员 | `gsd-plan-checker`、`gsd-integration-checker`、`gsd-ui-checker`、`gsd-nyquist-auditor` | 顺序执行，最多 3 次修订迭代 |
| 执行员 | `gsd-executor` | 波次内并行，波次间顺序 |
| 验证员 | `gsd-verifier` | 顺序执行，在所有执行员完成后运行 |
| 映射员 | `gsd-codebase-mapper` | 4 个并行子探针 |
| 审计员 | `gsd-ui-auditor`、`gsd-security-auditor` | 顺序执行 |

每个智能体定义（位于 `agents/*.md`）声明了其允许的工具访问权限、
用途以及终端输出颜色。仅需读取文件并写入单个输出文档的智能体
只获得这些权限——无 Bash 执行权限，无法访问更广泛的状态。
该约束是刻意为之的：如果智能体行为异常，可将影响范围控制在最小。

有关完整的 31 个智能体清单，请参阅 [清单](../INVENTORY.md#agents-31-shipped)。

---

## 基于波次的并行执行

多智能体设计最直观的体现是 `/gsd-execute-phase`
如何处理一组可能相互依赖的计划。

在派生任何执行员之前，编排器会执行**波次分析**：
读取每个 `PLAN.md` 文件中的依赖声明，并将计划分组成波次。
没有声明依赖的计划构成第 1 波次并并行运行。
依赖第 1 波次的计划构成第 2 波次，以此类推。

```text
Plan 01 (no deps)        ─┐
Plan 02 (no deps)        ─┤─── Wave 1  (parallel)
Plan 03 (depends: 01)    ─┤─── Wave 2  (waits for Wave 1)
Plan 04 (depends: 02)    ─┘
Plan 05 (depends: 03, 04) ─── Wave 3  (waits for Wave 2)
```

波次内的每个执行员：

- 接收一个全新的上下文窗口（200K token，或在支持的模型上最高 1M）
- 接收其负责的特定 `PLAN.md`
- 接收项目上下文（`PROJECT.md`、`STATE.md`）
- 接收阶段上下文（`CONTEXT.md`、`RESEARCH.md`，如果可用）
- 完成时生成原子 git 提交
- 写入描述构建内容的 `SUMMARY.md`

当一个波次内的所有执行员完成后，编排器对整个波次运行一次
pre-commit 钩子。执行员使用 `--no-verify` 提交，以防止
多个智能体并行提交时发生构建锁定争用（例如 Rust 项目中的 Cargo 锁定冲突）。
因此，钩子每个波次运行一次，而非每次提交运行一次。

### 并行提交安全性

两种机制防止多个执行员同时运行时发生写入冲突：

1. **`STATE.md` 的原子锁** — 每次写入 `STATE.md` 都使用
   带有 `O_EXCL` 原子创建的锁文件（`STATE.md.lock`）。这防止了
   两个智能体各自读取文件、修改不同字段、后写入者覆盖先写入者
   更改的读-改-写竞态条件。过期锁（超过 10 秒）会被自动清除。

2. **每波次运行钩子** — 每个执行员独立运行 pre-commit 钩子
   （这可能在共享构建工件上引发文件级争用），编排器在
   每个波次完成后运行一次 `git hook run pre-commit`。

---

## 针对大窗口模型的自适应上下文丰富

标准的 200K 上下文窗口足以让执行员实现一个专注的计划。
当配置的 `context_window` 达到 500K token 或更大时
（例如在 1M 级模式下使用 Opus 4.6 或 Sonnet 4.6），
编排器会自动使用标准窗口无法容纳的额外上下文来丰富子智能体提示：

- **执行员智能体**接收前一波次的 `SUMMARY.md` 文件和阶段
  `CONTEXT.md`/`RESEARCH.md`，使其在阶段内具备跨计划感知能力
- **验证员智能体**接收所有 `PLAN.md`、`SUMMARY.md` 和 `CONTEXT.md`
  文件以及 `REQUIREMENTS.md`，实现具有历史感知能力的验证

此丰富功能以 `config.json` 中的 `context_window` 值为条件。
在标准窗口配置下，提示使用截断版本，并采用缓存友好的排序
以最大化 token 效率。

---

## 为何采用此设计——与上下文工程的关联

只有作为更广泛的*上下文工程*方法的一部分，
编排器 → 智能体模式才有意义：这一理念认为，
AI 智能体上下文窗口中包含的内容与模型层级或提示质量同样重要。
完整论述请参阅[上下文工程](context-engineering.md)。

多智能体编排以两种方式将上下文工程付诸实践：

**上下文隔离。** 每个智能体只接收它所需要的内容。研究员
获取项目描述和领域问题；它不会获取完整的规划历史。
验证员获取每个计划和摘要；它不会获取原始研究资料。
隔离使每个智能体的上下文充满信号，而非被其他流水线阶段的噪音稀释。

**跨会话的上下文卫生。** 由于所有状态都以人类可读的 Markdown 和 JSON
存储在 `.planning/` 中（而非任何智能体的上下文窗口中），
GSD 工作流能够在上下文重置（`/clear`）、标签页切换和
多日中断后继续运行。下一个智能体始终从持久化的、经过验证的
工件启动，而非从漫长对话的重建记忆中启动。

---

## 权衡

多智能体编排并非没有代价。

**协调开销。** 每次智能体派生都是一次往返：编排器
必须格式化提示、移交上下文、等待子智能体完成
（通常需 1–5 分钟），然后解析结果。对于简单任务，
单个能力强大的智能体在一个上下文中工作会更快完成。GSD 通过
将并行化作为默认方式来缓解这一问题（在依赖关系允许的情况下）——
`plan-phase` 中的四个研究员同时运行，而非顺序运行。

**执行期间的不透明性。** 当子智能体运行时，其工作对父会话不可见。
没有实时进度流。这是全新上下文设计的刻意结果：
子智能体在其自己的上下文窗口中运行。编排器在
派生行显示活跃性提示（"runs in a subagent — no output until it returns"）
以设定预期。

**上下文拼接成本。** 为每个智能体打包正确的工件
需要编排器花费 token 来组装和传输上下文负载。
这是隔离的代价。`gsd-tools.cjs init` 处理器
生成一个在完整性与 token 预算之间取得平衡的 JSON 负载，
采用缓存友好的排序，使负载中稳定的部分（项目定义、配置）
在重复调用时命中缓存。

**模型成本放大。** 在 Opus 层级并行运行五个智能体
比运行一个成本更高。模型配置文件系统（`model_profiles.md`，
由 `model-profiles.cjs` 按智能体解析）让您可以为
不那么关键的智能体分配更低成本的层级。`dynamic_routing` 功能
通过以更低层级启动每个智能体并仅在软失败时升级来进一步降低成本。
完整选项请参阅[配置](../CONFIGURATION.md)。

为换取这些代价，该设计实现了*大型阶段的一致质量*。
在 400 行计划中编写第十个文件的执行员不会退化，
因为其上下文是全新的。检查二十个需求的验证员不会忘记前十个，
因为它以结构化输入而非对话历史的形式接收了所有需求。

---

## 相关资源

- [上下文工程](context-engineering.md) — 驱动本设计的上游原则
- [配置模型配置文件](../how-to/configure-model-profiles.md) — 如何按智能体分配模型层级
- [配置参考](../CONFIGURATION.md) — 完整的 `config.json` 架构，
  包括 `models`、`model_overrides`、`dynamic_routing` 和
  `context_window`
- [清单](../INVENTORY.md) — 权威的智能体清单和工作流列表
- [架构](../ARCHITECTURE.md#agent-model) — 编排器 → 智能体模式和
  波次执行模型的实现层面细节
- [文档索引](../README.md)
