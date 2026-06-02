# 如何通过工作流并行处理多个领域

**目标：** 并发推进不同里程碑领域（后端 API、前端仪表板、基础设施或其他关注点）的工作，同时避免一个领域的规划状态污染另一个领域。

**前提条件：** 已激活的 GSD Core 项目（`.planning/ROADMAP.md` 存在）。若尚未创建，请先运行 `/gsd-new-project`。

---

## 什么是工作流

工作流是单一代码库内部的隔离规划上下文。每个工作流拥有独立的 `.planning/workstreams/<name>/` 子树，其中包含独立的 `STATE.md`、`ROADMAP.md`、`REQUIREMENTS.md` 以及 `phases/` 目录。代码库本身——源代码、git 历史记录和分支——在所有工作流之间共享。

```
.planning/
├── PROJECT.md          ← shared
├── config.json         ← shared
├── codebase/           ← shared
└── workstreams/
    ├── backend-api/
    │   ├── STATE.md
    │   ├── ROADMAP.md
    │   ├── REQUIREMENTS.md
    │   └── phases/
    └── frontend-dash/
        ├── STATE.md
        ├── ROADMAP.md
        ├── REQUIREMENTS.md
        └── phases/
```

当某个工作流处于激活状态时，所有 GSD 命令——`/gsd-progress`、`/gsd-discuss-phase`、`/gsd-plan-phase`、`/gsd-execute-phase`——都将从该工作流的目录读取并写入。切换工作流会将所有这些命令重定向到另一个子树，而不会影响源代码树。

---

## 创建工作流

```bash
/gsd-workstreams create backend-api
```

GSD 会在 `.planning/workstreams/backend-api/` 下创建工作流目录，并初始化一个框架 `STATE.md` 和 `ROADMAP.md`。工作流不会自动激活——需要显式切换。

---

## 列出工作流

```bash
/gsd-workstreams list
```

显示所有工作流，以及当前会话中哪个工作流处于激活状态。

---

## 切换到某个工作流

```bash
/gsd-workstreams switch backend-api
```

从此时起，所有 GSD 工作流命令均在 `backend-api` 上下文中运行。切换是会话范围的：当多个 Claude Code 终端同时打开同一仓库时，每个会话可以持有不同的激活工作流，互不干扰。

切换后，按正常阶段工作流推进：

```bash
/gsd-discuss-phase 1
/gsd-plan-phase 1
/gsd-execute-phase 1
/gsd-verify-work 1
```

如需在另一个领域工作，在第二个终端中切换工作流：

```bash
/gsd-workstreams switch frontend-dash
/gsd-discuss-phase 1
/gsd-plan-phase 1
```

---

## 查看所有工作流的进度

```bash
/gsd-workstreams progress
```

打印跨工作流摘要——每个工作流的阶段状态、当前位置和未完成工作——无需在工作流之间来回切换。

查看单个工作流的详细状态：

```bash
/gsd-workstreams status backend-api
```

---

## 在工作流中恢复工作

在上下文重置或新会话后，恢复您的位置：

```bash
/gsd-workstreams resume backend-api
```

此命令会激活该工作流并恢复上次已知位置，等价于切换后再运行 `/gsd-resume-work`。

---

## 归档已完成的工作流

当某个工作流的里程碑工作完成时：

```bash
/gsd-workstreams complete backend-api
```

GSD 会将该工作流标记为已归档，并将其从活跃列表中移出。规划产物将保留在 `.planning/workstreams/backend-api/` 下以供审计。

---

## 在不切换工作流的情况下将单条命令定向到特定工作流

如需对某个特定工作流运行一条命令，而不更改当前会话的激活上下文，请使用 `--ws` 标志：

```bash
/gsd-progress --ws frontend-dash
/gsd-plan-phase 2 --ws backend-api
```

`--ws` 在解析顺序中具有最高优先级，不会更改会话范围的指针。

---

## 何时选择工作流而非工作区

在以下情况下选择工作流：

- 所有工作都位于**同一仓库**并共享相同的 git 历史记录
- 您希望**并发**规划或讨论不同关注领域（API、UI、基础设施），而不让一个工作流的 `STATE.md` 覆盖另一个的
- 创建时不需要为每个工作流单独建立分支（当然，您仍可在每个工作流的执行过程中正常创建分支）
- 创建完整 git worktree 的开销与所需隔离程度不匹配

在以下情况下选择[工作区](isolate-work-with-workspaces.md)：

- 您需要在**多个仓库**之间工作（例如 `hr-ui` 和 `ZeymoAPI`）
- 每个功能需要**独立 git worktree** 或克隆的隔离——完全独立的分支、锁文件和构建产物
- 您希望在每个工作区中独立运行 `/gsd-new-project`，拥有完全独立的 `.planning/` 根目录，而不是主仓库 `.planning/` 的子目录

---

## 相关文档

- [用工作区隔离工作](isolate-work-with-workspaces.md)
- [阶段循环](../explanation/the-phase-loop.md)
- [命令](../COMMANDS.md)
- [文档索引](../README.md)
