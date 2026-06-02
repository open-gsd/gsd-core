# 讨论模式：假设模式与访谈模式

GSD Core 的讨论阶段提供两种模式，用于在规划开始前收集实现上下文。了解何时使用哪种模式，有助于减少来回沟通，更快地生成确认后的 `CONTEXT.md`。

有关运行任一模式的分步说明，请参阅[讨论阶段使用指南](how-to/discuss-a-phase.md)。

## 模式

### `discuss`（默认）

原始访谈式流程。Claude 识别阶段中的模糊区域，呈现供选择，然后针对每个区域提出大约四个问题。适用于：

- 代码库较新的早期阶段
- 用户有强烈意见希望主动表达的阶段
- 偏好有引导的对话式上下文收集的用户

### `assumptions`

以代码库为中心的流程。Claude 通过子代理深度分析代码库（读取 5–15 个相关文件），形成带有证据的假设，并呈现供确认或纠正。适用于：

- 具有清晰规范的成熟代码库
- 觉得访谈问题显而易见的用户
- 更快的上下文收集（约 2–4 次交互，而非约 15–20 次）

## 配置

```bash
# 启用假设模式
node gsd-tools.cjs config-set workflow.discuss_mode assumptions

# 切换回访谈模式
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

该设置为每个项目独立存储（保存于 `.planning/config.json`）。有关两种模式所生成文件的完整结构，请参阅 [CONTEXT.md 结构说明](reference/context-md.md)。

## 假设模式的工作原理

1. **初始化** — 与讨论模式相同（加载先前上下文、探查代码库、检查待办事项）
2. **深度分析** — 探索子代理读取与阶段相关的 5–15 个代码库文件
3. **呈现假设** — 每条假设包含：
   - Claude 将做什么以及原因（引用文件路径）
   - 若假设不正确会出现什么问题
   - 置信度（确信 / 可能 / 不明确）
4. **确认或纠正** — 用户审查假设，选择需要修改的条目
5. **写入 CONTEXT.md** — 与讨论模式输出格式完全相同

## 标志兼容性

| 标志 | `discuss` 模式 | `assumptions` 模式 |
|------|----------------|-------------------|
| `--auto` | 自动选择推荐答案 | 跳过确认步骤，自动解决"不明确"项 |
| `--batch` | 将问题分批分组 | 不适用（纠正已批量处理） |
| `--text` | 纯文本问题（远程会话） | 纯文本问题（远程会话） |
| `--analyze` | 每个问题显示权衡表 | 不适用（假设已包含证据） |

## 输出

两种模式均生成包含相同六个章节的 `CONTEXT.md`：

- `<domain>` — 阶段边界
- `<decisions>` — 已锁定的实现决策
- `<canonical_refs>` — 下游代理必须阅读的规范/文档
- `<code_context>` — 可复用资产、规范、集成点
- `<specifics>` — 用户参考和偏好
- `<deferred>` — 记录供未来阶段使用的想法

下游代理（researcher、planner、checker）以相同方式使用此文件，无论由哪种模式生成。有关完整字段参考，请参阅 [CONTEXT.md 结构说明](reference/context-md.md)。

## 相关资源

- [讨论阶段](how-to/discuss-a-phase.md) — 运行 `/gsd-discuss-phase` 的分步指南（支持两种模式）。
- [CONTEXT.md 结构说明](reference/context-md.md) — 两种模式所生成文件的完整字段参考。
- [阶段循环](explanation/the-phase-loop.md) — 讨论如何融入更广泛的 讨论 → 规划 → 执行 → 验证 → 发布 循环。
- [文档索引](README.md) — GSD Core 文档的完整目录。
