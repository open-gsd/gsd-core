# 使用 GSD 进行议题驱动的编排

**状态：** 稳定工作流指南
**受众：** 在 GitHub Issues、Linear、Jira 或类似议题跟踪系统中管理工作的开发者，希望通过 GSD 现有原语驱动 AI 辅助实现。

## 本指南的内容

本指南提供一套方案，将 GSD 已有的命令组合成一个"议题跟踪 → 工作区 → 计划/执行 → 验证/审核 → PR"的循环。这仅是文档说明。无新命令、无守护进程、无跟踪系统集成 —— 下文引用的每一条命令在 GSD 中均已存在。

本方案的结构受到 OpenAI 开源 [Symphony 编排参考](https://openai.com/index/open-source-codex-orchestration-symphony/)（[代码库](https://github.com/openai/symphony)）的启发。GSD 不内嵌或封装 Symphony。Symphony 中的编排*概念*可以清晰地映射到 GSD 已有的原语上；本指南只是将这种映射明确阐述出来，让你无需编写粘合代码或绕过 GSD 的安全门控即可采用该模式。

## 为何存在本指南

GSD 具备议题驱动 AI 开发的基础构建块 ——
`/gsd-workspace --new`、`/gsd-manager`、`/gsd-autonomous`、`/gsd-verify-work`、
`/gsd-review`、`/gsd-ship`，以及 `STATE.md` 和阶段产物套件
—— 但缺少一份说明如何从单个跟踪议题驱动它们、无需编写自定义编排脚本的指南。没有这份指南，常见的失效模式是：

- 使用不足：开发者手动运行 discuss/plan/execute，即使工作模式完全适合，也从未使用
  `/gsd-manager` 或 `/gsd-autonomous`。
- 绕过脚本：开发者在跟踪系统与 `claude` 调用之间编写临时 shell 循环，绕过 `STATE.md`、阶段清单和验证门控。

本指南使规范循环变得易于发现。

## 概念映射

每行将 Symphony 风格的编排概念映射到 GSD 中对应的原语。在阅读 Symphony 文档、博客文章或第三方编排资料时，可将此表用作转换参考。

| Symphony 概念 | GSD 原语 |
|---|---|
| `WORKFLOW.md`（顶层意图） | `ROADMAP.md`（项目意图）、`STATE.md`（实时状态）、阶段 `CONTEXT.md`（每阶段范围）、阶段 `PLAN.md`（可执行步骤） |
| 每个任务一个独立的代理工作区 | `/gsd-workspace --new --strategy worktree` |
| 代理调度与并发 | `/gsd-manager`（交互式仪表板）、`/gsd-autonomous`（无人值守） |
| 每阶段的计划与讨论步骤 | `/gsd-discuss-phase` → `/gsd-plan-phase` → `/gsd-execute-phase` |
| 工作证明 / 测试证据 | `/gsd-verify-work`（UAT.md 在 `/clear` 后持久保存） |
| 对抗性审核 | `/gsd-review`（由独立 AI CLI 对计划进行交叉对等审核） |
| 人工合并门控 | `/gsd-ship`（创建 PR，可选代码审查，准备合并） |
| 后续工作捕获 | `/gsd-capture`、`/gsd-capture --seed`、`/gsd-new-milestone`，或手动打开的跟踪议题 |
| 并发控制 | Manager / 后台代理语义（无持续轮询器） |

映射是单向的：GSD 持有安全门控（验证、人工审核、后续工作创建的明确确认）。Symphony 的"持续编排"框架被有意地未采用 —— 参见[非目标](#非目标)。

## 端到端流程

规范的"议题 → PR"循环，设计为可从单个跟踪议题端到端运行。运行前请替换括号中的占位符。

1. **选择跟踪议题。** 从你的跟踪系统（GitHub、Linear 等）中选择一个范围足够明确可供自主实现的议题 —— 边界清晰、验收标准可观察、没有阻碍执行的上游依赖。
2. **映射到 GSD 阶段。** 如果该议题对应 `ROADMAP.md` 中已有的阶段，选择它。若无，运行 `/gsd-new-milestone`（用于一批相关议题的新里程碑），或通过 `/gsd-phase` / `/gsd-phase --insert` 打开一个阶段。将跟踪议题 URL 写入该阶段的 `CONTEXT.md`，确保可追溯性在压缩后依然保留。
3. **创建独立工作区。** 运行 `/gsd-workspace --new --strategy worktree <slug>`，以创建一个带有独立 `.planning/` 目录的 git 工作树。工作树是安全边界：任何探索、部分提交或中止的计划都保留在 `main` 之外。
4. **通过 GSD 运行 discuss → plan → execute。** 在工作区内部运行 `/gsd-discuss-phase` 澄清歧义，运行 `/gsd-plan-phase` 生成 `PLAN.md`，再通过 `/gsd-manager`（交互式仪表板）或 `/gsd-execute-phase` / `/gsd-autonomous`（无人值守）来实现。避免从 GSD 外部直接驱动原始 `claude` 调用 —— 这会绕过 `STATE.md` 更新和阶段清单。
5. **要求工作证明。** 运行 `/gsd-verify-work`，引导用户根据阶段的验收标准进行 UAT。测试、截图、日志捕获和配置差异均记录在 `UAT.md` 中，该文件在 `/clear` 后持久保存，并在验证发现遗漏范围时通过 `/gsd-plan-phase --gaps` 补充缺口。
6. **通过审核和发布门控。** 运行 `/gsd-review`，从独立 AI CLI 获取对计划的对抗性对等审核（逐模型发现盲点），然后运行 `/gsd-ship`，从规划产物中组装丰富的 PR 正文并打开 PR。两个门控都需要人工决策，之后才能推送到远端。
7. **明确捕获后续工作。** 使用 `/gsd-capture` 记录内联备注，使用 `/gsd-capture --seed` 记录值得未来阶段处理的想法，或使用 `/gsd-new-milestone` 记录一组有关联的后续工作。从发现的后续工作创建跟踪议题需要明确的用户确认 —— GSD 不会自动向远程跟踪系统发布内容。

PR 合并后，循环关闭。PR 正文中的自动关闭关键词（`Closes #NNN` / `Fixes #NNN`）会在合并时关闭跟踪议题。

## 安全边界

该循环之所以安全，是因为四项不变量在构建上得到保证：

- **独立工作树。** 每个议题在 `/gsd-workspace --new` 工作树中运行，因此部分工作、中止的计划和探索性提交永远不会触及 `main`。`gsd-local-patches/` 是恢复入口，当工作树的手动编辑需要跨更新带回时可使用。
- **明确的人工审核。** `/gsd-review` 和 `/gsd-ship` 均会停下来等待人工批准。没有自动合并，也没有从执行路径自动创建 PR 的路径。如果你想为特定代码库移除人工门控，那是你的分支保护 / 合并队列策略决定，而非 GSD 代为选择的。
- **不自动公开发布。** GSD 从不在没有明确用户发起命令的情况下打开、评论或关闭跟踪议题。后续工作捕获默认写入本地产物（备注、种子、里程碑）；推回跟踪系统是单独的手动步骤。
- **发布前先验证。** `/gsd-verify-work` 的 UAT.md 必须记录证据，才能运行 `/gsd-ship`。推荐的规范是将 `verification_failed` 视为阻塞项，即使实现看起来正确 —— 失败通常意味着遗漏了验收标准，而非测试不稳定。

如果这些不变量中的任何一项被绕过（例如直接对工作树运行 `claude`、跳过 `/gsd-verify-work`，或在没有用户确认的情况下通过跟踪 API 脚本化创建议题），本指南的保证将不再适用。

## 非目标

本指南刻意**不**提出以下任何内容。在此列出，以防止未来贡献者在代码审查中重新讨论：

- **不内嵌或复制 Symphony 代码。** GSD 复用自身原语。上述映射是概念性的；本代码库中不包含任何 Symphony 衍生源码。
- **无长期运行的守护进程。** GSD 不轮询 GitHub 或 Linear。Manager 和自主工作流通过后台代理语义处理并发，而非通过守护进程。
- **无强制跟踪系统依赖。** 该循环无需任何跟踪系统集成即可运行。"跟踪议题"步骤是一种*人工输入* —— URL 写入 `CONTEXT.md`。GSD 不关心你使用哪个跟踪系统，或者你是否使用跟踪系统。
- **不绕过验证、审核或人工决策门控。** 即使在运行 `/gsd-autonomous` 时，验证和审核门控依然触发。"autonomous（自主）"标签指的是阶段间的推进，而非跳过人工批准。
- **不扩展默认技能 / 命令面。** 本指南引用的每一条命令均已存在。本指南是文档面，而非功能面。

## 可能的未来后续

如果维护者在使用该循环的过程中积累了足够的经验，一个独立的 approved-enhancement 可在未来添加*最小化*的跟踪桥接：

- 将一个 GitHub 或 Linear 议题导入 GSD 工作区 / 阶段。
- 将 `UAT.md` 证据作为评论导出到源议题。
- 从 `/gsd-capture --seed` 输出生成后续跟踪议题。

上述每一项都将是独立的增强提案，因为每项都增加了集成面和持续维护负担。它们超出了本指南的范围。

## 相关资源

- [阶段循环](explanation/the-phase-loop.md) — 说明 discuss → plan → execute → verify → ship 如何作为重复循环组合在一起。
- [工作区操作指南](how-to/work-in-parallel-with-workstreams.md) — 创建和管理并行工作树的逐步指南。
- [文档索引](README.md) — GSD Core 文档的完整目录。
- [docs/USER-GUIDE.md](./USER-GUIDE.md) — 上述各命令以任务为导向的操作指南。
- [docs/COMMANDS.md](COMMANDS.md) — `/gsd-*` 命令的完整参考。
- [docs/FEATURES.md](FEATURES.md) — 功能级能力矩阵（工作区、manager、autonomous、verify、review、ship）。
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 阶段产物生命周期与 `STATE.md` 机制。
