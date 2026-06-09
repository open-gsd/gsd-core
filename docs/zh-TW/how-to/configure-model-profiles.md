# 如何配置模型配置檔案

為您的專案選擇合適的模型層級策略，然後在不編寫大型覆蓋塊的情況下調整單個代理或整個階段型別。本指南從最簡單的控制選項開始，逐步介紹到動態路由。

---

## 四種配置檔案（以及 `adaptive` 和 `inherit`）

在 `.planning/config.json` 中設定 `model_profile`，或通過 `/gsd-config --profile <name>` 設定：

| 配置檔案 | 規劃器 | 執行器 | 研究員 | 驗證器 | 適用場景 |
|---------|---------|----------|-------------|----------|----------|
| `quality` | Opus | Opus | Opus | Sonnet | 對成本要求較低、注重生產品質的工作 |
| `balanced` | Opus | Sonnet | Sonnet | Sonnet | 常規開發——預設選項 |
| `budget` | Sonnet | Sonnet | Haiku | Haiku | 快速原型開發、成本敏感場景 |
| `adaptive` | Opus | Sonnet | Sonnet | Sonnet | 與其他層級在執行時感知配置檔案下的解析方式相同；在頻繁切換執行時環境時使用 |
| `inherit` | （會話模型） | （會話模型） | （會話模型） | （會話模型） | 非 Anthropic 提供商（OpenRouter、本地模型）——所有代理遵循當前會話模型 |

上表展示的是代表性子集。全部 33 個內建代理在 `sdk/shared/model-catalog.json` 中均有明確的按配置檔案層級分配。完整表格請參閱配置參考中的 [模型配置檔案](../CONFIGURATION.md#model-profiles)。

**通過命令快速切換：**

```bash
/gsd-config --profile balanced   # Normal development
/gsd-config --profile budget     # Prototyping or high-cost phases
/gsd-config --profile quality    # Production release
/gsd-config --profile inherit    # OpenRouter, local models
```

**或直接編輯 `.planning/config.json`：**

```json
{
  "model_profile": "balanced"
}
```

---

## 按代理覆蓋（`model_overrides`）

如果某個代理需要不同的層級而不想更改整個配置檔案，請使用 `model_overrides`：

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-codebase-mapper": "haiku"
  }
}
```

有效值：`opus`、`sonnet`、`haiku`、`inherit`，或任何完全限定的模型 ID（例如 `"openai/o3"`、`"google/gemini-2.5-pro"`）。

`model_overrides` 可在 `.planning/config.json` 中按專案設定，也可在 `~/.gsd/defaults.json` 中全域性設定。專案級條目在衝突時優先；不衝突的全域性條目會被保留。

**關於 Codex 和 OpenCode 的重要說明：** 這些執行時會在安裝時將解析後的模型嵌入每個代理的靜態配置中。編輯 `model_overrides` 後，需重新執行安裝程式使更改生效：

```bash
npx @opengsd/gsd-core@latest --codex --global   # or --opencode, --kilo, etc.
```

---

## 按階段型別設定模型（`models`）

如果您希望在不學習全部 33 個代理名稱的情況下實現"規劃階段用 Opus、其餘用 Sonnet"的效果，請使用 `models` 塊。它將六種階段型別對映到層級別名：

```json
{
  "model_profile": "balanced",
  "models": {
    "planning":      "opus",
    "discuss":       "opus",
    "research":      "sonnet",
    "execution":     "opus",
    "verification":  "sonnet",
    "completion":    "sonnet"
  }
}
```

階段型別及其對應的代理：

| 階段型別 | 涵蓋的代理 |
|---|---|
| `planning` | `gsd-planner`、`gsd-roadmapper`、`gsd-pattern-mapper` |
| `research` | `gsd-phase-researcher`、`gsd-project-researcher`、`gsd-research-synthesizer`、`gsd-codebase-mapper`、`gsd-ui-researcher` |
| `execution` | `gsd-executor`、`gsd-debugger`、`gsd-doc-writer` |
| `verification` | `gsd-verifier`、`gsd-plan-checker`、`gsd-integration-checker`、`gsd-nyquist-auditor`、`gsd-ui-checker`、`gsd-ui-auditor`、`gsd-doc-verifier` |
| `discuss`、`completion` | 保留——目前無子代理；已被模式接受以備向後相容 |

`models` 塊僅接受層級別名（`opus`、`sonnet`、`haiku`、`inherit`）。如需使用完全限定的模型 ID，請改用按代理設定的 `model_overrides`。

**將 `models` 與按代理例外結合使用：**

```json
{
  "model_profile": "balanced",
  "models": {
    "research": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

全部五個研究代理解析為 `sonnet`，*除* `gsd-codebase-mapper` 被固定為 `haiku` 之外。

---

## 動態路由——預設使用低成本層級，失敗時升級

如果您希望預設使用較低成本的層級，僅在代理未通過品質門控時才升級，請啟用 `dynamic_routing`：

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "light":    "haiku",
      "standard": "sonnet",
      "heavy":    "opus"
    },
    "escalate_on_failure": true,
    "max_escalations": 1
  }
}
```

每個代理都有一個預設層級（`light`、`standard` 或 `heavy`）。第一次嘗試時，GSD Core 選擇 `tier_models[default_tier]`。如果編排器檢測到軟失敗（驗證不確定、計劃檢查被標記等），則將代理提升一級重新啟動。`max_escalations` 限制總重試次數。

已處於 `heavy` 層級的代理無法進一步升級。

**在保留動態解析的同時關閉升級：**

```json
{
  "dynamic_routing": {
    "enabled": true,
    "escalate_on_failure": false
  }
}
```

無論結果如何，每次嘗試都使用 `tier_models[default_tier]`——適用於希望明確指定層級到模型的對映但不需要升級行為的場景。

`dynamic_routing` **預設停用**。省略該塊或設定 `enabled: false` 將保留靜態解析。

---

## 在非 Anthropic 執行時上使用 GSD Core

如果您為 Codex、OpenCode、Gemini CLI 或 Kilo 安裝了 GSD Core，安裝程式已在您的配置中設定了 `resolve_model_ids: "omit"`。這告知 GSD Core 跳過 Anthropic 模型 ID 解析，讓執行時選擇其自己的預設模型。基本情況下無需手動設定。

**如果您希望在 Codex 上使用分層模型：**

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

GSD Core 將每個層級別名解析為執行時層級對映中定義的 Codex 原生模型和推理力度。

**如果您希望在任意非 Claude 執行時上使用按代理模型 ID：**

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner":   "o3",
    "gsd-executor":  "o4-mini",
    "gsd-debugger":  "o3"
  }
}
```

