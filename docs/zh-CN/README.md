# GSD Core 文档

文档按四个象限组织：**教程**通过实践帮助你学习，**操作指南**解决具体任务，**参考文档**提供权威信息，**概念说明**探讨设计理念与决策。

语言版本：[English](../README.md) · [Português (pt-BR)](../pt-BR/README.md) · [日本語](../ja-JP/README.md) · [简体中文](README.md)

---

## Tutorials

- [第一个项目](tutorials/your-first-project.md) — 从安装到首个已交付阶段，一条有保障的路径
- [接入现有代码库](tutorials/onboarding-an-existing-codebase.md) — 将 GSD Core 引入已有项目的代码库

---

## How-to guides

- [在你的运行时上安装](how-to/install-on-your-runtime.md) — 适用于全部 15 个受支持运行时的安装步骤
- [讨论一个阶段](how-to/discuss-a-phase.md) — 在规划开始前记录实现决策
- [规划一个阶段](how-to/plan-a-phase.md) — 执行调研、分解工作并验证计划质量
- [执行一个阶段](how-to/execute-a-phase.md) — 使用全新上下文的子代理以并行波次运行计划
- [验证并交付](how-to/verify-and-ship.md) — 审查已完成的工作、诊断失败并创建 PR
- [自主运行阶段](how-to/run-phases-autonomously.md) — 使用自主模式进行无人值守的阶段执行
- [处理快速临时任务](how-to/handle-quick-and-fast-tasks.md) — 使用 `/gsd-quick` 和 `/gsd-fast` 处理阶段循环之外的临时工作
- [配置模型配置文件](how-to/configure-model-profiles.md) — 在高质量、均衡和经济模型层级之间切换
- [设置跨 AI 审查](how-to/set-up-cross-ai-review.md) — 配置第二个 AI 对主代理生成的代码进行审查
- [使用工作流并行工作](how-to/work-in-parallel-with-workstreams.md) — 使用工作流同时运行独立的工作线
- [使用工作空间隔离工作](how-to/isolate-work-with-workspaces.md) — 使用工作空间对实验性或高风险变更进行沙箱隔离
- [调试失败的执行](how-to/debug-a-failed-execution.md) — 诊断并从中断或不完整的阶段执行中恢复
- [探索与草图](how-to/spike-and-sketch.md) — 在提交计划之前，使用 `/gsd-spike` 和 `/gsd-sketch` 进行探索性工作
- [设计 UI 阶段](how-to/design-a-ui-phase.md) — 使用 UI 阶段循环处理前端和视觉工作
- [从追踪器 Issue 驱动 GSD](how-to/drive-gsd-from-a-tracker-issue.md) — 从 GitHub、Linear 或 Jira issue 启动一个阶段
- [从 GSD 2 迁移](how-to/migrate-from-gsd-2.md) — 将现有的 GSD 2 项目升级到 GSD Core
- [更新 GSD](how-to/update-gsd.md) — 重新运行安装程序以获取最新版本
- [恢复与故障排查](how-to/recover-and-troubleshoot.md) — 修复常见问题、重建上下文并卸载

---

## Reference

- [命令](COMMANDS.md) — 每个命令的标志和示例
- [配置](CONFIGURATION.md) — 完整配置模式、模型配置文件、Git 分支策略
- [CLI 工具](CLI-TOOLS.md) — `gsd-tools.cjs` 用于工作流和代理的编程式 API
- [功能特性](FEATURES.md) — 完整功能索引
- [清单](INVENTORY.md) — 已安装的技能与界面映射
- [STATE.md 模式](reference/state-md.md) — `.planning/STATE.md` 的逐字段参考
- [CONTEXT.md 模式](reference/context-md.md) — `.planning/phases/<N>/CONTEXT.md` 的逐字段参考
- [PLAN.md 模式](reference/plan-md.md) — `.planning/phases/<N>/PLAN.md` 的逐字段参考
- [规划产物](reference/planning-artifacts.md) — 所有 `.planning/` 文件及其作用

---

## Explanation

- [上下文工程](explanation/context-engineering.md) — 上下文腐化如何形成，以及 GSD Core 如何防止它
- [阶段循环](explanation/the-phase-loop.md) — 讨论 → 规划 → 执行 → 验证 → 交付循环的设计原理
- [多代理编排](explanation/multi-agent-orchestration.md) — 子代理的生成、范围界定和协调方式
- [安全模型](explanation/security-model.md) — 信任边界、权限和安全自动化
- [架构](ARCHITECTURE.md) — 系统架构、代理模型和数据流
- [讨论模式](workflow-discuss-mode.md) — `/gsd-discuss-phase` 的假设模式与访谈模式
- [上下文监控](context-monitor.md) — 上下文窗口监控钩子架构
- [Issue 驱动编排](issue-driven-orchestration.md) — 使用现有原语从追踪器 issue 驱动 GSD 的方案

---

## Related

- [根目录 README](../README.md) — 首页、快速开始和文档概览
- [变更日志](../../CHANGELOG.md) — 发布历史
