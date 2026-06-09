# 模型配置解析

在編排開始時解析一次模型配置，然後在所有 Task 生成時使用。

## 解析模式

```bash
MODEL_PROFILE=$(cat .planning/config.json 2>/dev/null | grep -o '"model_profile"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"' || echo "balanced")
```

預設值：未設定或缺少 config 時為 `balanced`。

## 查詢表

@~/.claude/get-shit-done/references/model-profiles.md

在表中查詢已解析配置對應的代理。將 model 引數傳遞給 Task 呼叫：

```
Task(
  prompt="...",
  subagent_type="gsd-planner",
  model="{resolved_model}"  # "inherit"、"sonnet" 或 "haiku"
)
```

**注意：** Opus 級代理解析為 `"inherit"`（而非 `"opus"`）。這會使代理使用父會話的模型，避免與可能阻止特定 opus 版本的組織策略衝突。

## 使用方法

1. 在編排開始時解析一次
2. 儲存 profile 值
3. 生成時在表中查詢每個代理的模型
4. 將 model 引數傳遞給每個 Task 呼叫（值：`"inherit"`、`"sonnet"`、`"haiku"`）