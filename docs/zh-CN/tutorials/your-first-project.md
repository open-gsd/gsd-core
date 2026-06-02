# 你的第一个项目

在本教程中，你将安装 GSD Core 并从头构建一个小型命令行待办事项应用——一个阶段、一个 PR、完整的流程循环。完成后，你将至少运行过核心阶段循环中的每一条命令一次，并看到每条命令所生成的规划产物。

---

## 你将构建什么

一个 Node.js CLI 工具，支持添加、列出和完成存储在本地 JSON 文件中的待办事项。它足够小，可以在一次会话中完成，且仅使用 Node.js 标准库，无需安装任何额外依赖。

---

## 前提条件

- **Node.js 18 或更高版本** — `node --version` 应打印 `v18.x.x` 或更高版本。
- **Claude Code** — 在你想使用的项目目录中打开。
- 初次安装需要网络连接。

不需要其他工具。GSD Core 本身将在下一步安装。

---

## 第 1 步 — 安装 GSD Core

在项目目录中打开终端并运行：

```bash
npx @opengsd/gsd-core@latest
```

安装程序会询问你使用的 AI 编程运行时，以及是全局安装还是安装到当前项目。现在选择 **Claude Code** 和**本地安装**（仅此项目）。

你将看到类似如下的输出：

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

注意项目中现在存在一个 `.claude/` 目录。这是 GSD Core 的命令和代理所在的位置。

> 为什么选本地而不是全局？本地安装可将技能版本固定到该项目。如需全局安装，请参阅 [在你的运行时上安装](../how-to/install-on-your-runtime.md)。

---

## 第 2 步 — 以权限模式启动 Claude Code

GSD Core 会生成读写文件的子代理。以权限标志启动 Claude Code，这样它就不会在每次文件操作时暂停询问：

```bash
claude --dangerously-skip-permissions
```

你将进入项目目录中的 Claude Code 提示符。

---

## 第 3 步 — 创建项目

在 Claude Code 提示符处输入以下斜杠命令：

```text
/gsd-new-project
```

GSD Core 将开启一段对话。它首先提问：

```text
What do you want to build?
```

输入类似以下内容：

```text
A Node.js CLI tool for managing to-do items. Users run `todo add "buy milk"`,
`todo list`, and `todo done 1`. Items are saved to a local todos.json file.
No external dependencies — Node built-ins only.
```

GSD Core 会继续提出几个澄清性问题。自然地回答即可。它在撰写任何计划之前，正在了解你的关注点。

问题结束后，它会提议进行领域调研。对于如此小的项目，你可以跳过调研——在提示时选择**跳过调研**。

GSD Core 随后会要求你选择工作流设置（模式、粒度、调研代理）。每项均选择推荐的默认值。这些设置将写入 `.planning/config.json`。

最后，一个路线图子代理开始运行（你会看到"Spawning roadmapper…"的提示——这是正常的，大约需要一分钟）。返回后，GSD Core 会展示一份路线图提案。对于单阶段项目，它看起来类似：

```text
Proposed Roadmap

1 phase | 4 requirements mapped | All v1 requirements covered ✓

| # | Phase              | Goal                                    | Requirements      |
|---|--------------------|-----------------------------------------|-------------------|
| 1 | Core CLI           | add / list / done commands, todos.json  | CLI-01 … CLI-04   |
```

输入 **Approve** 以接受路线图。

**`.planning/` 中创建的内容：**

```text
.planning/
  PROJECT.md          ← 你的项目描述和需求
  REQUIREMENTS.md     ← 每个 v1 功能的 REQ-ID
  ROADMAP.md          ← 第 1 阶段，状态：待处理
  STATE.md            ← 会话记忆，当前位置
  config.json         ← 工作流设置
```

现在打开 `.planning/ROADMAP.md` 并阅读。注意第 1 阶段有目标、必须满足的需求列表和成功标准——这些是执行必须交付的可观测行为。

---

## 第 4 步 — 清除上下文并讨论第 1 阶段

GSD Core 的设计围绕全新的上下文。在每个阶段之前清除主会话窗口：

```text
/clear
```

然后开始第 1 阶段的讨论：

```text
/gsd-discuss-phase 1
```

GSD Core 读取阶段目标并询问你的实现偏好。这些决定将影响*如何*构建，而不仅仅是*构建什么*。示例交流：

```text
> How should done items be stored — mark them in place or move them?
  Mark them in place with a "done" flag.

> Should `todo list` show completed items by default?
  No, hide them unless --all is passed.

> Error format when todos.json doesn't exist yet?
  Create it silently on first add.
```

讨论结束后，GSD Core 会写入：

```text
.planning/phases/01-core-cli/CONTEXT.md
```

