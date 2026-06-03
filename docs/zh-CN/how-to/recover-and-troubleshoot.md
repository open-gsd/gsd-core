# 如何恢复与排查问题

**目标：** 识别并修复常见问题——从上下文丢失、状态损坏，到安装失败和权限错误——采用条件化的处理步骤结构。

**前提条件：** GSD Core 已安装。若遇到安装问题，请参阅 [在您的运行时中安装](install-on-your-runtime.md)。

---

## 上下文与会话问题

### 如果您不清楚当前所处的位置

```bash
/gsd-progress
```

读取所有状态文件，并精确告知您当前位置以及下一步操作。

若要自动跳转到正确的下一步：

```bash
/gsd-progress --next
```

### 如果您正在开始新会话并需要恢复上下文

```bash
/gsd-resume-work
```

从上次交接中恢复完整的会话上下文，包括当前阶段、规划决策以及工作停止的位置。

### 如果长时间会话中质量开始下降

在执行主要命令之间清空上下文窗口：

```bash
/clear
```

然后恢复状态：

```bash
/gsd-resume-work
```

GSD 的设计围绕全新上下文展开。每个子代理已获得干净的 200k 窗口。主会话会随时间退化——清空并恢复才是正确的处理方式，而非继续硬撑。

### 如果您希望在停止前保存上下文

```bash
/gsd-pause-work
```

将当前位置创建为 `.planning/HANDOFF.json`。添加 `--report` 可同时将会话后摘要写入 `.planning/reports/`：

```bash
/gsd-pause-work --report
```

---

## 规划完整性问题

### 如果 `.planning/` 完整性不确定

```bash
/gsd-health
```

以错误、警告和信息说明的形式报告状态：

| 状态 | 含义 |
|--------|---------|
| `HEALTHY` | 所有预期产物存在且格式正确 |
| `DEGRADED` | 存在应当处理的警告，但工作可以继续 |
| `BROKEN` | 存在将阻断执行的严重错误 |

可自动修复的常见问题（错误 E004、E005；警告 W003、W008）：

```bash
/gsd-health --repair
```

该命令会重新创建缺失的 `STATE.md`，将损坏的 `config.json` 重置为默认值，并补充所有缺失的配置键。它不会覆盖 `PROJECT.md` 或 `ROADMAP.md`。

### 如果 STATE.md 引用了不存在的阶段

这会产生警告 `W002`。使用状态 CLI 进行诊断和修复：

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state validate
```

在不写入的情况下预览同步将更改的内容：

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync --verify
```

应用同步：

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync
```

这些命令从磁盘上的实际项目状态重建 `STATE.md`，取代手动编辑 `STATE.md` 的操作。

### 如果看到"项目已初始化"

`.planning/PROJECT.md` 已存在。`/gsd-new-project` 是一项安全检查。如果您确实想重新开始，请先删除 `.planning/` 目录：

```bash
rm -rf .planning/
```

然后重新运行 `/gsd-new-project`。

### 如果上下文窗口利用率过高

```bash
/gsd-health --context
```

探测上下文窗口利用率保护机制。警告阈值为 60%，严重阈值为 70%。如果超过警告阈值，请在开始下一个主要命令前运行 `/clear` 后跟 `/gsd-resume-work`。

---

## 执行问题

### 如果执行器在执行 Bash 命令时遇到"Permission denied"

GSD 的 `gsd-executor` 子代理需要具有写入权限的 Bash 访问。在 `~/.claude/settings.json` 的 `permissions.allow` 下添加所需模式。至少需要：

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git checkout:*)"
```

针对特定技术栈的模式（Rails、Python、Node、Rust），请参阅 `docs/USER-GUIDE.md` 中"执行器子代理遇到 Permission denied"一节的完整表格。

按项目配置的替代方案：在项目根目录的 `.claude/settings.local.json` 中添加相同的配置块。

### 如果执行失败或产生存根代码

检查计划是否过于宏大。计划最多应包含两到三个任务。如果任务太大，则超出单个上下文窗口能可靠产出的范围。请以更小的范围重新规划该阶段：

```bash
/gsd-plan-phase 1
```

若要系统性地诊断出错原因，请参阅 [调试失败的执行](debug-a-failed-execution.md)。

### 如果并行执行导致构建锁定错误或预提交钩子失败

这是由多个代理同时触发构建工具引起的。自 v1.26 起，GSD 自动处理此问题。如果您使用的是旧版本，或仍然出现竞争问题，请禁用并行执行：

```bash
/gsd-settings
```

将 `parallelization.enabled` 设置为 `false`。

### 如果子代理显示失败但提交已完成

在得出某些内容出错的结论之前，请检查 git 日志：

```bash
git log --oneline -10
```

Claude Code 中存在一个已知的分类错误，可能在工作实际成功时报告失败。GSD 的编排器会抽查实际输出，但如果您发现不一致，提交记录才是最终依据。

---

