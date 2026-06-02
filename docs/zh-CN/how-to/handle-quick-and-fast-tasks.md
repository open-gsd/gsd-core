# 如何处理快速轻量级任务

并非每项工作都需要完整的阶段流程。GSD 提供了两个轻量级命令，适用于不需要完整的讨论 → 计划 → 执行 → 验证循环的工作。

有关何时值得使用完整阶段流水线的说明，请参阅[上下文工程](../explanation/context-engineering.md)。

---

## 决定使用哪个命令

| 场景 | 命令 |
|-----------|---------|
| 修复 Bug、添加小功能，或任何无法概括为单一琐碎编辑的任务 | `/gsd-quick` |
| 修复错别字、更新配置值、添加 `.gitignore` 条目，或任何涉及 ≤ 3 个文件且耗时不到一分钟的更改 | `/gsd-fast` |
| 任务有未知因素、需要调研，或将涉及超过几个文件 | `/gsd-quick` 加 `--research` |

**经验法则：** 如果你哪怕有一刻犹豫该任务是否属于琐碎操作，就使用 `/gsd-quick`。当范围看起来不够简单时，`/gsd-fast` 会自动将你重定向到 `/gsd-quick`。

---

## `/gsd-quick` — 带有 GSD 保证的临时任务

`/gsd-quick` 运行一个规划器和执行器，提供与完整阶段相同的原子提交和 STATE.md 跟踪保证，但无需阶段开销（无 ROADMAP 条目、无讨论阶段、无跨多个计划的波次协调）。

### 基本用法

```bash
/gsd-quick
```

GSD 会提示你输入任务描述，然后进行规划和执行。产出物保存在 `.planning/quick/` 中。

你也可以直接传入描述：

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

### 标志

当任务需要时，添加标志可引入更多质量流水线步骤。

| 标志 | 功能说明 |
|------|-------------|
| `--discuss` | 在规划器运行前进行轻量级的预规划讨论，梳理灰色地带并将决策记录到 `CONTEXT.md` 中 |
| `--research` | 由专注的调研代理在规划前调查方案、库和潜在问题 |
| `--validate` | 计划检查（最多 2 次迭代）加上执行后验证 |
| `--full` | 以上全部 — 等同于 `--discuss --research --validate` |

标志可自由组合：

```bash
/gsd-quick --research --validate   # research + plan-checking + verification, no discuss
/gsd-quick --discuss               # just surface grey areas before planning
/gsd-quick --full                  # the complete quality pipeline
```

### 何时添加标志

- 当你不确定如何处理任务或使用哪个库时，添加 `--research`。
- 当任务涉及关键代码路径，且你希望验证代理确认必要条件已满足时，添加 `--validate`。
- 当任务有设计选择需要在规划器运行前锁定时，添加 `--discuss`——例如，当正确的错误处理行为不够明显时。
- 当任务确实比较重要，通常应作为阶段规划，但又不属于 ROADMAP 范畴时，使用 `--full`。

### 列出和恢复快速任务

```bash
/gsd-quick list                    # show all quick tasks with status
/gsd-quick status my-task-slug     # show status of a specific task
/gsd-quick resume my-task-slug     # resume an interrupted task
```

---

## `/gsd-fast` — 内联琐碎编辑

`/gsd-fast` 直接在当前上下文中完成工作。没有子代理、没有 `PLAN.md`，也没有调研。它仅适用于你自己在一分钟内即可完成的更改。

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to .gitignore"
```

如果你省略描述，GSD 会提示你输入。

`/gsd-fast` 在继续操作前会检查任务是否确实属于琐碎操作。如果判断范围过大，它会停止并重定向你：

```text
This looks like it needs planning. Use /gsd-quick instead:
  /gsd-quick "your task description"
```

完成更改后，`/gsd-fast` 以原子方式提交，并且如果 `.planning/STATE.md` 中存在 `Quick Tasks Completed` 表格，则向其追加一行。

---

## `/gsd-quick` 相比 `/gsd-fast` 多提供的能力

| 能力 | `/gsd-fast` | `/gsd-quick` |
|------------|------------|--------------|
| 子代理规划器 | 否 | 是 |
| 子代理执行器 | 否 | 是 |
| 调研代理 | 否 | 可选（`--research`） |
| 计划检查 | 否 | 可选（`--validate`） |
| 执行后验证 | 否 | 可选（`--validate`） |
| 讨论阶段 | 否 | 可选（`--discuss`） |
| 工作树隔离 | 否 | 是（默认） |
| 每任务原子提交 | 单次提交 | 每个计划任务一次 |
| STATE.md 跟踪 | 若表格存在则追加行 | 始终更新 |
| `.planning/quick/` 产出物 | 否 | 是 |

关键区别在于子代理隔离。`/gsd-quick` 在独立的上下文窗口中启动全新的规划器和执行器，这意味着工作会被妥善规划，提交按任务原子化，且编排器可验证结果。`/gsd-fast` 仅使用当前上下文窗口，有意限制于无需上述任何流程的琐碎更改。

---

## 相关文档

- [阶段循环](../explanation/the-phase-loop.md)
- [上下文工程](../explanation/context-engineering.md)
- [命令参考](../COMMANDS.md)
- [文档索引](../README.md)
