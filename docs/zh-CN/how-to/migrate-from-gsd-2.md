# 如何从 GSD-2 迁移

**目标：** 将较旧的 GSD-2 项目（`.gsd/` 目录布局）升级迁移到 GSD Core（`.planning/` 布局），并可选择将项目仓库中已有的 ADR、PRD 或规范文档纳入新的规划结构。

**前提条件：** GSD Core 已安装。GSD-2 项目目录在磁盘上可访问。

---

## 了解迁移内容

GSD-2 使用 `.gsd/` 目录作为规划根目录，GSD Core 使用 `.planning/`。迁移过程读取 `.gsd/` 中的工件，并将其写入所有 GSD Core 命令所期望的标准 `.planning/` 结构中。

| GSD-2 中的现有内容 | `/gsd-import --from-gsd2` 产生的内容 |
|----------------------|-----------------------------------------|
| `.gsd/PROJECT.md` | `.planning/PROJECT.md` |
| `.gsd/ROADMAP.md` | `.planning/ROADMAP.md` |
| `.gsd/STATE.md` | `.planning/STATE.md` |
| `.gsd/phases/` 目录 | `.planning/phases/` 目录 |
| 阶段 `PLAN.md` 文件 | GSD Core `{NN}-{MM}-PLAN.md` 文件（强制重命名） |

冲突检测会在写入任何文件之前运行。如果目标目录中已存在 `PROJECT.md` 且导入内容与之矛盾，迁移将在 BLOCKER 门控处停止，并列出需要您解决的冲突。

---

## 执行迁移

### 迁移当前目录

```bash
/gsd-import --from-gsd2
```

GSD 读取当前工作目录下的 `.gsd/`，并将迁移后的工件写入 `.planning/`。

### 从其他路径迁移

```bash
/gsd-import --from-gsd2 --path ~/projects/old-project
```

当 GSD-2 项目不在当前工作目录时，使用 `--path` 指定路径。

---

## 解决冲突

如果冲突检测发现阻断项——例如，GSD-2 的技术栈声明与现有的 `.planning/PROJECT.md` 相矛盾——它会打印冲突报告并停止，不写入任何文件。

阅读报告，解决矛盾（编辑源文档或现有规划工件），然后重新运行 `/gsd-import --from-gsd2`。迁移可以安全地重复运行，直至顺利通过。

---

## 导入外部计划文件

如果您拥有的是独立的计划文档（团队规划文档、Markdown 规范、导出的任务列表），而非完整的 GSD-2 项目，请使用 `--from` 代替：

```bash
/gsd-import --from /tmp/team-plan.md
```

GSD 执行相同的冲突检测流程，将内容转换为 GSD Core `PLAN.md` 格式，并使用计划检查器验证结果。验证完成后，您将看到目标文件名和后续步骤。

---

## 吸收现有文档

如果您的仓库中已包含 ADR（架构决策记录）、PRD 或规范文档，可在迁移完成后使用 `/gsd-ingest-docs` 将其合并到 `.planning/` 结构中：

### 扫描整个仓库（自动检测模式）

```bash
/gsd-ingest-docs
```

如果 `.planning/` 已经存在（例如，刚完成迁移后），GSD 默认使用合并模式——将导入的文档与已有内容并行合并，而非覆盖。

### 限定到特定目录

```bash
/gsd-ingest-docs docs/
/gsd-ingest-docs docs/adr/
```

### 使用显式优先级清单

当文档类型混合，或您希望控制冲突时哪份文档优先：

```bash
/gsd-ingest-docs --manifest ingest.yaml
```

清单是一个 YAML 文件，每个文档列出 `{path, type, precedence?}`。请参阅 [Commands](../COMMANDS.md) 中 `--manifest` 标志说明，了解其期望的结构。

### 强制指定模式

```bash
/gsd-ingest-docs --mode merge     # 合并到现有 .planning/
/gsd-ingest-docs --mode new       # 从零开始引导（覆盖）
```

**输出：** `/gsd-ingest-docs` 始终生成一个 `INGEST-CONFLICTS.md`，其中包含三个类别——自动解决、竞争变体和未解决的阻断项。每次导入运行后请审查此文件。仅在 LOCKED 与 LOCKED 的 ADR 矛盾时才会硬停止；其他所有情况均会呈现供您审查，而不会被静默丢弃。

---

## 验证迁移后的项目

迁移及文档导入完成后，确认项目状态的一致性：

```bash
/gsd-health
/gsd-health --repair
```

`/gsd-health` 检查 `.planning/` 目录的完整性并报告任何偏差。`--repair` 会自动修复可恢复的问题。

然后检查 GSD Core 是否能够读取您的项目状态：

```bash
/gsd-progress
```

如果项目迁移顺利，您将看到当前阶段状态和推荐的下一步操作。从此处起，适用标准 GSD Core 工作流程。

---

## 条件说明：什么能迁移，什么不能

| 情形 | 处理方式 |
|-----------|-----------|
| 当前目录中存在 `.gsd/` | 运行 `/gsd-import --from-gsd2`（无需 `--path`） |
| `.gsd/` 在其他目录 | 使用 `--path ~/projects/old-project` |
| 您有独立的计划文档，而非完整的 GSD-2 项目 | 使用 `/gsd-import --from /path/to/plan.md` |
| 您在 `docs/adr/` 中有 ADR | 迁移后运行 `/gsd-ingest-docs docs/adr/` |
| 您有 ADR、PRD 和规范的混合文档 | 在仓库根目录运行 `/gsd-ingest-docs`，它会自动分类 |
| 冲突检测报告阻断项 | 解决列出的矛盾后重新运行；在所有阻断项清除前不会写入任何文件 |
| 您不确定迁移是否成功 | 运行 `/gsd-health` 和 `/gsd-progress` 进行确认 |
| INGEST-CONFLICTS.md 列出未解决的阻断项 | 这些需要手动解决，相关文档才能被纳入规划 |

---

## 相关内容

- [您的第一个项目](../tutorials/your-first-project.md)
- [Commands](../COMMANDS.md)
- [文档索引](../README.md)
