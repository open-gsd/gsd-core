# 规划产物参考

`.planning/` 目录是 GSD Core 项目的共享记忆。所有工作流都会读取和写入该目录，并留下可审计的决策记录。本页列出每个文件、其用途，以及哪些命令负责生成或消费它。参见[文档索引](../README.md)。

---

## 目录结构

```
.planning/
├── PROJECT.md                          # 项目标识与核心价值
├── ROADMAP.md                          # 里程碑 + 阶段列表及目标
├── REQUIREMENTS.md                     # 编号化验收标准
├── STATE.md                            # 实时进度跟踪器
├── config.json                         # 工作流与模型配置
├── MILESTONES.md                       # 里程碑归档（可选）
├── BACKLOG.md                          # 延期与未来工作（可选）
├── LEARNINGS.md                        # 跨阶段积累的经验（可选）
├── DECISIONS-INDEX.md                  # 历史决策滚动摘要（可选）
├── METHODOLOGY.md                      # 可复用的解释框架（可选）
├── HANDOFF.json                        # 机器可读的暂停状态（临时文件）
├── codebase/                           # 代码库映射（可选）
│   ├── architecture.md
│   ├── stack.md
│   └── ...
├── intel/                              # 可查询的符号索引（可选，intel.enabled）
│   └── API-SURFACE.md
└── phases/
    └── <NN>-<slug>/                    # 每个阶段一个目录
        ├── <NN>-CONTEXT.md             # 实现决策（discuss-phase）
        ├── <NN>-DISCUSSION-LOG.md      # 人类可读的讨论审计（discuss-phase）
        ├── <NN>-RESEARCH.md            # 技术研究结果（plan-phase）
        ├── <NN>-VALIDATION.md          # Nyquist 测试覆盖策略（plan-phase）
        ├── <NN>-PATTERNS.md            # 代码库类比映射（plan-phase，可选）
        ├── <NN>-<PP>-PLAN.md           # 可执行计划（plan-phase，每个计划一个）
        ├── <NN>-<PP>-SUMMARY.md        # 执行记录（execute-phase，每个计划一个）
        ├── <NN>-VERIFICATION.md        # 阶段目标验证报告（verify-phase）
        ├── <NN>-UAT.md                 # 持久化 UAT 会话状态（execute-phase）
        └── .continue-here.md           # 暂停后的恢复说明（pause-work）
```

---

## 根级产物

### `PROJECT.md`

| | |
|---|---|
| **用途** | 规范的项目标识：项目内容、目标用户、核心价值、需求、约束和关键决策。随项目演进持续更新。 |
| **生成者** | `/gsd-new-project`（初始创建）；由 `/gsd-complete-milestone` 在决策验证后更新。 |
| **消费者** | 所有规划工作流；`gsd-phase-researcher`、`gsd-planner`（上下文）；`discuss-phase`（历史决策）；`gsd-plan-checker`（项目约束）。 |

### `ROADMAP.md`

| | |
|---|---|
| **用途** | 里程碑与阶段列表，含目标、需求 ID、成功标准以及每个阶段的规范参考。是项目构建内容和顺序的唯一可信来源。 |
| **生成者** | `/gsd-new-project`（初始创建）；由 `/gsd-phase --insert` 和 `/gsd-complete-milestone` 更新。 |
| **消费者** | `/gsd-discuss-phase`、`/gsd-plan-phase`、`/gsd-execute-phase`；所有需要阶段信息的编排命令；`gsd-planner`、`gsd-plan-checker`、`gsd-phase-researcher`。 |

### `REQUIREMENTS.md`

| | |
|---|---|
| **用途** | 编号化、可勾选的项目验收标准。每条需求带有 ID（如 `AUTH-01`），映射到路线图阶段。随着阶段执行，逐步标记需求为已完成。 |
| **生成者** | `/gsd-new-project`（初始创建）；需求由 `execute-phase` 标记为已完成。 |
| **消费者** | `gsd-planner`（计划必须覆盖所有阶段需求 ID）；`gsd-plan-checker` 维度 1（需求覆盖）；`discuss-phase`（历史需求）。 |

### `STATE.md`

| | |
|---|---|
| **用途** | 实时进度跟踪器——当前阶段与计划、进度指标、积累的决策、会话连续性说明。每次工作流运行时首先读取，每次重要操作后更新。 |
| **生成者** | `/gsd-new-project`（初始创建）；由所有阶段工作流、`/gsd-pause-work`、`/gsd-resume-work` 持续更新。 |
| **消费者** | 所有编排工作流；`/gsd-progress`；通过 `/gsd-quick` 执行的临时任务；`gsd-planner` 和 `gsd-phase-researcher`（项目决策）。 |

