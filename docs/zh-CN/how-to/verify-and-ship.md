# 如何验证并发布阶段

**目标：** 对已执行的工作进行用户验收测试，诊断并修复任何失败，然后开启一个带有自动生成正文的拉取请求。

**前提条件：** 该阶段已执行完毕并包含 `SUMMARY.md` 文件。如果执行尚未完成，请参阅[执行阶段](execute-a-phase.md)。

---

## 运行用户验收测试

```bash
/gsd-verify-work 1
```

GSD Core 读取该阶段的 `SUMMARY.md` 文件，提取用户可观测的交付物，并逐一引导您完成验证。对于每个检查点，它会展示*应该*发生的情况，并询问实际情况是否与之匹配。

- `yes` / `y` / 直接回车 → 通过，进入下一项测试
- 其他任何输入 → 记录为问题，严重程度根据您的描述推断

您无需手动分类严重程度——GSD Core 会从您的描述中推断（"崩溃" → 阻塞级，"无法使用" → 严重级，"看起来不对" → 外观级）。

进度将写入 `.planning/phases/01-<name>/01-UAT.md`，在 `/clear` 之后依然保留。若会话中断，重新运行 `/gsd-verify-work 1`，GSD Core 会提示是否从上次检查点恢复。

---

## 发现失败时：自动诊断与修复规划

如果有测试报告问题，GSD Core 会自动执行以下步骤：

1. **诊断根本原因** — 为每个问题并行启动调试代理，并将根本原因更新至 `UAT.md`。
2. **规划差距弥补** — 在差距弥补模式下启动 `gsd-planner`，读取 `UAT.md`（含诊断结果）并生成新的 `PLAN.md` 文件。
3. **验证修复计划** — 启动 `gsd-plan-checker` 确保计划可执行。若发现问题，规划器与检查器最多迭代三次。
4. **呈现下一步** — 当计划通过检查器时：

```
Plans verified and ready for execution.

`/clear` then `/gsd-execute-phase 1 --gaps-only`
```

运行提示的命令以应用修复，然后重新运行 `/gsd-verify-work 1` 确认一切通过。

---

## 所有测试通过时：发布阶段

一旦所有 UAT 测试通过（或首次运行且未发现问题），该阶段将自动在 `ROADMAP.md` 和 `STATE.md` 中标记为已完成。

```bash
/gsd-ship 1
```

GSD Core 执行预检（验证状态、干净的工作树、分支、远程仓库、`gh` CLI 身份验证），推送分支并创建 PR：

```bash
/gsd-ship 1          # 准备审查的 PR
/gsd-ship 1 --draft  # 草稿 PR — 当后续还有更多阶段时很有用
```

PR 正文由规划产物自动组装：

- 来自 `ROADMAP.md` 的阶段目标
- 来自 `SUMMARY.md` 文件及其关键文件的各计划摘要
- 已解决的需求（REQ-IDs）
- 来自 `VERIFICATION.md` 的验证状态
- 来自 `STATE.md` 的关键决策

无需手动编写正文。

---

## 可选：发布前或发布后的代码审查

`/gsd-ship` 不会自动运行代码审查，但您可以在任意节点插入审查：

**验证前**（在 UAT 之前发现问题）：

```bash
/gsd-code-review 1          # 标准审查
/gsd-code-review 1 --fix    # 审查后自动修复 Critical 和 Warning 发现
```

**PR 开启后**（在合并前把关质量）：

```bash
/gsd-code-review 1 --depth=deep  # 包含导入图的跨文件分析
```

请参阅[配置跨 AI 审查](set-up-cross-ai-review.md)，了解如何在周期早期为计划审查配置 Gemini、Codex 或其他审查工具。

---

## 可选：创建干净的 PR 分支

如果您的分支包含不希望审查者看到的 `.planning/` 提交：

```bash
/gsd-pr-branch          # 相对于 main 进行过滤
/gsd-pr-branch develop  # 相对于 develop 进行过滤
```

`/gsd-pr-branch` 会创建一个仅包含代码变更的新分支——规划产物提交将被排除。若您的团队审查规范不包含规划噪音，请在 `/gsd-ship` 之前运行此命令。

---

## 关闭里程碑

如果这是里程碑中的最后一个阶段，请运行里程碑审计并将其归档：

```bash
/gsd-audit-milestone      # 验证所有需求已发布
/gsd-complete-milestone   # 归档，创建 git 标签
```

`/gsd-complete-milestone` 是 PR 合并后的自然下一步。请参阅[阶段循环](../explanation/the-phase-loop.md)，了解验证与发布如何融入完整的项目生命周期。

---

## 相关内容

- [执行阶段](execute-a-phase.md)
- [配置跨 AI 审查](set-up-cross-ai-review.md)
- [阶段循环](../explanation/the-phase-loop.md)
- [命令参考](../COMMANDS.md)
