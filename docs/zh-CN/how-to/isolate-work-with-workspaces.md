# 如何使用工作区隔离工作

**目标：** 创建一个完全隔离的 GSD 环境——独立的 git worktree、独立的 `.planning/` 根目录，以及可选的多仓库支持——适用于功能分支或多仓库工作场景。

**前提条件：** 已安装 `git` 且仓库支持 worktree。对于多仓库工作区，目标仓库需存在于本地或可通过路径访问。

---

## 什么是工作区

工作区是一个自包含的环境，将一个或多个 git worktree（或克隆）与独立的 `.planning/` 根目录配对。每个工作区包含：

- 独立的 `.planning/` 目录，**完全独立**于源仓库的 `.planning/`——并非其子目录
- 独立的 `WORKSPACE.md` 清单文件，用于跟踪成员仓库
- git worktree（默认）或指定仓库的完整克隆，在专用分支上检出（默认：`workspace/<name>`）

工作区默认存放在 `~/gsd-workspaces/<name>/` 下。

```
~/gsd-workspaces/
└── feature-b/
    ├── WORKSPACE.md        ← 清单文件
    ├── .planning/          ← 完全独立的 GSD 状态
    │   ├── PROJECT.md
    │   ├── ROADMAP.md
    │   └── ...
    ├── hr-ui/              ← hr-ui 仓库的 worktree 或克隆
    └── ZeymoAPI/           ← ZeymoAPI 仓库的 worktree 或克隆
```

由于工作区的 `.planning/` 与源仓库相互独立，不会与源仓库中已有的规划状态发生重叠或冲突。

---

## 为多个仓库创建工作区

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
```

GSD 会在 `~/gsd-workspaces/feature-b/` 中创建 `hr-ui` 和 `ZeymoAPI` 的 worktree，在每个仓库中检出 `workspace/feature-b` 分支，写入 `WORKSPACE.md`，并创建一个空的 `.planning/` 目录，准备好供 `/gsd-new-project` 使用。

自定义位置：

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI --path /projects/feature-b
```

---

## 为当前仓库创建工作区

当你需要在单个仓库上进行功能分支隔离——独立分支、独立 `.planning/`、不受 main 分支状态影响时：

```bash
/gsd-workspace --new --name payments-rework --repos .
```

`.` 表示为当前仓库创建 worktree，该 worktree 会在 `workspace/payments-rework` 分支上检出。

若要强制使用完整克隆而非 worktree：

```bash
/gsd-workspace --new --name payments-rework --repos . --strategy clone
```

---

## 显式指定分支

```bash
/gsd-workspace --new --name payments-rework --repos . --branch feature/payments-v2
```

`--branch` 标志为工作区中所有仓库设置分支名称，默认为 `workspace/<name>`。

---

## 跳过交互式询问

```bash
/gsd-workspace --new --name payments-rework --repos . --auto
```

GSD 将接受所有默认值，无需提示确认。

---

## 在工作区内初始化 GSD

创建工作区后，进入工作区目录并初始化 GSD 项目：

```bash
cd ~/gsd-workspaces/feature-b
/gsd-new-project
```

工作区内的 `.planning/` 目录是从该目录运行所有后续 GSD 命令的根目录。它与源仓库中存在的任何 `.planning/` 完全独立。

---

## 列出工作区

```bash
/gsd-workspace --list
```

打印所有活跃的 GSD 工作区及其状态。

---

## 删除工作区

```bash
/gsd-workspace --remove feature-b
```

GSD 会移除 git worktree 并清理工作区目录。此操作不会从远程仓库删除分支——仅删除本地 worktree 和工作区目录。

---

## 何时使用工作区而非工作流

选择工作区的场景：

- 你需要跨**多个仓库**协同工作，且这些仓库需要在同一个 GSD 项目下进行协调（例如，一个 API 仓库和一个 UI 仓库需要一起发布）
- 你需要每个功能拥有**独立的 git worktree**，带有各自的分支、锁文件和构建产物——以确保一个环境中的构建和依赖安装不会影响另一个环境
- 你希望拥有**完全独立的 `.planning/` 根目录**，而非主仓库 `.planning/` 的子目录
- 你正在采用 Issue 驱动的工作流，将每个跟踪器 Issue 映射到一个工作区（参见[从跟踪器 Issue 驱动 GSD](drive-gsd-from-a-tracker-issue.md)）

选择[工作流](work-in-parallel-with-workstreams.md)的场景：

- 所有工作都在**单一仓库**中进行，共享相同的 git 历史
- 你希望在不同关注领域（API、UI、基础设施）上并发运行 `/gsd-plan-phase` 或 `/gsd-discuss-phase`，且各自的 `STATE.md` 文件之间互不干扰
- 你不需要每个关注领域拥有独立的 worktree；切换规划上下文即可满足需求

---

## 相关内容

- [使用工作流并行工作](work-in-parallel-with-workstreams.md)
- [从跟踪器 Issue 驱动 GSD](drive-gsd-from-a-tracker-issue.md)
- [命令](../COMMANDS.md)
- [文档索引](../README.md)
