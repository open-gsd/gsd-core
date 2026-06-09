# 模型配置

模型配置控制每個 GSD 代理使用哪個 Claude 模型。這允許平衡品質和 token 消耗。

## 配置定義

| 代理 | `quality` | `balanced` | `budget` |
|-------|-----------|------------|----------|
| gsd-planner | opus | opus | sonnet |
| gsd-roadmapper | opus | sonnet | sonnet |
| gsd-executor | opus | sonnet | sonnet |
| gsd-phase-researcher | opus | sonnet | haiku |
| gsd-project-researcher | opus | sonnet | haiku |
| gsd-research-synthesizer | sonnet | sonnet | haiku |
| gsd-debugger | opus | sonnet | sonnet |
| gsd-codebase-mapper | sonnet | haiku | haiku |
| gsd-verifier | sonnet | sonnet | haiku |
| gsd-plan-checker | sonnet | sonnet | haiku |
| gsd-integration-checker | sonnet | sonnet | haiku |
| gsd-nyquist-auditor | sonnet | sonnet | haiku |

## 配置理念

**quality** - 最大推理能力
- 所有決策代理使用 Opus
- 只讀驗證使用 Sonnet
- 適用場景：有配額可用、關鍵架構工作

**balanced**（預設）- 智慧分配
- 僅規劃（架構決策發生的地方）使用 Opus
- 執行和研究使用 Sonnet（遵循明確指令）
- 驗證使用 Sonnet（需要推理，不僅僅是模式匹配）
- 適用場景：正常開發、品質與成本的良好平衡

**budget** - 最小化 Opus 使用
- 編寫程式碼的使用 Sonnet
- 研究和驗證使用 Haiku
- 適用場景：節省配額、大量工作、不太關鍵的階段

## 解析邏輯

編排器在生成代理前解析模型：

```
1. 讀取 .planning/config.json
2. 檢查 model_overrides 是否有代理特定覆蓋
3. 如果沒有覆蓋，在配置表中查詢代理
4. 將 model 引數傳遞給 Task 呼叫
```

## 單代理覆蓋

覆蓋特定代理而不更改整個配置：

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-planner": "haiku"
  }
}
```

覆蓋優先於配置。有效值：`opus`、`sonnet`、`haiku`。

## 切換配置

在 `.planning/config.json` 中設定 `model_profile` 鍵以更改配置檔案。

專案預設值：在 `.planning/config.json` 中設定：
```json
{
  "model_profile": "balanced"
}
```

## 設計理由

**為什麼 gsd-planner 使用 Opus？**
規劃涉及架構決策、目標分解和任務設計。這是模型品質影響最大的地方。

**為什麼 gsd-executor 使用 Sonnet？**
執行者遵循明確的 PLAN.md 指令。計劃已包含推理；執行只是實現。

**為什麼 balanced 中驗證器使用 Sonnet（而非 Haiku）？**
驗證需要目標回溯推理 —— 檢查程式碼是否**交付**了階段承諾的內容，而不僅僅是模式匹配。Sonnet 處理得很好；Haiku 可能會遺漏細微的差距。

**為什麼 gsd-codebase-mapper 使用 Haiku？**
只讀探索和模式提取。不需要推理，只需從檔案內容輸出結構化結果。

**為什麼用 `inherit` 而不是直接傳遞 `opus`？**
Claude Code 的 `"opus"` 別名對映到特定模型版本。組織可能阻止舊版 opus 而允許新版。GSD 為 opus 級代理返回 `"inherit"`，使其使用使用者在會話中配置的任何 opus 版本。這避免了版本衝突和靜默回退到 Sonnet。