完整字段参考请参见 [STATE.md 模式](state-md.md)。

### `config.json`

| | |
|---|---|
| **用途** | 工作流配置：模型配置文件、研究与计划检查器开关、Git 分支策略、Nyquist 验证、并行化设置，以及每个代理的模型覆盖。 |
| **生成者** | `/gsd-new-project`（初始创建）；`/gsd-settings`（交互式编辑）。 |
| **消费者** | 每个工作流和子代理——在初始化时通过 `gsd-tools query config-get` 读取。 |

完整模式请参见 [CONFIGURATION](../CONFIGURATION.md)。

### `MILESTONES.md`（可选）

| | |
|---|---|
| **用途** | 已完成里程碑的历史记录。每个里程碑关闭时填充；提供已交付内容及时间的存档快照。 |
| **生成者** | `/gsd-complete-milestone`。 |
| **消费者** | `/gsd-audit-milestone`；人工审查。 |

### `DECISIONS-INDEX.md`（可选）

| | |
|---|---|
| **用途** | 先前阶段 CONTEXT.md 文件中捕获的决策的有界滚动摘要。存在时，`discuss-phase` 读取此单一文件，而不是逐一读取最多三个先前的 CONTEXT.md 文件，从而节省上下文预算。 |
| **生成者** | 当先前阶段数量超过滚动读取阈值时生成。 |
| **消费者** | `discuss-phase`（`load_prior_context` 步骤）。 |

### `HANDOFF.json`（临时文件）

| | |
|---|---|
| **用途** | 工作中断时写入的机器可读暂停状态。包含恢复点、进行中的上下文以及继续说明。恰好消费一次——在恢复时。 |
| **生成者** | `/gsd-pause-work`。 |
| **消费者** | `/gsd-resume-work`。 |

---

## 每阶段产物

所有每阶段文件均位于 `.planning/phases/<NN>-<slug>/` 下，其中 `NN` 是补零的阶段编号，`slug` 是用连字符连接的阶段名称。

### `<NN>-CONTEXT.md`

| | |
|---|---|
| **用途** | 规划开始前捕获的实现决策。包含阶段边界（`<domain>`）、带有 `D-NN` 标识符的锁定决策（`<decisions>`）、规范文档参考（`<canonical_refs>`）、现有代码洞察（`<code_context>`）、具体灵感（`<specifics>`）以及推迟的想法（`<deferred>`）。 |
| **生成者** | `/gsd-discuss-phase`（交互式讨论或 PRD/ADR 快速路径）。 |
| **消费者** | `gsd-phase-researcher`（待调查内容）；`gsd-planner`（锁定决策）；`gsd-plan-checker` 维度 7（上下文合规性）。 |

完整字段参考请参见 [CONTEXT.md 模式](context-md.md)。

### `<NN>-DISCUSSION-LOG.md`

| | |
|---|---|
| **用途** | discuss-phase 会话的人类可读审计记录：讨论的领域、提出的选项、所做的选择、推迟的想法以及留给 Claude 自行决定的事项。不被自动化工作流消费。 |
| **生成者** | `/gsd-discuss-phase`（`git_commit` 步骤）。 |
| **消费者** | 人工审查；回顾总结。 |

### `<NN>-RESEARCH.md`

| | |
|---|---|
| **用途** | 规划前产生的技术研究结果。回答"为了很好地规划此阶段，我需要了解什么？"——涵盖领域分析、模式、风险、架构职责映射以及验证架构部分（由 Nyquist 门控使用）。 |
| **生成者** | `/gsd-plan-phase` 通过 `gsd-phase-researcher` 代理。 |
| **消费者** | `gsd-planner`（规划输入）；`gsd-plan-checker` 维度 7c（层级合规性）、维度 8（Nyquist）、维度 11（研究解决）；`gsd-pattern-mapper`（文件列表来源）。 |

### `<NN>-VALIDATION.md`

| | |
|---|---|
| **用途** | 源自 RESEARCH.md 中 `## Validation Architecture` 部分的 Nyquist 启发式验证策略。指定计划必须遵守的自动化测试覆盖要求。 |
| **生成者** | `/gsd-plan-phase`（步骤 5.5，当 `workflow.nyquist_validation` 已启用且 RESEARCH.md 包含验证架构部分时）。 |
| **消费者** | `gsd-plan-checker` 维度 8（检查 8e 门控——Nyquist 检查进行前必须存在）；`gsd-verifier`。 |

### `<NN>-PATTERNS.md`

