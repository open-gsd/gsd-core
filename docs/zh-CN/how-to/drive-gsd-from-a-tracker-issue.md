# 如何从追踪器议题驱动 GSD Core

**目标：** 将一个范围明确的 GitHub、Linear 或 Jira 议题，通过完整的 GSD 流水线从隔离工作区推进至合并 PR——仅使用 GSD Core 中已有的命令，无需任何自定义脚本或追踪器集成。

**前提条件：** GSD Core 已安装。议题范围有边界、验收标准可观测，且无上游阻塞依赖。

有关该模式背后的概念与设计理由，请参阅[议题驱动编排详解](../issue-driven-orchestration.md)。

---

## 第一步：将议题映射到阶段

打开追踪器议题，决定它如何对应 `ROADMAP.md` 中的阶段：

- **议题与现有阶段匹配** → 记下阶段编号，转至第二步。
- **议题是独立的新工作** → 添加一个阶段：

```bash
/gsd-phase "描述与议题标题一致的内容"
```

- **议题紧急，必须插入现有阶段之间** → 插入一个小数阶段：

```bash
/gsd-phase --insert 3 "Fix: 来自议题的描述"
```

复制追踪器议题的 URL。您将在第三步中将其粘贴到 `CONTEXT.md`，以便在上下文压缩后仍保留可追溯性。

---

## 第二步：创建隔离工作区

每个议题都有专属工作区——一个带有独立 `.planning/` 目录的 git worktree。未完成的工作、中止的计划和探索性提交均保留在 `main` 之外。

```bash
/gsd-workspace --new --name my-issue-slug --repos . --strategy worktree
```

继续操作前，切换到工作区目录：

```bash
cd ~/gsd-workspaces/my-issue-slug
```

---

## 第三步：讨论阶段

运行 discuss-phase，在规划开始之前确定实现决策。会话打开后，将追踪器议题 URL 粘贴到讨论中，以便记录到 `CONTEXT.md`。

```bash
/gsd-discuss-phase N
```

GSD 会就议题范围中的模糊点进行提问——错误处理、边界情况、接口契约、技术选型。您的回答将影响后续生成的计划。

如果您已知晓所有答案并希望快速推进：

```bash
/gsd-discuss-phase N --auto
```

---

## 第四步：规划阶段

```bash
/gsd-plan-phase N
```

GSD 会派生研究代理，读取您的 `CONTEXT.md` 决策（包括议题 URL），并生成原子化的 `PLAN.md` 文件。计划检查器会在保存前验证每份计划。

如果您希望在执行前由外部 AI CLI 进行同行评审（对于重大变更推荐使用）：

```bash
/gsd-review --phase N
/gsd-plan-phase N --reviews
```

或运行完整的计划-评审-收敛循环，直到不再有 HIGH 级别的问题：

```bash
/gsd-plan-review-convergence N
```

---

## 第五步：执行阶段

交互式逐阶段执行：

```bash
/gsd-execute-phase N
```

无人值守地运行所有剩余阶段：

```bash
/gsd-autonomous
```

在可视化仪表盘中监控进度并跨阶段调度工作：

```bash
/gsd-manager
```

三种方式均会更新 `STATE.md`，原子化提交每项任务，并运行阶段后验证器。

---

## 第六步：验证工作

```bash
/gsd-verify-work N
```

GSD 会逐条引导您核对阶段目标中的验收标准（与追踪器议题对应）。如有失败，GSD 会诊断根本原因并创建修复计划。重复执行和重新验证，直到所有检查通过。

即使代码看起来正确，也应将 `verification_failed` 视为阻塞——失败通常会揭示原始议题中遗漏的验收标准。

---

## 第七步：评审与发布

在开启 PR 前先进行代码评审：

```bash
/gsd-code-review N
/gsd-code-review N --fix
```

然后创建 PR：

```bash
/gsd-ship N
```

GSD 会从您的规划产物中组装 PR 正文：阶段目标、变更摘要、已满足的需求、验证状态和关键决策。在 PR 正文中加入 `Closes #NNN` 或 `Fixes #NNN`（或通过 `/gsd-config` 设置），以便在 PR 合并时自动关闭追踪器议题。

---

## 第八步：记录后续工作

在处理议题的过程中，您常常会发现相关工作。在不丢失上下文的情况下进行记录：

```bash
/gsd-capture "Follow-up: 发现的工作描述"           # 作为待办事项添加
/gsd-capture --seed "值得未来阶段考虑的想法"         # 为下一个里程碑保留
/gsd-capture --backlog "不紧急但值得跟踪的内容"      # 存入待办列表
```

GSD 不会自动向追踪器发布内容。从已记录的后续工作中创建追踪器议题是独立的手动步骤——这保留了人工审核的环节。

---

## 条件场景

| 情境 | 处理方式 |
|-----------|-----------|
| 议题非常小（拼写错误、配置变更） | 跳过工作区 + 讨论 + 规划；改用 `/gsd-quick` |
| 议题包含多个独立子任务 | 使用 `/gsd-manager` 跨计划并行执行 |
| 议题被其他议题阻塞 | 在上游阻塞解除前不要开始；GSD 没有自动依赖轮询 |
| 执行中途发现议题范围比预期大 | 停止，运行 `/gsd-phase --insert N` 添加子阶段，然后继续 |
| 想跳过交互式讨论 | 对 `/gsd-discuss-phase` 使用 `--auto` 标志，或为项目级自动化设置 `workflow.skip_discuss: true` |
| 多个议题构成一个连贯的发布版本 | 运行 `/gsd-new-milestone` 将其分组，并运行 `/gsd-autonomous` 按顺序执行 |

---

## 相关资源

- [议题驱动编排详解](../issue-driven-orchestration.md)
- [使用工作区隔离工作](isolate-work-with-workspaces.md)
- [验证与发布](verify-and-ship.md)
- [文档索引](../README.md)
