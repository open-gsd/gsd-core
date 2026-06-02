# 如何设置跨 AI 评审

**目标：** 配置参与计划评审的 AI 评审者，对已规划的阶段运行评审，并利用反馈收敛出无 HIGH 级别问题的计划。

**前提条件：** 该阶段已完成规划（`.planning/phases/` 目录中存在 `{phase}-PLAN.md` 文件），且至少安装并认证了一个外部 AI CLI。

---

## 决定使用哪些评审者

GSD Core 可将评审请求路由至以下任意组合：Gemini CLI、Claude（独立会话）、Codex CLI、CodeRabbit、OpenCode、Qwen Code、Cursor、Antigravity CLI、Ollama、LM Studio 以及 llama.cpp。

每位评审者会独立地对您的 `PLAN.md` 文件执行相同的结构化提示。由于不同模型存在不同的盲区，多评审者共识能比任何单一评审者发现更多问题。

**如果您尚未安装任何外部 CLI**，请至少安装一个：

```bash
# Gemini CLI（使用 Google 凭据免费使用）
npm install -g @google/gemini-cli

# Antigravity CLI（使用 Google 凭据免费使用）
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Codex CLI
npm install -g @openai/codex
```

---

## 设置默认评审者（可选）

默认情况下，`/gsd-review` 会运行所有检测到的 CLI。若要将特定子集固定为项目默认值：

```bash
/gsd-config --integrations
```

集成向导涵盖 API 密钥、代码评审 CLI 路由以及 `review.default_reviewers` 列表。将该列表设置为您希望作为无标志默认值的评审者——例如 `["gemini","codex"]`。

或者，也可通过 `gsd-tools` 直接设置：

```bash
gsd config-set review.default_reviewers '["gemini","codex"]'
```

完整的集成设置架构（API 密钥、每个评审者的模型覆盖、本地服务器主机地址）请参阅[配置](../CONFIGURATION.md)。

---

## 运行评审

### 标准评审（使用已配置的默认值或所有检测到的 CLI）

```bash
/gsd-review --phase 3
```

GSD 会依次调用每位评审者，收集结构化反馈（摘要、优点、HIGH/MEDIUM/LOW 级别问题、建议、风险评估），并将合并后的输出写入 `.planning/phases/03-.../03-REVIEWS.md`。

### 为一次性运行选择单个评审者

```bash
/gsd-review --phase 3 --gemini
/gsd-review --phase 3 --codex
/gsd-review --phase 3 --cursor
```

任何显式标志都会覆盖该次运行的 `--all` 默认值和 `review.default_reviewers`。

### 并行运行所有可用评审者

```bash
/gsd-review --phase 3 --all
```

`--all` 始终覆盖配置，运行完整的检测集合，包括任何已配置的本地模型服务器（Ollama、LM Studio、llama.cpp）。

### 本地模型服务器评审者

如果您在本地运行 Ollama 或 LM Studio，当服务器可达时，使用 `--all` 会自动将其包含在内。您也可以显式指定：

```bash
/gsd-review --phase 3 --ollama
/gsd-review --phase 3 --lm-studio
```

如果默认值（`localhost:11434` / `localhost:1234`）不适用，请通过 `/gsd-config --integrations` 在 `review.*` 键下配置主机地址和模型选择。

---

## 读取评审输出

`{padded_phase}-REVIEWS.md` 文件包含：

- 每位评审者的独立评审，附带按严重程度分类的问题
- **共识摘要**部分，综合了两位或更多评审者提出的问题——从此处开始获取最高优先级信号
- **分歧观点**部分，记录评审者意见不一致的领域

---

## 将反馈纳入计划

查看输出后，结合反馈重新规划：

```bash
/gsd-plan-phase 3 --reviews
```

规划器会读取 `REVIEWS.md`，并在保存前调整计划以解决相关问题。

---

## 自动化计划-评审-重规划循环

对于希望迭代直至所有 HIGH 级别问题解决的阶段，请使用收敛循环：

```bash
/gsd-plan-review-convergence 3
```

此命令运行 `plan-phase → review → replan → re-review`，最多循环三次（默认）。当 HIGH 级别问题数量降至零时，循环退出。

### 使用特定评审者进行收敛

```bash
/gsd-plan-review-convergence 3 --codex
/gsd-plan-review-convergence 3 --gemini
```

### 使用所有评审者并提高循环上限进行收敛

```bash
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

**停滞检测：** 如果 HIGH 级别问题数量在各轮次间未减少，GSD 会向您发出警告。当循环上限已达但仍存在未解决的 HIGH 级别问题时，升级门控会询问是否继续或手动审查。

---

## 条件判断：选择哪些评审者

| 场景 | 推荐方式 |
|-----------|---------------------|
| 已安装 Gemini CLI | `--gemini` 始终是良好的起始评审者 |
| 希望免费多评审者覆盖 | `--gemini` + `--agy`（两者均使用 Google 凭据） |
| 项目以 OpenAI 为主 | 添加 `--codex` 以获取 OpenAI 模型视角 |
| 希望使用 GitHub Copilot 的模型 | 添加 `--opencode` |
| 希望完全避免 API 费用 | 使用本地模型配置 Ollama 并使用 `--ollama` |
| 发布前需要最大覆盖率 | `/gsd-plan-review-convergence N --all` |
| 快速迭代并希望获得快速反馈 | 选择一个 CLI：`/gsd-review --phase N --gemini` |

---

## 相关内容

- [验证并发布](verify-and-ship.md)
- [配置](../CONFIGURATION.md)
- [命令](../COMMANDS.md)
- [文档索引](../README.md)