| | |
|---|---|
| **用途** | 由 `gsd-pattern-mapper` 生成的代码库类比映射。针对本阶段每个待创建或修改的文件，识别最近似的现有类比，对文件的角色和数据流进行分类，并提取具体代码摘录。引导规划者采用一致的模式。 |
| **生成者** | `/gsd-plan-phase` 通过 `gsd-pattern-mapper` 代理（可选；如果 `workflow.pattern_mapper: false` 则跳过）。 |
| **消费者** | `gsd-planner`（模式指导）；`gsd-plan-checker` 维度 12（模式合规性）。 |

### `<NN>-<PP>-PLAN.md`

| | |
|---|---|
| **用途** | 阶段内单个工作单元的可执行计划。包含 YAML 前置内容（wave、dependencies、files、requirements、`must_haves`）、目标、上下文参考、带有 `<read_first>`、`<action>`、`<verify>` 和 `<acceptance_criteria>` 字段的 XML 结构化任务，以及验证标准。 |
| **生成者** | `/gsd-plan-phase` 通过 `gsd-planner` 代理。每个计划一个文件——例如，`03-02-PLAN.md` 是第 3 阶段第 2 个计划。 |
| **消费者** | `/gsd-execute-phase`（执行器代理读取计划并运行任务）；`gsd-plan-checker`（执行前质量审查）；`gsd-verifier`（读取 `must_haves` 进行执行后验证）。 |

完整字段参考请参见 [PLAN.md 模式](plan-md.md)。

### `<NN>-<PP>-SUMMARY.md`

| | |
|---|---|
| **用途** | 计划完成后写入的执行记录。记录已构建内容、与计划的偏差、对验收标准的自查，以及阶段的依赖关系图。 |
| **生成者** | `execute-phase` 执行器代理（在每个计划执行结束时写入）。 |
| **消费者** | `/gsd-progress`（阶段状态）；`gsd-planner`（当后续计划对先前计划输出存在真实依赖时）；`milestone-summary`。 |

### `<NN>-VERIFICATION.md`

| | |
|---|---|
| **用途** | 阶段目标验证报告。在执行完成后，对照实际代码库检查所有计划中的 `must_haves.truths`、`must_haves.artifacts` 和 `must_haves.key_links`。记录 `status: passed | gaps_found | human_needed`。 |
| **生成者** | `/gsd-verify-work`（或 `/gsd-execute-phase` 内的验证步骤）。 |
| **消费者** | `plan-phase` 已关闭阶段门控（`status: passed` 的 VERIFICATION.md 将阶段标记为 `Complete`，并在没有 `--force` 的情况下阻止重新规划）；`/gsd-progress`；人工审查。 |

### `<NN>-UAT.md`

| | |
|---|---|
| **用途** | 持久化的 UAT 会话跟踪。在实时 UAT 会话中记录每个测试用例、预期的可观察行为、结果以及开发者响应。带有 YAML 前置内容（`status`、`phase`、`source`、时间戳）。 |
| **生成者** | `/gsd-audit-uat`（交互式 UAT 会话）。 |
| **消费者** | `/gsd-audit-uat`（恢复先前的 UAT 会话）。 |

### `.continue-here.md`

| | |
|---|---|
| **用途** | 阶段工作暂停时写入的人类可读恢复说明。包含供恢复代理使用的上下文：关键反模式、阻塞问题、必读内容以及恢复的确切命令。 |
| **生成者** | `/gsd-pause-work`。 |
| **消费者** | 任何在阶段上启动的工作流——`discuss-phase` 和 `plan-phase` 在入口处均检查此文件，并要求代理在继续之前证明其理解了所有 `blocking` 反模式。 |

---

## 命名约定

| 片段 | 格式 | 示例 |
|---|---|---|
| 阶段目录 | `<NN>-<slug>` | `03-post-feed` |
| 阶段级文件 | `<NN>-<ARTIFACT>.md` | `03-CONTEXT.md` |
| 计划级文件 | `<NN>-<PP>-<ARTIFACT>.md` | `03-02-PLAN.md` |
| `NN` | 补零的阶段编号 | `03` 表示第 3 阶段 |
| `PP` | 阶段内补零的计划编号 | `02` 表示第 2 个计划 |

当 `config.json` 中设置了 `project_code` 时，阶段目录使用项目代码作为前缀：对于项目代码 `CK`、第 3 阶段，目录为 `CK-03-post-feed`。

---

## 相关内容

- [STATE.md 模式](state-md.md)
- [CONTEXT.md 模式](context-md.md)
- [PLAN.md 模式](plan-md.md)
- [文档索引](../README.md)