打开该文件。你会看到一个 `## Implementation Decisions` 章节，准确记录了你所说的内容。规划器读取该文件——因此你在此处做出的决定将贯穿到每个任务计划中。

---

## 第 5 步 — 规划第 1 阶段

```text
/gsd-plan-phase 1
```

四个调研子代理并行展开工作（你会看到"Spawning 4 researchers…"的提示）。这需要 1–5 分钟，请勿中断。

返回后，规划器读取 CONTEXT.md 和调研结果，创建原子任务计划。然后，计划检查器在保存之前验证每个计划是否实现了阶段目标。

**创建的内容：**

```text
.planning/phases/01-core-cli/
  RESEARCH.md         ← 领域调研结果
  01-01-PLAN.md       ← 任务：创建 todos.json 读写助手
  01-02-PLAN.md       ← 任务：实现 add / list / done 命令
```

打开 `01-01-PLAN.md`。你会看到一个 `<task>` 块，包含名称、涉及的文件、操作步骤、验证命令和完成条件。注意 `<verify>` 标签——GSD Core 的执行器将在写入代码后运行该命令。

---

## 第 6 步 — 执行第 1 阶段

```text
/gsd-execute-phase 1
```

GSD Core 将计划分组为波次（独立计划并行运行），为每个计划生成一个全新的 200k 上下文执行器，并原子性地提交每个任务。

你将看到类似如下内容：

```text
Wave 1 (parallel):
  [Executor A] → 01-01-PLAN.md (read/write helpers)   ✓ committed
  [Executor B] → 01-02-PLAN.md (CLI commands)          ✓ committed

[Verifier] Checking codebase against phase goals...
  CLI-01 todo add   ✓
  CLI-02 todo list  ✓
  CLI-03 todo done  ✓
  CLI-04 --all flag ✓
  Status: PASS
```

**创建的内容：**

```text
.planning/phases/01-core-cli/
  01-01-SUMMARY.md    ← 执行器 A 构建并提交的内容
  01-02-SUMMARY.md    ← 执行器 B 构建并提交的内容
  VERIFICATION.md     ← REQ 覆盖情况：PASS
```

现在运行你的 CLI：

```bash
node todo.js add "buy milk"
node todo.js add "write tests"
node todo.js list
node todo.js done 1
node todo.js list
```

你应该看到条目出现，并且在标记完成后，条目 1 从默认列表中消失。这是 GSD Core 交付的你的第一个可见结果。

---

## 第 7 步 — 验证工作

```text
/gsd-verify-work 1
```

GSD Core 提取阶段的成功标准并逐一引导你完成：

```text
[1/3] Can you run `node todo.js add "buy milk"` without errors?
> yes

[2/3] Does `node todo.js list` show only incomplete items by default?
> yes

[3/3] Does `node todo.js done 1` mark item 1 complete and hide it from the default list?
> yes

All 3 checks passed. Phase 1 verified.
```

如果任何检查失败，GSD Core 会诊断根本原因并创建修复计划。再次运行 `/gsd-execute-phase 1` 应用修复，然后重新运行 `/gsd-verify-work 1`。

**创建的内容：**

```text
.planning/phases/01-core-cli/UAT.md   ← 所有检查及其结果
```

---

## 第 8 步 — 发布

```text
/gsd-ship 1
```

GSD Core 使用自动生成的正文创建拉取请求。PR 正文始终包含：摘要、变更内容、已解决的需求、验证情况和关键决策。

你将看到：

```text
Pull request created: https://github.com/your-org/your-repo/pull/1

Title: feat(phase-1): core CLI — add / list / done commands
```

这就是完整的流程——从想法到合并 PR——一个阶段。

---

## 你学到了什么

- 如何使用 `npx @opengsd/gsd-core@latest` 安装 GSD Core。
- `/gsd-new-project` 如何将一段对话转化为由 `.planning/` 产物支撑的路线图。
- `/gsd-discuss-phase` 如何在任何规划开始之前捕获实现决策。
- `/gsd-plan-phase` 如何生成并行调研器并产出原子任务计划。
- `/gsd-execute-phase` 如何以并行波次运行这些计划并提交每个任务。
- `/gsd-verify-work` 如何引导完成成功标准并在需要时生成修复计划。
- `/gsd-ship` 如何将已验证的阶段转化为拉取请求。

对于多阶段项目，对每个阶段重复第 4–8 步，然后运行 `/gsd-progress --next`，让 GSD Core 自动检测下一步。

---

## 相关资源

- [阶段循环](../explanation/the-phase-loop.md) — 循环为何如此设计
- [操作指南](../README.md#how-to-guides) — 针对特定情况的任务型操作说明
- [接入现有代码库](onboarding-an-existing-codebase.md) — 将 GSD Core 引入棕地仓库