## 计划与阶段问题

### 如果计划看起来有误或与您的意图不符

在规划之前运行 `/gsd-discuss-phase N`。大多数计划质量问题来自本可由 `CONTEXT.md` 预防的假设：

```bash
/gsd-discuss-phase 1
```

若要查看 GSD 当前做出的假设而无需开始完整会话：

```bash
/gsd-discuss-phase 3 --assumptions
```

### 如果您需要在执行后更改某些内容

不要重新运行 `/gsd-execute-phase`。请使用 `/gsd-quick` 进行有针对性的修复：

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

或使用 `/gsd-verify-work N` 通过 UAT 系统性地识别和修复问题。

### 如果命令在"Spawning…"处似乎卡住了

请等待。GSD 子代理在独立的上下文窗口中运行。其工作在进行中对父会话不可见。生成行上的活跃度提示确认这是预期行为。研究和规划代理通常需要 1–5 分钟；验证代理在大型阶段中可能需要更长时间。

不要中断会话。终止它会丢弃进行中的子代理工作。

如果已超过 10 分钟，请检查代理任务在 Claude Code 侧边栏中是否仍显示为活跃状态。

---

## 工作流状态问题

### 如果工作流似乎已损坏或状态不一致

```bash
/gsd-forensics
```

或附带描述：

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

`/gsd-forensics` 执行事后调查：git 历史异常、产物完整性、STATE.md 一致性、未提交的工作以及孤立的工作树。它将报告写入 `.planning/forensics/` 并给出推荐的补救步骤。该命令为只读，不会修改您的项目文件。

### 如果您需要回滚某个阶段或计划

```bash
/gsd-undo --phase 03          # 回滚阶段 3 的所有提交
/gsd-undo --plan 03-02        # 回滚阶段 3 中计划 02 的提交
/gsd-undo --last 5            # 从最近 5 个 GSD 提交中交互式选择
```

`/gsd-undo` 在回滚前检查依赖阶段，并始终显示确认步骤。

---

## 安装与更新问题

### 如果安装后 GSD 未被识别

重启您的运行时。GSD 将斜杠命令安装到您运行时的命令目录中（例如 `~/.claude/commands/gsd/`）。大多数运行时仅在启动时发现新命令。

如果问题仍然存在，请验证安装：

```bash
npx @opengsd/gsd-core@latest --claude --local
```

有关特定运行时的安装路径和排查说明，请参阅 [在您的运行时中安装](install-on-your-runtime.md)。

### 如果更新覆盖了您的本地更改

自 v1.17 起，安装程序将本地修改的文件备份到 `gsd-local-patches/`。重新应用您的更改：

```bash
/gsd-update --reapply
```

### 如果无法通过 npm 更新

如果 `npx @opengsd/gsd-core` 因 npm 故障或网络限制而失败，请参阅 `docs/manual-update.md` 了解无需 npm 访问即可完成更新的逐步手动更新流程。

有关常规更新，请参阅 [更新 GSD](update-gsd.md)。

---

## 成本问题

### 如果模型费用过高

切换到预算配置文件：

```bash
/gsd-config --profile budget
```

如果对该领域已很熟悉，请通过设置禁用研究和计划检查代理：

```bash
/gsd-settings
```

另外，请审核已启用的 MCP 服务器。每个已启用的 MCP 服务器都会在每个回合中将其工具架构注入。浏览器和平台特定工具每个可能消耗 20k+ 个令牌。在 `.claude/settings.json` 中禁用当前阶段不需要的服务器：

```json
{
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

---

## 恢复快速参考

| 问题 | 解决方案 |
|---------|---------|
| 上下文丢失或新会话 | `/gsd-resume-work` 或 `/gsd-progress` |
| 不知道下一步是什么 | `/gsd-progress --next` |
| 阶段出错 | `/gsd-undo --phase NN`，然后重新规划 |
| 某些内容损坏 | `/gsd-debug "description"`（添加 `--diagnose` 可仅分析而不修复） |
| STATE.md 不同步 | `state validate` 后 `state sync` |
| `.planning/` 完整性不确定 | `/gsd-health`，然后 `/gsd-health --repair` |
| 工作流状态似乎损坏 | `/gsd-forensics` |
| 快速针对性修复 | `/gsd-quick` |
| 计划与您的愿景不符 | `/gsd-discuss-phase N` 后重新规划 |
| 成本过高 | `/gsd-config --profile budget` 和 `/gsd-settings` 关闭代理 |
| 更新破坏了本地更改 | `/gsd-update --reapply` |
| 需要会话摘要 | `/gsd-pause-work --report` |
| 并行执行构建错误 | 更新 GSD 或设置 `parallelization.enabled: false` |

---

## 相关内容

- [调试失败的执行](debug-a-failed-execution.md)
- [在您的运行时中安装](install-on-your-runtime.md)
- [命令](../COMMANDS.md)
- [文档索引](../README.md)