有關完整的執行時感知配置檔案參考及 `model_policy` 介面（v1.42 中新增的提供商中立預設），請參閱[配置參考——模型配置檔案](../CONFIGURATION.md#model-profiles)。

---

## 解析優先順序（從高到低）

當多個層級同時適用時，解析器選取優先順序最高的條目：

```text
1. model_overrides[<agent>]           — per-agent; full IDs; targeted exception
2. dynamic_routing.tier_models[<tier>] — when enabled; escalates on soft failure
3. models[<phase_type>]               — coarse phase-level tier
4. model_profile (per-agent column)   — global tier strategy
5. Runtime default                    — when nothing else applies
```

---

## 選擇合適的控制選項

| 您的需求 | 使用 |
|---|---|
| 對所有代理採用統一的層級策略 | `model_profile` |
| 粗粒度的階段級調整（"規劃階段用 Opus"） | `models.<phase_type>` |
| 按代理精細控制（"強制程式碼庫對映器使用 Haiku"） | `model_overrides[<agent>]` |
| 為特定代理指定完全限定的模型 ID | `model_overrides[<agent>]: "openai/gpt-5"` |
| 預設低成本，僅在失敗時升級 | `dynamic_routing` |
| 所有代理遵循會話模型（非 Anthropic 提供商） | `model_profile: "inherit"` |

---

## 相關文件

- [配置參考](../CONFIGURATION.md)
- [多代理編排](../explanation/multi-agent-orchestration.md)
- [命令參考](../COMMANDS.md)
- [文件索引](../README.md)
