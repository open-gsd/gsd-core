# 上下文窗口监视器

一个后置工具钩子（Claude Code 中的 `PostToolUse`，Gemini CLI 中的 `AfterTool`），当上下文窗口使用率较高时向 Agent 发出警告。

## 问题背景

状态栏向**用户**展示上下文使用情况，但 **Agent** 本身并不感知上下文限制。当上下文剩余量不足时，Agent 会持续工作直至触及上限——可能在任务进行到一半、状态尚未保存时就被迫中断。

## 工作原理

1. 状态栏钩子将上下文指标写入 `/tmp/claude-ctx-{session_id}.json`
2. 每次工具调用结束后，上下文监视器读取这些指标
3. 当剩余上下文低于阈值时，以 `additionalContext` 的形式注入警告
4. Agent 在对话中接收到警告后即可采取相应措施

## 阈值

| 级别 | 剩余量 | Agent 行为 |
|-------|-----------|----------------|
| 正常 | > 35% | 无警告 |
| 警告 | <= 35% | 完成当前任务收尾，避免开启新的复杂工作 |
| 严重 | <= 25% | 立即停止，保存状态（`/gsd-pause-work`） |

## 防抖机制

为避免反复向 Agent 发送重复警告：
- 首次警告始终立即触发
- 后续警告需间隔 5 次工具调用才会再次触发
- 严重级别升级（WARNING -> CRITICAL）可绕过防抖机制

## 架构

```
Statusline Hook (gsd-statusline.js)
    | writes
    v
/tmp/claude-ctx-{session_id}.json
    ^ reads
    |
Context Monitor (gsd-context-monitor.js, PostToolUse/AfterTool)
    | injects
    v
additionalContext -> Agent sees warning
```

中间桥接文件是一个简单的 JSON 对象：

```json
{
  "session_id": "abc123",
  "remaining_percentage": 28.5,
  "used_pct": 71,
  "timestamp": 1708200000
}
```

## 与 GSD 的集成

GSD 的 `/gsd-pause-work` 命令用于保存执行状态。WARNING 消息建议使用该命令，CRITICAL 消息则要求立即保存状态。

## 配置

两个钩子均在执行 `npx @opengsd/gsd-core` 安装时自动注册——正常情况下无需手动操作。有关钩子配置详情、阈值覆盖以及手动注册示例，请参阅[配置文档](CONFIGURATION.md)。

简要参考：状态栏钩子在 `settings.json` 中注册为 `statusLine`；上下文监视器（`gsd-context-monitor.js`）注册为 `PostToolUse` 钩子（Gemini CLI 中为 `AfterTool`）。两项配置均使用运行安装程序时的 Node 可执行文件绝对路径。在 Windows PowerShell 中，需在带引号的可执行文件路径前添加 `&` 前缀。

## 安全性

- 钩子对所有操作进行 try/catch 包裹，出错时静默退出
- 不会阻塞工具执行——监视器出现故障不应影响 Agent 的工作流程
- 过期指标（超过 60 秒）将被忽略
- 缺失的桥接文件可被优雅处理（适用于子 Agent 及新会话）

---

## 相关文档

- [架构](ARCHITECTURE.md)
- [配置](CONFIGURATION.md)
- [文档索引](README.md)
