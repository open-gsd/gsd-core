# GSD 配置參考

`.planning/config.json` 的完整 schema 參考。有關設定嚮導和任務操作指南，請參閱[文件索引](README.md)。

> 完整配置 schema、工作流開關、模型配置檔案及 git 分支選項。有關功能背景，請參閱[功能參考](FEATURES.md)。

---

## 配置檔案

GSD 將專案設定儲存在 `.planning/config.json` 中。該檔案在 `/gsd-new-project` 時建立，通過 `/gsd-settings` 更新。

### 完整 Schema

```json
{
  "mode": "interactive",
  "granularity": "standard",
  "model_profile": "balanced",
  "model_overrides": {},
  "models": {},
  "dynamic_routing": null,
  "planning": {
    "commit_docs": true,
    "search_gitignored": false,
    "sub_repos": []
  },
  "context": null,
  "workflow": {
    "research": true,
    "plan_check": true,
    "verifier": true,
    "auto_advance": false,
    "nyquist_validation": true,
    "ui_phase": true,
    "ui_safety_gate": true,
    "ui_review": true,
    "node_repair": true,
    "node_repair_budget": 2,
    "research_before_questions": false,
    "discuss_mode": "discuss",
    "max_discuss_passes": 3,
    "skip_discuss": false,
    "human_verify_mode": "end-of-phase",
    "tdd_mode": false,
    "text_mode": false,
    "use_worktrees": true,
    "code_review": true,
    "code_review_depth": "standard",
    "plan_bounce": false,
    "plan_bounce_script": null,
    "plan_bounce_passes": 2,
    "plan_chunked": false,
    "code_review_command": null,
    "cross_ai_execution": false,
    "cross_ai_command": null,
    "cross_ai_timeout": 300,
    "security_enforcement": true,
    "security_asvs_level": 1,
    "security_block_on": "high",
    "post_planning_gaps": true,
    "build_command": null,
    "test_command": null
  },
  "code_quality": {
    "fallow": {
      "enabled": false,
      "scope": "phase",
      "profile": "standard",
      "mcp": false
    }
  },
  "ship": {
    "pr_body_sections": []
  },
  "hooks": {
    "context_warnings": true,
    "workflow_guard": false
  },
  "statusline": {
    "context_position": "end"
  },
  "review": {
    "default_reviewers": null,
    "models": {}
  },
  "parallelization": {
    "enabled": true,
    "plan_level": true,
    "task_level": false,
    "skip_checkpoints": true,
    "max_concurrent_agents": 3,
    "min_plans_for_parallel": 2
  },
  "git": {
    "branching_strategy": "none",
    "create_tag": true,
    "phase_branch_template": "gsd/phase-{phase}-{slug}",
    "milestone_branch_template": "gsd/{milestone}-{slug}",
    "quick_branch_template": null
  },
  "gates": {
    "confirm_project": true,
    "confirm_phases": true,
    "confirm_roadmap": true,
    "confirm_breakdown": true,
    "confirm_plan": true,
    "execute_next_plan": true,
    "issues_review": true,
    "confirm_transition": true
  },
  "safety": {
    "always_confirm_destructive": true,
    "always_confirm_external_services": true
  },
  "project_code": null,
  "agent_skills": {},
  "response_language": null,
  "features": {
    "thinking_partner": false,
    "global_learnings": false
  },
  "learnings": {
    "max_inject": 10
  },
  "intel": {
    "enabled": false
  },
  "claude_md_path": "./CLAUDE.md"
}
```

---

## 核心設定

| 設定 | 型別 | 可選值 | 預設值 | 描述 |
|---------|------|---------|---------|-------------|
| `mode` | enum | `interactive`, `yolo` | `interactive` | `yolo` 自動批准決策；`interactive` 在每個步驟進行確認 |
| `granularity` | enum | `coarse`, `standard`, `fine` | `standard` | 控制階段數量：`coarse`（3-5 個）、`standard`（5-8 個）、`fine`（8-12 個） |
| `model_profile` | enum | `quality`, `balanced`, `budget`, `adaptive`, `inherit` | `balanced` | 每個 agent 的模型層級（參見[模型配置檔案](#模型配置檔案)）。`adaptive` 根據 [#1713](https://github.com/open-gsd/gsd-core/issues/1713) / [#1806](https://github.com/open-gsd/gsd-core/issues/1806) 新增，在執行時感知的配置檔案下與其他層級以相同方式解析。 |
| `runtime` | string | `claude`, `codex` 或任意字串 | （無） | [執行時感知配置檔案解析](#執行時感知配置檔案-2517)的活躍執行時。設定後，配置檔案層級（opus/sonnet/haiku）解析為執行時原生模型 ID。目前僅 Codex 安裝路徑通過此解析器為每個 agent 生成模型 ID；其他執行時（`opencode`、`gemini`、`qwen`、`copilot` 等）在 spawn 時消費該解析器，並在 [#2612](https://github.com/open-gsd/gsd-core/issues/2612) 中獲得專用安裝路徑支援。未設定時（預設），行為與之前版本相同。v1.39 新增 |
| `model_profile_overrides.<runtime>.<tier>` | string \| object | 按執行時的層級覆蓋 | （無） | 覆蓋特定 `(runtime, tier)` 的執行時感知層級對映。層級為 `opus`、`sonnet`、`haiku` 之一。值為模型 ID 字串（如 `"gpt-5-pro"`）或 `{ model, reasoning_effort }`。參見[執行時感知配置檔案](#執行時感知配置檔案-2517)。v1.39 新增 |
| `model_policy.provider` | string | `openai`, `anthropic`, `google`, `qwen`, `generic` | （無） | 宣告模型提供商。已知提供商（`openai`、`anthropic`、`google`、`qwen`）啟用基於目錄的預設。`generic` 將所有模型 ID 視為不透明字串——無字首推斷，無推理努力預設值。`model_policy.runtime_tiers` 在舊版 `model_profile_overrides` 之前解析。參見[模型策略預設](#模型策略預設-model_policy--v142-新增)。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.budget` | enum | `high`, `medium`, `low` | （無） | 使用已知提供商時選擇預算層級。GSD 在解析時將匹配的目錄預設具體化為顯式層級對映。當 `provider` 為 `generic` 或 `custom` 時忽略。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.high` | string | 模型 ID | （無） | `generic`/`custom` 提供商的高成本層級模型 ID。當 `provider: "generic"` 或 `"custom"` 時使用。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.medium` | string | 模型 ID | （無） | `generic`/`custom` 提供商的中等成本層級模型 ID。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.low` | string | 模型 ID | （無） | `generic`/`custom` 提供商的低成本層級模型 ID。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.runtime_tiers.<runtime>.<tier>` | object | `{ model, reasoning_effort? }` | （無） | 按執行時、按層級的顯式模型條目。`tier` 為 `opus`、`sonnet`、`haiku` 之一（與現有配置檔案層級名稱匹配）。`reasoning_effort` 僅轉發給支援它的執行時；不支援的執行時不會接收該欄位。優先順序高於 `model_profile_overrides`。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `models.<phase_type>` | enum | `opus`, `sonnet`, `haiku`, `inherit` | （無） | 按階段型別的模型層級。六個可接受的槽位：`planning`、`discuss`、`research`、`execution`、`verification`、`completion`。允許在階段級別調整（"規劃用 Opus，其餘用 Sonnet"），而無需瞭解 agent 名稱。解析優先順序在 `model_overrides`（更高）和 `model_profile`（更低）之間；參見[按階段型別的模型](#按階段型別的模型-models--v140-新增)。v1.40 新增（[#3023](https://github.com/open-gsd/gsd-core/pull/3030)） |
| `dynamic_routing.enabled` | boolean | `true`, `false` | `false` | [動態路由與失敗層級升級](#動態路由與失敗層級升級-dynamic_routing--v140-新增)的主開關。為 `true` 時，agent 解析為 `tier_models[default_tier]`，並在編排器檢測到軟性失敗時升級一個層級。v1.40 新增（[#3024](https://github.com/open-gsd/gsd-core/pull/3031)） |
| `dynamic_routing.tier_models.<tier>` | enum | `opus`, `sonnet`, `haiku` | （無） | `light`、`standard` 或 `heavy` 的層級別名。當 `dynamic_routing.enabled: true` 時使用。v1.40 新增 |
| `dynamic_routing.escalate_on_failure` | boolean | `true`, `false` | `true` | 為 `false` 時，即使 `enabled: true` 也停用升級——每次嘗試使用預設層級。v1.40 新增 |
| `dynamic_routing.max_escalations` | integer | `0`, `1`, `2`, … | `1` | 每次 agent 呼叫的硬性重試上限。超過上限後，解析器返回上限層級的模型。v1.40 新增 |
| `project_code` | string | 任意短字串 | （無） | 階段目錄名稱的字首（如 `"ABC"` 生成 `ABC-01-setup/`）。v1.31 新增 |
| `phase_id_convention` | enum | `"milestone-prefixed"`, `null` | `null` | 階段 ID 命名規範。`null` = 舊版數字 ID（`Phase 1`、`Phase 2`）。`"milestone-prefixed"` = 編碼所屬里程碑的全域性唯一 ID（`Phase 1-01`、`Phase 1-02`）。執行 `gsd-tools roadmap upgrade --convention milestone-prefixed` 遷移現有 ROADMAP.md。 |
| `response_language` | string | 語言程式碼 | （無） | agent 響應語言（如 `"pt"`、`"ko"`、`"ja"`）。傳播至所有派生 agent，實現跨階段語言一致性。v1.32 新增 |
| `context_window` | number | 任意整數 | `200000` | 上下文視窗大小（token 數）。對於 1M 上下文模型（如 `claude-opus-4-7[1m]`），設定為 `1000000`。`>= 500000` 的值啟用自適應上下文增強（完整讀取之前的 SUMMARY.md，更深入的反模式讀取）。通過 `/gsd-config --advanced` 配置。 |
| `context_profile` | string | `dev`, `research`, `review` | （無） | 執行上下文預設，為當前工作型別應用預配置的模式、模型和工作流設定包。v1.34 新增 |
| `claude_md_path` | string | 任意檔案路徑 | `./CLAUDE.md` | 生成的 CLAUDE.md 檔案的自定義輸出路徑。適用於需要將 CLAUDE.md 放在非根目錄位置的 monorepo 或專案。預設為專案根目錄下的 `./CLAUDE.md`。v1.36 新增 |
| `claude_md_assembly.mode` | enum | `embed`, `link` | `embed` | 控制如何將受管理的節寫入 CLAUDE.md。`embed`（預設）在 GSD 標記之間內聯內容。`link` 改為寫入 `@.planning/<source-path>`——Claude Code 在執行時展開引用，在典型專案中將 CLAUDE.md 大小減少約 65%。`link` 僅適用於有真實原始檔的節；`workflow` 和回退節始終嵌入。按塊覆蓋：`claude_md_assembly.blocks.<section>`（如 `claude_md_assembly.blocks.architecture: link`）。v1.38 新增 |
| `context` | string | 任意文本 | （無） | 注入到專案所有 agent 提示詞中的自定義上下文字串。用於提供每個 agent 都應瞭解的永續性專案特定指導（如編碼規範、團隊實踐） |
| `phase_naming` | string | 任意字串 | （無） | 階段目錄名稱的自定義字首。設定後，覆蓋自動生成的階段 slug（如 `"feature"` 生成 `feature-01-setup/` 而非路線圖派生的 slug） |
| `brave_search` | boolean | `true`/`false` | 自動檢測 | 覆蓋 Brave Search API 可用性的自動檢測。未設定時，GSD 檢查 `BRAVE_API_KEY` 環境變數或 `~/.gsd/brave_api_key` 檔案 |
| `firecrawl` | boolean | `true`/`false` | 自動檢測 | 覆蓋 Firecrawl API 可用性的自動檢測。未設定時，GSD 檢查 `FIRECRAWL_API_KEY` 環境變數或 `~/.gsd/firecrawl_api_key` 檔案 |
| `exa_search` | boolean | `true`/`false` | 自動檢測 | 覆蓋 Exa Search API 可用性的自動檢測。未設定時，GSD 檢查 `EXA_API_KEY` 環境變數或 `~/.gsd/exa_api_key` 檔案 |
| `search_gitignored` | boolean | `true`/`false` | `false` | `planning.search_gitignored` 的舊版頂層別名。優先使用名稱空間形式；此別名為向後相容而保留 |

> **注意：** `granularity` 在 v1.22.3 中從 `depth` 重新命名而來。現有配置會自動遷移。

---

## 整合設定

通過 [`/gsd-config --integrations`](COMMANDS.md#gsd-config) 互動式配置。這些是*連線*設定——API 金鑰和跨工具路由——特意與 `/gsd-settings`（工作流開關）分開。

### 搜尋 API 金鑰

API 金鑰欄位接受字串值（金鑰本身）。也可以設定為哨兵值 `true`/`false`/`null` 來覆蓋來自環境變數 / `~/.gsd/*_api_key` 檔案的自動檢測（舊版行為，參見上方各行）。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `brave_search` | string \| boolean \| null | `null` | 用於網路研究的 Brave Search API 金鑰。在所有 UI / `config-set` 輸出中顯示為 `****<末4位>`；從不以明文回顯 |
| `firecrawl` | string \| boolean \| null | `null` | 用於深度抓取的 Firecrawl API 金鑰。顯示時已脫敏 |
| `exa_search` | string \| boolean \| null | `null` | 用於語義搜尋的 Exa Search API 金鑰。顯示時已脫敏 |

**脫敏規範（`get-shit-done/bin/lib/secrets.cjs`）：** 8 個字元及以上的金鑰顯示為 `****<末4位>`；較短的金鑰顯示為 `****`；`null`/空值顯示為 `(unset)`。明文原樣寫入 `.planning/config.json`——該檔案是安全邊界——但 CLI、確認表格、日誌和 `AskUserQuestion` 描述中不顯示明文。這也適用於 `config-set` 命令本身的輸出：`config-set brave_search <key>` 返回帶脫敏值的 JSON 負載。

### 程式碼審查 CLI 路由

`review.models.<cli>` 將審查器型別對映到 shell 命令。當請求匹配的型別時，程式碼審查工作流使用此命令進行 shell 呼叫。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `review.models.claude` | string | （會話模型） | Claude 風格審查的命令。未設定時預設使用會話模型 |
| `review.models.codex` | string | `null` | Codex 審查命令，如 `"codex exec --model gpt-5"` |
| `review.models.gemini` | string | `null` | Gemini 審查命令，如 `"gemini -m gemini-2.5-pro"` |
| `review.models.opencode` | string | `null` | OpenCode 審查命令，如 `"opencode run --model claude-sonnet-4"` |

`<cli>` slug 需通過 `[a-zA-Z0-9_-]+` 驗證。空值或包含路徑的 slug 會被 `config-set` 拒絕。

### `/gsd-review` 的預設審查器

使用 `review.default_reviewers` 將無標誌的 `/gsd-review` 執行限定為已檢測審查器的子集。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `review.default_reviewers` | string[] \| null | `null`（所有已檢測審查器） | 無標誌 `/gsd-review` 的可選預設子集，如 `["gemini","codex"]`。優先順序順序：顯式審查器標誌 > `--all` > `review.default_reviewers` > 所有已檢測。未知 slug 以警告忽略；已知但未檢測到的 slug 以資訊提示忽略；空陣列會被 `config-set` 拒絕。 |

示例：

```json
{
  "review": {
    "default_reviewers": ["gemini", "codex"]
  }
}
```

### Agent 技能注入（動態）

`agent_skills.<agent-type>` 擴充套件下方記錄的 `agent_skills` 對映。slug 需通過 `[a-zA-Z0-9_-]+` 驗證——無路徑分隔符、無空格、無 shell 元字元。通過 `/gsd-config --integrations` 互動式配置。

---

## 工作流開關

所有工作流開關遵循**缺失 = 啟用**模式。如果配置中缺少某個鍵，預設值為 `true`。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `workflow.research` | boolean | `true` | 規劃每個階段前進行領域調研 |
| `workflow.plan_check` | boolean | `true` | 計劃驗證迴圈（最多 3 次迭代） |
| `workflow.verifier` | boolean | `true` | 執行後針對階段目標的驗證 |
| `workflow.auto_advance` | boolean | `false` | 自動串聯 discuss → plan → execute，無需停頓 |
| `workflow.nyquist_validation` | boolean | `true` | 計劃階段研究期間的測試覆蓋率對映 |
| `workflow.ui_phase` | boolean | `true` | 為前端階段生成 UI 設計契約 |
| `workflow.ui_safety_gate` | boolean | `true` | 在計劃階段期間，提示為前端階段執行 /gsd-ui-phase |
| `workflow.ui_review` | boolean | `true` | 在自主模式下階段執行後執行視覺品質審計（`/gsd-ui-review`）。為 `false` 時跳過 UI 審計步驟。 |
| `workflow.node_repair` | boolean | `true` | 驗證失敗時自主任務修復 |
| `workflow.node_repair_budget` | number | `2` | 每個失敗任務的最大修復嘗試次數 |
| `workflow.research_before_questions` | boolean | `false` | 在討論問題之前而非之後執行研究 |
| `workflow.discuss_mode` | string | `'discuss'` | 控制 `/gsd-discuss-phase` 如何收集上下文。`'discuss'`（預設）逐一提問。`'assumptions'` 先讀取程式碼庫，生成帶置信度的結構化假設，只要求糾正錯誤內容。v1.28 新增 |
| `workflow.max_discuss_passes` | number | `3` | 工作流停止提問前討論階段的最大輪數。在無頭/自動模式下防止無限討論迴圈。 |
| `workflow.skip_discuss` | boolean | `false` | 為 `true` 時，`/gsd-autonomous` 完全跳過討論階段，從 ROADMAP 階段目標寫入最簡 CONTEXT.md。適用於開發者偏好已完整寫入 PROJECT.md/REQUIREMENTS.md 的專案。v1.28 新增 |
| `workflow.text_mode` | boolean | `false` | 將 AskUserQuestion TUI 選單替換為純文本編號列表。在 TUI 選單無法渲染的 Claude Code 遠端會話（`/rc` 模式）中必需。也可通過討論階段的 `--text` 標誌按會話設定。v1.28 新增 |
| `workflow.use_worktrees` | boolean | `true` | 為 `false` 時，停用並行執行的 git worktree 隔離。偏好順序執行或環境不支援 worktree 的使用者可以停用此選項。v1.31 新增 |
| `workflow.worktree_skip_hooks` | boolean | `false` | 為 `true` 時，worktree 模式下的執行器 agent 傳遞 `--no-verify`（跳過提交前鉤子），波次後的鉤子驗證改為針對合併結果執行。適用於鉤子無法在 agent worktree 中執行的專案的可選逃生艙口。預設 `false` 對每次提交執行鉤子（#2924）。 |
| `workflow.code_review` | boolean | `true` | 啟用 `/gsd-code-review` 和 `/gsd-code-review --fix` 命令。為 `false` 時，命令以配置門禁訊息退出。v1.34 新增 |
| `workflow.code_review_depth` | string | `standard` | `/gsd-code-review` 的預設審查深度：`quick`（僅模式匹配）、`standard`（按檔案分析）或 `deep`（帶匯入圖的跨檔案）。可通過 `--depth=` 按次執行覆蓋。v1.34 新增 |
| `workflow.plan_bounce` | boolean | `false` | 針對生成的計劃執行外部驗證指令碼。啟用後，計劃階段編排器將每個 PLAN.md 通過 `plan_bounce_script` 指定的指令碼管道處理，並在非零退出時阻塞。v1.36 新增 |
| `workflow.plan_bounce_script` | string | （無） | 用於計劃反彈驗證的外部指令碼路徑。接收 PLAN.md 路徑作為第一個引數。當 `plan_bounce` 為 `true` 時必需。v1.36 新增 |
| `workflow.plan_bounce_passes` | number | `2` | 順序執行的反彈輪數。每輪將上一輪的輸出反饋給驗證器。較高的值提升嚴格性，但會增加延遲。v1.36 新增 |
| `workflow.post_planning_gaps` | boolean | `true` | 統一的規劃後差距報告（#2493）。所有計劃生成並提交後，掃描 REQUIREMENTS.md 和 CONTEXT.md 的 `<decisions>` 與階段目錄中的每個 PLAN.md，然後列印一個 `Source \| Item \| Status` 表格。單詞邊界匹配（REQ-1 vs REQ-10）和自然排序（REQ-02 在 REQ-10 之前）。非阻塞——僅為資訊性報告。設為 `false` 跳過計劃階段的步驟 13e。 |
| `workflow.plan_review_convergence` | boolean | `false` | 啟用 `/gsd-plan-review-convergence` 命令。預設停用——此鍵為 `false` 時命令以啟用說明退出。該命令自動化手動計劃→審查→重新規劃迴圈：派生已配置的審查器（Codex、Gemini、Claude、OpenCode、Ollama、LM Studio、llama.cpp），通過 CYCLE_SUMMARY 契約計算未解決的 HIGH 問題，用 `--reviews` 反饋重新規劃，並重復直至收斂或達到最大迴圈次數。通過 `gsd config-set workflow.plan_review_convergence true` 啟用。v1.39 新增 |
| `workflow.plan_chunked` | boolean | `false` | 啟用分塊規劃模式。為 `true`（或向 `/gsd-plan-phase` 傳遞 `--chunked` 標誌）時，編排器將單個長期規劃器任務拆分為一個簡短的輪廓任務，後跟 N 個簡短的按計劃任務（每個約 3-5 分鐘）。每個計劃單獨提交以具備崩潰韌性。如果任務掛起且終端被強制終止，使用 `--chunked` 重新執行將從最後完成的計劃處恢復。在長期任務可能在 stdio 上掛起的 Windows 上特別有用。v1.38 新增 |
| `workflow.code_review_command` | string | （無） | `/gsd-ship` 中外部程式碼審查整合的 shell 命令。通過 stdin 接收更改的檔案路徑。非零退出阻塞釋出工作流。v1.36 新增 |
| `workflow.tdd_mode` | boolean | `false` | 將 TDD 流水線作為一等執行模式啟用。為 `true` 時，規劃器積極地將 `type: tdd` 應用於符合條件的任務（業務邏輯、API、驗證、演算法），執行器強制執行 RED/GREEN/REFACTOR 門禁序列。階段結束時的協作審查檢查點驗證門禁合規性。v1.36 新增 |
| `workflow.human_verify_mode` | string | `'end-of-phase'` | 控制人工驗證檢查點。`'end-of-phase'`（自 #3309 起為預設值）抑制 `checkpoint:human-verify` 任務，並將檢查嵌入 `<verify><human-check>` 塊以供階段結束審查。`'mid-flight'` 恢復阻塞式檢查點任務。`checkpoint:decision` 和 `checkpoint:human-action` 不受影響。參見[檢查點參考](../../get-shit-done/references/checkpoints.md#checkpoint_types)。 |
| `workflow.cross_ai_execution` | boolean | `false` | 將階段執行委託給外部 AI CLI，而非派生本地執行器 agent。適用於利用不同模型在特定階段的優勢。v1.36 新增 |
| `workflow.cross_ai_command` | string | （無） | 跨 AI 執行的 shell 命令模板。通過 stdin 接收階段提示詞。必須生成與 SUMMARY.md 相容的輸出。當 `cross_ai_execution` 為 `true` 時必需。v1.36 新增 |
| `workflow.cross_ai_timeout` | number | `300` | 跨 AI 執行命令的超時秒數。防止失控的外部程序。v1.36 新增 |
| `workflow.ai_integration_phase` | boolean | `true` | 啟用 `/gsd-ai-integration-phase` 命令。為 `false` 時，命令以配置門禁訊息退出 |
| `workflow.auto_prune_state` | boolean | `false` | 為 `true` 時，在階段邊界自動清理 STATE.md 中的過期條目，而非提示確認 |
| `workflow.pattern_mapper` | boolean | `true` | 在研究和規劃之間執行 `gsd-pattern-mapper` agent，將新檔案對映到現有程式碼庫類似物 |
| `workflow.subagent_timeout` | number | `600` | 單個 subagent 呼叫的超時秒數。對於長時間執行的研究或執行階段可適當增加 |
| `executor.stall_detect_interval_minutes` | number | `5` | 執行器 agent 活躍時，執行器停滯檢測的間隔分鐘數。執行階段編排器以此頻率檢查最近的提交，避免無限等待靜默的 agent。 |
| `executor.stall_threshold_minutes` | number | `10` | 執行器完成或預期分支提交活動缺失超過此分鐘數後，執行階段為可能停滯的執行器提供恢復選項。 |
| `workflow.inline_plan_threshold` | number | `3` | 階段中任務數量的最大值，超過此值後規劃器生成單獨的 PLAN.md 檔案而非在提示詞中內聯任務 |
| `workflow.drift_threshold` | number | `3` | 階段期間引入的新結構元素（新目錄、桶形匯出、遷移、路由模組）的最小數量，超過此值後執行後代碼庫漂移門禁採取行動。參見 [#2003](https://github.com/open-gsd/gsd-core/issues/2003)。v1.39 新增 |
| `workflow.drift_action` | string | `warn` | `/gsd-execute-phase` 後超過 `workflow.drift_threshold` 時的處理方式。`warn` 列印建議執行 `/gsd-map-codebase --paths …` 的訊息；`auto-remap` 派生 `gsd-codebase-mapper` 限定於受影響路徑。v1.39 新增 |
| `workflow.build_command` | string | （無） | 在執行階段步驟 5.6 的步驟 A 中（合併後構建門禁）構建專案的 shell 命令。未設定時，門禁自動檢測：Xcode（存在 `.xcodeproj`）→ `xcodebuild build`，帶 `build:` 目標的 `Makefile` → `make build`，Justfile → `just build`，`Cargo.toml` → `cargo build`，`go.mod` → `go build ./...`，Python → `python -m py_compile`，帶 `build` 指令碼的 `package.json` → `npm run build`。5 分鐘超時執行；失敗時遞增 `WAVE_FAILURE_COUNT`。v1.39 新增 |
| `workflow.test_command` | string | （無） | 在執行階段步驟 5.6 的步驟 B 中（合併後測試門禁）和迴歸門禁中執行專案測試套件的 shell 命令。未設定時，門禁自動檢測：Xcode（存在 `.xcodeproj`）→ `xcodebuild test`，帶 `test:` 目標的 `Makefile` → `make test`，Justfile → `just test`，`package.json` → `npm test`，`Cargo.toml` → `cargo test`，`go.mod` → `go test ./...`，Python → `python -m pytest`。5 分鐘超時執行；失敗時遞增 `WAVE_FAILURE_COUNT`。v1.39 新增 |

## 程式碼品質設定

`code_quality.*` 名稱空間控制可選的結構分析工具，作為 `/gsd-code-review` 的補充。各設定為增量式：每個工具獨立選擇啟用，預設關閉。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `code_quality.fallow.enabled` | boolean | `false` | 為 `/gsd-code-review` 啟用 fallow 結構預處理。為 `false` 時，不生成 fallow 二進位制探針或 JSON 產物。 |
| `code_quality.fallow.scope` | string | `phase` | fallow 分析範圍：`phase`（當前審查檔案範圍）或 `repo`（整個倉庫）。 |
| `code_quality.fallow.profile` | string | `standard` | 傳遞給預處理執行器的 fallow 配置檔案選擇器（`minimal`、`standard`、`strict`）。 |
| `code_quality.fallow.mcp` | boolean | `false` | **保留——尚未實現。** 為 `true` 時，為支援 MCP 伺服器路由的執行時啟用基於 MCP 的結構性發現模式。當前將此設為 `true` 是無操作，並會發出執行時警告。 |

## 釋出設定

`ship.pr_body_sections` 為 `/gsd-ship` 新增額外的 PR 正文節，用於專案特定的 PRD/PR 正文內容，而無需編輯 `get-shit-done/workflows/ship.md`。

有關入門示例和故障排除的使用者指南，請參閱[自定義 PR 正文節](../ship-pr-body-sections.md)。

此列表為僅追加：已配置的條目在核心的 `Summary`、`Changes`、`Requirements Addressed`、`Verification` 和 `Key Decisions` 節之後新增。它們不能替換、刪除或重新排序必需節。

推薦的精益/敏捷 PRD 用途包括使用者故事、驗收標準、完成定義或釋出標準、風險和依賴關係、成功指標以及利益相關者審查說明。保持這些節簡短且以證據為導向，使 PR 正文成為活躍的釋出產物而非靜態需求轉儲。

每個條目支援：

| 欄位 | 型別 | 預設值 | 描述 |
|-------|------|---------|-------------|
| `heading` | string | 必需 | 渲染為 `## {heading}` 的 Markdown 節標題。必須為單行。 |
| `enabled` | boolean | `true` | 為 `false` 時，入門時可在配置中保留候選節而不在生成的 PR 正文中渲染。 |
| `source` | string | （無） | 規劃產物標題的可選回退鏈，如 `PLAN.md ## Risks \|\| VERIFICATION.md ## Manual Checks`。允許的產物有 `ROADMAP.md`、`PLAN.md`、`SUMMARY.md`、`VERIFICATION.md`、`STATE.md`、`REQUIREMENTS.md` 和 `CONTEXT.md`。 |
| `template` | string | （無） | 帶封閉 token 的字面 Markdown：`{phase_number}`、`{phase_name}`、`{phase_dir}`、`{base_branch}`、`{padded_phase}`。 |
| `fallback` | string | （無） | 當 `source` 不產生內容且未提供 `template` 時使用的字面 Markdown。 |

每個節至少需要 `source`、`template` 或 `fallback` 之一。預設為 `[]`，因此現有專案在入門新增啟用條目之前保持當前的 `/gsd-ship` 輸出。

示例：

```json
{
  "ship": {
    "pr_body_sections": [
      {
        "heading": "User Stories & Acceptance Criteria",
        "enabled": true,
        "source": "REQUIREMENTS.md ## User Stories || REQUIREMENTS.md ## Acceptance Criteria",
        "fallback": "- Acceptance criteria are covered by the linked requirements and verification evidence."
      },
      {
        "heading": "Risks & Rollback",
        "enabled": true,
        "source": "PLAN.md ## Risks || PLAN.md ## Rollback",
        "fallback": "- Rollback: revert this PR."
      },
      {
        "heading": "Stakeholder Sign-off",
        "enabled": false,
        "template": "- Product owner: pending for {phase_name}"
      }
    ]
  }
}
```

### 常用設定組合

以下 `mode`、`granularity`、`model_profile` 和工作流開關的組合常常一起使用。有關設定指導，請參閱[配置模型配置檔案](how-to/configure-model-profiles.md)。

| 場景 | mode | granularity | profile | research | plan_check | verifier |
|----------|------|-------------|---------|----------|------------|----------|
| 原型開發 | `yolo` | `coarse` | `budget` | `false` | `false` | `false` |
| 常規開發 | `interactive` | `standard` | `balanced` | `true` | `true` | `true` |
| 生產釋出 | `interactive` | `fine` | `quality` | `true` | `true` | `true` |

---

## 規劃設定

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `planning.commit_docs` | boolean | `true` | `.planning/` 檔案是否提交到 git |
| `planning.search_gitignored` | boolean | `false` | 向大範圍搜尋新增 `--no-ignore` 以包含 `.planning/` |
| `planning.sub_repos` | string 陣列 | `[]` | 相對於專案根目錄的巢狀子倉庫路徑。設定後，GSD 感知工具按子倉庫劃定階段查詢、路徑解析和提交操作的範圍，而非將外層倉庫視為 monorepo |

### 多倉庫工作空間中的專案根目錄解析

當設定了 `sub_repos` 且從列出的子倉庫內部呼叫 `gsd-tools.cjs` 或 `gsd-tools query` 時，兩個 CLI 都會向上走到擁有 `.planning/` 的父工作空間，然後再分發處理程序。解析順序（在每個祖先最多向上檢查 10 層，不超過 `$HOME`）：

1. 如果起始目錄本身有 `.planning/`，則其為專案根目錄（不向上走）。
2. 父目錄有 `.planning/config.json`，且其 `sub_repos`（或舊版 `planning.sub_repos` 形式）中列出了起始目錄的頂層段。
3. 父目錄有 `.planning/config.json`，帶舊版 `multiRepo: true`，且起始目錄在某個 git 倉庫內。
4. 父目錄有 `.planning/`，且候選父目錄到某個祖先之間包含 `.git`（啟發式回退）。

如果都不匹配，則返回起始目錄不變。顯式的 `--project-dir /path/to/workspace` 在此解析下是冪等的。

### 自動檢測

如果 `.planning/` 在 `.gitignore` 中，則 `commit_docs` 自動為 `false`，無論 config.json 如何設定。這可防止 git 錯誤。

---

## 鉤子設定

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `hooks.context_warnings` | boolean | `true` | 通過上下文監控鉤子顯示上下文視窗使用警告 |
| `hooks.workflow_guard` | boolean | `false` | 當檔案編輯發生在 GSD 工作流上下文之外時發出警告（建議使用 `/gsd-quick` 或 `/gsd-fast`） |
| `statusline.show_last_command` | boolean | `false` | 向狀態行追加 `last: /<cmd>` 字尾，顯示最近呼叫的斜槓命令。選擇性啟用；讀取活躍會話記錄以提取最新的 `<command-name>` 標籤（關閉 #2538） |
| `statusline.context_position` | string | `"end"` | 上下文視窗計量器的位置。`"end"`（預設）在行尾渲染；`"front"` 在模型名稱後立即渲染，使計量器在窄終端中保持可見。關閉 #2937 |

提示詞注入防護鉤子（gsd-prompt-guard.js）始終啟用，無法停用——它是安全特性，而非工作流開關。

### 私有規劃設定

當 `planning.commit_docs` 為 `false` 且 `.planning/` 在 `.gitignore` 中時，GSD 將規劃產物視為僅本地存在。`planning.search_gitignored: true` 確保此配置下大範圍搜尋仍然包含 `.planning/` 目錄。有關設定步驟，請參閱[配置私有規劃](how-to/configure-model-profiles.md)。

---

## Agent 技能注入

向 GSD subagent 提示詞注入自定義技能檔案。技能在 agent spawn 時讀取，為其提供 CLAUDE.md 之外的專案特定指令。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `agent_skills` | object | `{}` | agent 型別到技能目錄路徑的對映 |

### 配置

在 `.planning/config.json` 中新增 `agent_skills` 節，將 agent 型別對映到技能目錄路徑陣列（相對於專案根目錄）：

```json
{
  "agent_skills": {
    "gsd-executor": ["skills/testing-standards", "skills/api-conventions"],
    "gsd-planner": ["skills/architecture-rules"],
    "gsd-verifier": ["skills/acceptance-criteria"]
  }
}
```

每個路徑必須是包含 `SKILL.md` 檔案的目錄。路徑經過安全驗證（不允許遍歷到專案根目錄之外）。

### 支援的 Agent 型別

任何 GSD agent 型別都可以接收技能。常用型別：

- `gsd-executor` -- 執行實施計劃
- `gsd-planner` -- 建立階段計劃
- `gsd-checker` -- 驗證計劃品質
- `gsd-verifier` -- 執行後驗證
- `gsd-researcher` -- 階段研究
- `gsd-project-researcher` -- 新專案研究
- `gsd-debugger` -- 診斷 agent
- `gsd-codebase-mapper` -- 程式碼庫分析
- `gsd-advisor` -- 討論階段顧問
- `gsd-ui-researcher` -- UI 設計契約建立
- `gsd-ui-checker` -- UI 規格驗證
- `gsd-roadmapper` -- 路線圖建立
- `gsd-synthesizer` -- 研究綜合

### 工作原理

在 spawn 時，工作流呼叫 `gsd-tools query agent-skills <type>`（或舊版 `node gsd-tools.cjs agent-skills <type>`）來載入已配置的技能。如果該 agent 型別存在技能，它們將作為 `<agent_skills>` 塊注入到 Task() 提示詞中：

```xml
<agent_skills>
Read these user-configured skills:
- @skills/testing-standards/SKILL.md
- @skills/api-conventions/SKILL.md
</agent_skills>
```

如果未配置技能，則省略該塊（零開銷）。

### CLI

通過 CLI 設定技能：

```bash
gsd-tools query config-set agent_skills.gsd-executor '["skills/my-skill"]'
```

---

## 功能標誌

通過 `features.*` 配置名稱空間切換可選功能。功能標誌預設為 `false`（停用）——啟用標誌即選擇新行為，不影響現有工作流。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `features.thinking_partner` | boolean | `false` | 在工作流決策點啟用思維夥伴分析 |
| `features.global_learnings` | boolean | `false` | 啟用跨專案學習流水線（階段完成時自動複製，注入規劃器） |
| `learnings.max_inject` | number | `10` | 注入每個規劃器提示詞的最大跨專案學習數量。較低值減少提示詞大小；較高值提供更廣泛的歷史上下文 |
| `intel.enabled` | boolean | `false` | 啟用可查詢的程式碼庫情報系統。為 `true` 時，`/gsd-map-codebase --query` 命令在 `.planning/intel/` 中構建和查詢 JSON 索引。v1.34 新增 |

<a id="plan-review-settings"></a>
### 計劃審查設定

`plan_review.*` 名稱空間控制計劃漂移防護，該功能驗證生成計劃中引用的符號（裝飾器、類、函式、CLI 標誌）在審查時實際存在於原始碼中。這在執行開始前捕獲幻覺名稱。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `plan_review.source_grounding` | boolean | `true` | 啟用計劃漂移防護。為 `true`（預設）時，計劃審查將 PLAN.md 中引用的每個符號與即時原始碼樹對比解析。引用不存在的函式、類、裝飾器或 CLI 標誌的計劃在計劃批准前產生 `needs-acknowledgement` 通知。設為 `false` 完全跳過符號驗證。可在設定期間（`/gsd:new-project`）或隨時通過 `/gsd:settings` 切換。 |
| `plan_review.source_grounding_authority` | enum | `grep` | 選擇用於驗證符號存在性的解析器介面卡。允許值：`grep`（預設——對原始檔進行 ripgrep/grep 搜尋，任何專案無需額外工具即可使用），`intel`（查詢 `/gsd:map-codebase` 構建的 `.planning/intel/api-map.json` 索引；需要 `intel.enabled: true`），`treesitter`（保留用於未來的 tree-sitter 介面卡），`lsp`（保留用於未來的 LSP 介面卡），`scip`（保留用於未來的 SCIP/LSIF 介面卡）。當您已執行 `/gsd:map-codebase` 並希望使用更快的預索引查詢時，使用 `intel`。`grep` 和 `intel` 之外的所有值均為保留值，在當前版本中無效。 |

<a id="graphify-settings"></a>
### Graphify 設定

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `graphify.enabled` | boolean | `false` | 啟用專案知識圖譜。為 `true` 時，`/gsd-graphify` 在 `.planning/graphs/` 中構建和查詢圖譜。v1.36 新增 |
| `graphify.build_timeout` | number（秒） | `300` | `/gsd-graphify build` 執行中止前的最大允許秒數。v1.36 新增 |
| `graphify.auto_update` | boolean | `false` | **選擇性啟用（issue #3347）。** 為 `true`（且 `graphify.enabled` 也為 `true`）時，捆綁的 PostToolUse 鉤子 `hooks/gsd-graphify-update.sh` 在預設分支（`git.base_branch` 覆蓋，否則為 `main`/`master`/`trunk`）上執行 `git commit/merge/pull/rebase --continue/cherry-pick` 後，在後臺分離程序中自動重建專案知識圖譜。鉤子立即返回；重建更新 `.planning/graphs/{graph.json,graph.html,GRAPH_REPORT.md}` 並寫入 `.planning/graphs/.last-build-status.json`（`{ts, status: "running"\|"ok"\|"failed", exit_code, duration_ms, head_at_build}`）。PID 鎖定，CI 感知（`$CI` 環境變數抑制），若 `graphify` 不在 `PATH` 中則靜默退出。預設 `false`，升級後現有行為不變。 |

#### 多開發者設定

當多個開發者在同一倉庫中重建圖譜時，`graphify hook install`（每個克隆執行一次）安裝一個 git 合併驅動程式，對併發的 `graph.json` 寫入進行聯合合併，消除衝突標記。它還註冊提交後重建鉤子，寫入 `.gitattributes`，並將 `graphify merge-driver` 新增到 `.git/config`。單人專案可跳過此步驟。隨 graphify v0.7.0 一同引入，以及 `/gsd-graphify status` 顯示的 `built_at_commit` 新鮮度訊號。

#### 基於提交的過期性

`/gsd-graphify status` 報告兩個正交的過期性訊號：

- **`stale`**（基於 mtime，24 小時視窗）——圖譜檔案最後寫入時間。在 graphify 未自動執行時有用。
- **`commit_stale`**（基於提交，需要 graphify v0.7+）——圖譜是否針對當前 `git HEAD` 構建。存在時可信。
  三態值：`true` / `false` / `null`。`null` 表示訊號不可用（v0.7 之前的圖譜、無 git 或無法訪問提交）——回退到 mtime 標誌。

在舊檢出上重建的 CI 圖譜在 mtime 上顯示為新鮮，但 `commit_stale: true`。回答架構問題時兩者都應呈現。

### 用法

```bash
# 啟用功能
gsd-tools query config-set features.global_learnings true

# 停用功能
gsd-tools query config-set features.thinking_partner false
```

`features.*` 名稱空間是動態鍵模式——無需修改 `VALID_CONFIG_KEYS` 即可新增新的功能標誌。任何匹配 `features.<name>` 的鍵都被配置系統接受。

---

## 並行化設定

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `parallelization` | boolean | `true` | `parallelization.enabled` 的簡寫。設定 `parallelization false` 停用並行執行而不更改其他子鍵 |
| `parallelization.enabled` | boolean | `true` | 同時執行獨立計劃 |
| `parallelization.plan_level` | boolean | `true` | 在計劃級別並行化 |
| `parallelization.task_level` | boolean | `false` | 並行化計劃內的任務 |
| `parallelization.skip_checkpoints` | boolean | `true` | 並行執行期間跳過檢查點 |
| `parallelization.max_concurrent_agents` | number | `3` | 最大同時 agent 數 |
| `parallelization.min_plans_for_parallel` | number | `2` | 觸發並行執行的最小計劃數 |

> **提交前鉤子和並行執行**：當並行化啟用時，執行器 agent 使用 `--no-verify` 提交，以避免構建鎖爭用（如 Rust 專案中的 cargo lock 衝突）。編排器在每個波次完成後統一驗證鉤子。STATE.md 寫入通過檔案級鎖保護，防止併發寫入損壞。如果需要每次提交都執行鉤子，請設定 `parallelization.enabled: false`。

---

## STATE.md 前言（階段生命週期）

`STATE.md` 攜帶 YAML 前言，狀態行鉤子在每次渲染時讀取。v1.40 添加了四個可選的階段生命週期欄位，由 `parseStateMd()` 讀取並由 `formatGsdState()` 渲染：

| 欄位 | 型別 | 用途 |
|-------|------|---------|
| `active_phase` | string（如 `"4.5"`） | 編排器命令執行中時的階段編號 |
| `next_action` | string | 空閒時推薦的下一個命令（`discuss-phase` / `plan-phase` / `execute-phase` / `verify-phase`） |
| `next_phases` | YAML 流陣列 | `next_action` 適用的階段（如 `["4.5"]`） |
| `progress` | block | 巢狀的 `total_phases` / `completed_phases` / `percent`，用於里程碑進度條 |

所有四個欄位均為**可選且增量式**——沒有這些欄位的 STATE.md 檔案與 v1.38.x 中的渲染完全相同。有關完整欄位參考、解析器約束和渲染場景，請參閱 [STATE.md schema](reference/state-md.md)。

---

## Git 分支

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `git.branching_strategy` | enum | `none` | `none`、`phase` 或 `milestone` |
| `git.base_branch` | string | `main` | 建立階段/里程碑分支併合並回的整合分支。當倉庫使用 `master` 或釋出分支時可覆蓋 |
| `git.create_tag` | boolean | `true` | 在里程碑完成時建立 git 標籤（`v[X.Y]`）。對於有自己釋出流程的專案，設為 `false` |
| `git.phase_branch_template` | string | `gsd/phase-{phase}-{slug}` | 階段策略的分支名稱模板 |
| `git.milestone_branch_template` | string | `gsd/{milestone}-{slug}` | 里程碑策略的分支名稱模板 |
| `git.quick_branch_template` | string 或 null | `null` | `/gsd-quick` 任務的可選分支名稱模板 |

### 策略對比

| 策略 | 建立分支 | 範圍 | 合併點 | 最適合 |
|----------|---------------|-------|-------------|----------|
| `none` | 從不 | 不適用 | 不適用 | 單人開發、簡單專案 |
| `phase` | 在 `execute-phase` 開始時 | 一個階段 | 使用者在階段後合併 | 按階段程式碼審查、細粒度回滾 |
| `milestone` | 在首次 `execute-phase` 時 | 里程碑中的所有階段 | 在 `complete-milestone` 時 | 釋出分支、按版本 PR |

### 模板變數

| 變數 | 適用於 | 示例 |
|----------|-------------|---------|
| `{phase}` | `phase_branch_template` | `03`（零填充） |
| `{slug}` | 兩種模板 | `user-authentication`（小寫、連字元） |
| `{milestone}` | `milestone_branch_template` | `v1.0` |
| `{num}` / `{quick}` | `quick_branch_template` | `260317-abc`（快速任務 ID） |

快速任務分支示例：

```json
"git": {
  "quick_branch_template": "gsd/quick-{num}-{slug}"
}
```

### 里程碑完成時的合併選項

| 選項 | Git 命令 | 結果 |
|--------|-------------|--------|
| Squash 合併（推薦） | `git merge --squash` | 每個分支一個乾淨的提交 |
| 帶歷史合併 | `git merge --no-ff` | 保留所有單獨提交 |
| 不合並直接刪除 | `git branch -D` | 丟棄分支工作 |
| 保留分支 | （無） | 稍後手動處理 |

---

## 門禁設定

控制工作流期間的確認提示。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `gates.confirm_project` | boolean | `true` | 最終確定前確認專案詳情 |
| `gates.confirm_phases` | boolean | `true` | 確認階段分解 |
| `gates.confirm_roadmap` | boolean | `true` | 繼續前確認路線圖 |
| `gates.confirm_breakdown` | boolean | `true` | 確認任務分解 |
| `gates.confirm_plan` | boolean | `true` | 執行前確認每個計劃 |
| `gates.execute_next_plan` | boolean | `true` | 執行下一個計劃前確認 |
| `gates.issues_review` | boolean | `true` | 建立修復計劃前審查 issue |
| `gates.confirm_transition` | boolean | `true` | 確認階段過渡 |

---

## 安全設定

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `safety.always_confirm_destructive` | boolean | `true` | 確認破壞性操作（刪除、覆蓋） |
| `safety.always_confirm_external_services` | boolean | `true` | 確認外部服務互動 |

---

## 安全加固設定

安全加固功能（v1.31）的設定。所有設定遵循**缺失 = 啟用**模式。這些鍵位於 `.planning/config.json` 的 `workflow.*` 下——與 `workflows/plan-phase.md`、`workflows/execute-phase.md`、`workflows/secure-phase.md` 和 `workflows/verify-work.md` 中的釋出模板和執行時讀取位置一致。

這些鍵位於 `workflow.*` 下——工作流和安裝器在此處寫入和讀取。在 `config.json` 頂層設定它們會被靜默忽略。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `workflow.security_enforcement` | boolean | `true` | 通過 `/gsd-secure-phase` 啟用威脅模型錨定的安全驗證。為 `false` 時完全跳過安全檢查 |
| `workflow.security_asvs_level` | number（1-3） | `1` | OWASP ASVS 驗證級別。級別 1 = 機會性，級別 2 = 標準，級別 3 = 全面 |
| `workflow.security_block_on` | string | `"high"` | 阻止階段推進的最低嚴重性。選項：`"high"`、`"medium"`、`"low"` |

---

## 決策覆蓋門禁（`workflow.context_coverage_gate`）

當 `discuss-phase` 將實施決策寫入 CONTEXT.md 的 `<decisions>` 時，兩個門禁確保這些決策在進入計劃和釋出程式碼的過程中得以保留（issue #2492）。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `workflow.context_coverage_gate` | boolean | `true` | 兩個決策覆蓋門禁的總開關。為 `false` 時，計劃階段轉化門禁和驗證階段確認門禁均靜默跳過。 |

### 門禁作用

**計劃階段轉化門禁（阻塞性）。** 在現有需求覆蓋門禁之後、計劃提交之前立即執行。對於 `<decisions>` 中的每個可追蹤決策，檢查決策 id（`D-NN`）或其文本是否出現在至少一個計劃的 `must_haves`、`truths` 或正文中。遺漏會按 id 顯示缺失的決策，並拒絕將階段標記為已規劃。

**驗證階段確認門禁（非阻塞性）。** 與其他驗證步驟同時執行。在每個可追蹤決策的所有釋出產物（PLAN.md、SUMMARY.md、已修改檔案、最近的提交主題）中搜索。遺漏作為警告節寫入 VERIFICATION.md，但**不**翻轉整體驗證狀態。這種不對稱是有意為之——在驗證階段，工作已完成，模糊的子字串遺漏不應使其他通過的階段失敗。

### 編寫門禁可接受的決策

討論階段模板已生成帶 `D-NN` 編號的決策。當滿足以下條件時門禁最為高效：

1. 每個實施決策的計劃在某處**引用該 id**——`must_haves.truths: ["D-12: bit offsets exposed"]` 或計劃正文中的 `D-12:` 提及。嚴格 id 匹配是最便宜、最確定的路徑。
2. 軟短語匹配是同義表達的回退——如果決策文本的 6 個以上單詞的片段逐字出現在計劃/摘要中，則計入。

### 豁免

在以下任何情況下，決策**不受**門禁約束：

- 它位於 `<decisions>` 中的 `### Claude's Discretion` 標題下。
- 它在專案符號中標記為 `[informational]`、`[folded]` 或 `[deferred]`（如 `- **D-08 [informational]:** Naming style for internal helpers`）。

當決策真正不需要計劃覆蓋時，使用這些逃生艙口——實施決策權、為記錄捕獲的未來想法，或已推遲到後續階段的專案。

---

## 審查設定

為 `/gsd-review` 配置按 CLI 的模型選擇。設定後，覆蓋該審查器的 CLI 預設模型。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `review.models.gemini` | string | （CLI 預設） | 呼叫 `--gemini` 審查器時使用的模型 |
| `review.models.claude` | string | （CLI 預設） | 呼叫 `--claude` 審查器時使用的模型 |
| `review.models.codex` | string | （CLI 預設） | 呼叫 `--codex` 審查器時使用的模型 |
| `review.models.opencode` | string | （CLI 預設） | 呼叫 `--opencode` 審查器時使用的模型 |
| `review.models.qwen` | string | （CLI 預設） | 呼叫 `--qwen` 審查器時使用的模型 |
| `review.models.cursor` | string | （CLI 預設） | 呼叫 `--cursor` 審查器時使用的模型 |
| `review.models.ollama` | string | （伺服器預設） | 呼叫 `--ollama` 審查器時傳遞給 Ollama 的模型名稱。未設定時使用伺服器報告的第一個可用模型（如 `llama3`）。設定為特定標籤：`gsd config-set review.models.ollama codellama` |
| `review.models.lm_studio` | string | （伺服器預設） | 呼叫 `--lm-studio` 審查器時傳遞給 LM Studio 的模型名稱。未設定時使用伺服器報告的第一個可用模型。 |
| `review.models.llama_cpp` | string | （伺服器預設） | 呼叫 `--llama-cpp` 審查器時傳遞給 llama.cpp 的模型名稱。未設定時使用 `/v1/models` 報告的第一個模型。 |
| `review.default_reviewers` | string[] \| null | （所有已檢測審查器） | 無標誌 `/gsd-review` 的預設審查器子集。示例：`["gemini","codex"]`。顯式標誌和 `--all` 覆蓋此設定。 |
| `review.max_prompt_tokens` | number\|null | null | 組裝審查提示詞的預設最大預估 token 數。設定後，在傳送給每個審查器之前對提示詞進行確定性裁剪。按審查器覆蓋通過 `review.max_prompt_tokens_per_reviewer` 優先。null = 不裁剪（當前行為）。 |
| `review.max_prompt_tokens_per_reviewer` | object | {} | 按審查器的 token 預算覆蓋。鍵為審查器 slug（ollama、llama_cpp、lm_studio、gemini、claude、codex、opencode、qwen、cursor）。值覆蓋該審查器的 `review.max_prompt_tokens`。推薦用於本地模型伺服器。 |
| `review.ollama_host` | string | `http://localhost:11434` | Ollama 伺服器的基礎 URL。在非預設埠或遠端主機上執行 Ollama 時覆蓋：`gsd config-set review.ollama_host http://192.168.1.10:11434` |
| `review.lm_studio_host` | string | `http://localhost:1234` | LM Studio 本地伺服器的基礎 URL。使用非預設埠時覆蓋。 |
| `review.llama_cpp_host` | string | `http://localhost:8080` | llama.cpp 伺服器（`llama-server`）的基礎 URL。使用非預設埠時覆蓋。 |

### 小上下文審查器的提示詞預算

本地模型伺服器（Ollama、llama.cpp、LM Studio）通常接受的 token 數遠少於雲 API。設定 `review.max_prompt_tokens_per_reviewer`（或全域性 `review.max_prompt_tokens` 回退）會在將提示詞傳送給該審查器之前觸發確定性裁剪：首先刪除 CONTEXT，然後是 RESEARCH，然後是 REQUIREMENTS；PROJECT.md 頭部收縮至前 40 行；PLAN 按比例尾部截斷——指令和路線圖始終保留。當審查器被裁剪時，在提示詞頂部注入一條披露說明，並將裁剪後設資料（預算、省略節、截斷百分比）記錄在 REVIEWS.md 前言的 `trimmed_reviewers` 下。如果即使是最小審查集（指令 + 路線圖 + 計劃存根）也超出預算，則跳過該審查器併發出警告，而非傳送會產生誤導性反饋的截斷提示詞。

### 示例

```json
{
  "review": {
    "models": {
      "gemini": "gemini-2.5-pro",
      "qwen": "qwen-max"
    }
  }
}
```

鍵缺失時回退到各 CLI 的配置預設值。v1.35.0 新增（#1849）。

---

## 管理器透傳標誌

配置 `/gsd-manager` 追加到每個分發命令的按步驟標誌。這允許在不手動輸入標誌的情況下自定義管理器執行 discuss、plan 和 execute 步驟的方式。

| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `manager.flags.discuss` | string | （無） | 追加到 discuss-phase 命令的標誌（如 `"--auto"`） |
| `manager.flags.plan` | string | （無） | 追加到 plan-phase 命令的標誌（如 `"--skip-research"`） |
| `manager.flags.execute` | string | （無） | 追加到 execute-phase 命令的標誌（如 `"--validate"`） |

**示例：**

```json
{
  "manager": {
    "flags": {
      "discuss": "--auto",
      "plan": "--skip-research",
      "execute": "--validate"
    }
  }
}
```

無效的標誌 token 會被淨化並記錄為警告。只有已識別的 GSD 標誌才會透傳。

---

## 模型配置檔案

### 配置檔案定義

| Agent | `quality` | `balanced` | `budget` | `adaptive` | `inherit` |
|-------|-----------|------------|----------|------------|-----------|
| gsd-planner | Opus | Opus | Sonnet | Opus | Inherit |
| gsd-roadmapper | Opus | Sonnet | Sonnet | Opus | Inherit |
| gsd-executor | Opus | Sonnet | Sonnet | Sonnet | Inherit |
| gsd-phase-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-project-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-research-synthesizer | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-debugger | Opus | Sonnet | Sonnet | Opus | Inherit |
| gsd-codebase-mapper | Sonnet | Haiku | Haiku | Haiku | Inherit |
| gsd-verifier | Sonnet | Sonnet | Haiku | Sonnet | Inherit |
| gsd-plan-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-integration-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-nyquist-auditor | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-pattern-mapper | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-ui-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-ui-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-ui-auditor | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-doc-writer | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-doc-verifier | Sonnet | Sonnet | Haiku | Haiku | Inherit |

> **所有 33 個釋出 agent 在目錄（`sdk/shared/model-catalog.json`）中均有顯式的按配置檔案層級分配。** 上表顯示最常用 agent 的代表性子集。對於此處未列出的 agent，`model_overrides` 接受任何已釋出的 agent 名稱。權威的配置檔案資料通過 `get-shit-done/bin/lib/model-catalog.cjs` 和 `sdk/src/model-catalog.ts` 從 `sdk/shared/model-catalog.json` 匯出。

### 按 Agent 覆蓋

覆蓋特定 agent 而不更改整個配置檔案：

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-planner": "haiku"
  }
}
```

有效的覆蓋值：`opus`、`sonnet`、`haiku`、`inherit`，或任何完全限定的模型 ID（如 `"openai/o3"`、`"google/gemini-2.5-pro"`）。

`model_overrides` 可以設定在 `.planning/config.json`（按專案）或 `~/.gsd/defaults.json`（全域性）中。按專案條目在衝突時優先，不衝突的全域性條目被保留，因此可以在一個倉庫中調整單個 agent 的模型而無需重新設定全域性預設值。這在 Claude Code、Codex、OpenCode、Kilo 和其他支援的執行時中統一適用。在 Codex 和 OpenCode 上，解析後的模型在安裝時嵌入每個 agent 的靜態配置中——`spawn_agent` 和 OpenCode 的 `task` 介面不接受內聯 `model` 引數，因此編輯 `model_overrides` 後需要執行 `gsd install <runtime>` 才能使更改生效。參見 issue #2256。

### 按階段型別的模型（`models`）— v1.41 新增

> 在**階段**級別（規劃、研究、執行、驗證）進行調整，無需瞭解 agent 分類。添加於 [#3023](https://github.com/open-gsd/gsd-core/pull/3030)。

`model_overrides` 是按 **agent** 的（精確但冗長；需要知道 `gsd-codebase-mapper` 屬於研究，`gsd-doc-writer` 屬於執行）。`models` 塊允許用兩行表達"規劃和執行用 Opus，其餘用 Sonnet"：

```json
{
  "model_profile": "balanced",
  "models": {
    "planning": "opus",
    "discuss": "opus",
    "research": "sonnet",
    "execution": "opus",
    "verification": "sonnet",
    "completion": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

#### 階段型別 → agent 對映

| 階段型別 | Agents |
|---|---|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `discuss` | （保留——當前無 subagent） |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier` |
| `completion` | （保留——當前無 subagent） |

`discuss` 和 `completion` 被 schema 接受以保持前向相容性；今天設定它們是無操作，直到某個 subagent 對映到它們為止。

#### 解析優先順序（從高到低）

```text
1. model_overrides[<agent>]              ← 按 agent；完整 ID；針對性例外
2. dynamic_routing.tier_models[<tier>]   ← 啟用時（參見§動態路由）
3. models[<phase_type>]                  ← 粗粒度階段級層級（本節）
4. model_profile（按 agent 列）          ← 全域性層級策略
5. 執行時預設值                          ← 其他均不適用時
```

五層從上到下組合：`model_profile` 是基礎層級，`models[<phase_type>]` 在階段級別覆蓋，`dynamic_routing`（啟用時）在軟性失敗時按嘗試次數升級，`model_overrides[<agent>]` 在頂層切出按 agent 的例外，執行時預設值在其他均不適用時生效。在上面的示例中，所有五個研究 agent 解析為 `sonnet`，*除了* `gsd-codebase-mapper`，它被按 agent 覆蓋固定為 `haiku`。`dynamic_routing` 預設停用——關閉時（`enabled: false` 或省略該塊），本節的行為與當前相同。

#### 可接受的值

`models.<phase_type>` 僅接受層級別名：

| 值 | 效果 |
|---|---|
| `"opus"` / `"sonnet"` / `"haiku"` | 標準層級——執行時解析對映到該層級的活躍執行時模型 |
| `"inherit"` | 此階段的 agent 遵循會話模型（與 `model_profile: "inherit"` 語義相同） |

如果需要完全限定的模型 ID（`"openai/gpt-5"`、`"google/gemini-2.5-pro"`），請改為按 agent 使用 `model_overrides`。`models.*` 有意僅接受層級別名，以便執行時感知對映在 Codex / OpenCode / Gemini CLI 安裝上保持正確。

#### 何時使用哪種方式

| 您想要 | 使用 |
|---|---|
| 一個全域性層級策略（"全部 balanced"） | `model_profile` |
| 粗粒度階段級調整（"規劃用 Opus"） | `models.<phase_type>` |
| 按 agent 精度（"強制程式碼庫對映器使用 haiku"） | `model_overrides[<agent>]` |
| 特定 agent 的完整模型 ID | `model_overrides[<agent>]: "openai/gpt-5"` |

自由混合——上述優先規則確定性地解決任何重疊。

#### 驗證

`config-set` 拒絕未知階段型別：

```bash
$ gsd config-set models.deployment opus
Error: 'models.deployment' is not a valid config key

# 有效：
$ gsd config-set models.research sonnet
```

直接編輯 `.planning/config.json` 較為寬鬆——解析器簡單地忽略無法識別的值並回退到配置檔案層級——因此拼寫錯誤不會靜默破壞層級解析。

### 動態路由與失敗層級升級（`dynamic_routing`）— v1.41 新增

> 預設使用廉價層級，僅在 agent 失敗門禁時升級。添加於 [#3024](https://github.com/open-gsd/gsd-core/pull/3031)。

`dynamic_routing` 讓您預設支付廉價層級的費用，僅在編排器檢測到軟性失敗（驗證不確定、計劃檢查 FLAG 等）時升級到更昂貴的層級。

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

#### Agent 預設層級

`MODEL_PROFILES` 中的每個 agent 宣告三個預設層級之一。解析器為第一次嘗試選擇 `tier_models[default_tier]`。

| 層級 | Agents | 用途 |
|---|---|---|
| `light` | gsd-codebase-mapper, gsd-doc-classifier, gsd-doc-verifier, gsd-integration-checker, gsd-intel-updater, gsd-nyquist-auditor, gsd-pattern-mapper, gsd-plan-checker, gsd-research-synthesizer, gsd-ui-auditor, gsd-ui-checker | 廉價/快速——純對映器、掃描器、低風險審計 |
| `standard` | gsd-advisor-researcher, gsd-ai-researcher, gsd-code-fixer, gsd-code-reviewer, gsd-doc-synthesizer, gsd-doc-writer, gsd-domain-researcher, gsd-eval-auditor, gsd-executor, gsd-phase-researcher, gsd-project-researcher, gsd-ui-researcher, gsd-verifier | 預設主力——研究、寫作、主要驗證 |
| `heavy` | gsd-assumptions-analyzer, gsd-debug-session-manager, gsd-debugger, gsd-eval-planner, gsd-framework-selector, gsd-planner, gsd-roadmapper, gsd-security-auditor, gsd-user-profiler | 深度推理——已處於頂層，無法進一步升級 |

#### 升級流程

```text
1. 編排器派生 agent → 解析器返回 tier_models[default_tier]
2. 軟性失敗？
   ├─ 否 → ✓ 完成（廉價路徑）
   └─ 是 → 編排器以 attempt+1 重新派生
            → 解析器返回 tier_models[next_tier_up]
            → 上限為 max_escalations
3. 硬性失敗（異常/崩潰）→ 繞過升級，立即顯示
```

如果 `dynamic_routing.escalate_on_failure: false`，軟性失敗**不會**推進層級——每次重新派生都繼續使用 `tier_models[default_tier]`，不論嘗試計數如何。此終止開關覆蓋上述軟性失敗分支。

`light → standard → heavy → heavy`（heavy 保持在 heavy；無法進一步）。

#### 解析優先順序（從高到低）

1. **`model_overrides[<agent>]`** — 接受完整 ID；針對性例外
2. **`dynamic_routing.tier_models[<tier>]`**（當 `enabled: true` 時）
3. **`models[<phase_type>]`** — 粗粒度階段級（#3023）
4. **`model_profile`** — 活躍配置檔案中按 agent 的列
5. **執行時預設值**

`dynamic_routing` 塊**預設停用**——`enabled: false`（或省略該塊）完全保留當前的靜態解析行為。

#### 設定

| 鍵 | 型別 | 預設值 | 描述 |
|---|---|---|---|
| `dynamic_routing.enabled` | boolean | `false` | 主開關。為 `true` 時，動態路由解析器用於層級選擇。 |
| `dynamic_routing.tier_models.light` | enum | （無） | 輕量層級的層級別名。通常為 `haiku`。 |
| `dynamic_routing.tier_models.standard` | enum | （無） | 標準層級的別名。通常為 `sonnet`。 |
| `dynamic_routing.tier_models.heavy` | enum | （無） | 重量層級的別名。通常為 `opus`。 |
| `dynamic_routing.escalate_on_failure` | boolean | `true` | 為 false 時停用升級（每次嘗試使用預設層級）。 |
| `dynamic_routing.max_escalations` | integer | `1` | 每次 agent 呼叫的硬性重試上限。防止失控迴圈。 |

#### 何時使用哪種方式

| 您想要 | 使用 |
|---|---|
| 所有 agent 的一種層級策略 | `model_profile` |
| 粗粒度階段級調整 | `models.<phase_type>` |
| 按 agent 精度（完整 ID） | `model_overrides` |
| **預設廉價，僅失敗時升級** | **`dynamic_routing`** |

`dynamic_routing` 在結構上是*成本槓桿*：只有在真正需要 Opus 的困難情況下才支付 Opus 費率。與 `model_overrides` 組合以實現按 agent 例外（覆蓋始終優先）。

---

### 努力控制（`effort`）— v1.42 新增

> 統一的跨提供商努力旋鈕。添加於 [#443](https://github.com/open-gsd/gsd-core/issues/443)。

使用單個配置控制 agent 呼叫的推理努力。通用階梯為：

```
minimal < low < medium < high < xhigh < max
```

努力按執行時渲染：Claude 的 `output_config.effort`（Claude Code subagent `effort` 前言 / `CLAUDE_CODE_EFFORT_LEVEL` 環境變數），Codex 的 `model_reasoning_effort`（Responses API `reasoning.effort`）。

**跨提供商限制：** `max` 僅適用於 Anthropic——在 Codex 上限制為 `xhigh`。`minimal` 僅適用於 Codex——在 Claude 上限制為 `low`。

模型目錄的按層級 `reasoning_effort` 提示是保留供參考的舊版欄位；努力現在由配置驅動。

**優先順序（從高到低）：**
1. 呼叫覆蓋（如 `resolve-execution` 上的 `--effort` 標誌）
2. `effort.agent_overrides[<agent-id>]`
3. `effort.routing_tier_defaults[<light|standard|heavy>]`
4. `effort.default`
5. `"high"`（Anthropic Opus 4.8 通用預設值）

```json
{
  "effort": {
    "default": "high",
    "routing_tier_defaults": {
      "light":    "low",
      "standard": "high",
      "heavy":    "xhigh"
    },
    "agent_overrides": {
      "gsd-planner": "max"
    }
  }
}
```

#### 設定

| 鍵 | 型別 | 預設值 | 描述 |
|---|---|---|---|
| `effort.default` | enum | `"high"` | 全域性回退努力級別。無層級或 agent 覆蓋匹配時應用。 |
| `effort.routing_tier_defaults.light` | enum | `"low"` | 輕量層級 agent（快速對映器/掃描器）的努力。 |
| `effort.routing_tier_defaults.standard` | enum | `"high"` | 標準層級 agent（主力 agent）的努力。 |
| `effort.routing_tier_defaults.heavy` | enum | `"xhigh"` | 重量層級 agent（深度推理）的努力。 |
| `effort.agent_overrides.<agent-id>` | enum | （無） | 按 agent 的努力覆蓋。優先於層級預設值。 |

有效努力值：`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

---

### 快速模式（`fast_mode`）— v1.42 新增

> 按 agent 的 fast_mode 傳播旋鈕。添加於 [#443](https://github.com/open-gsd/gsd-core/issues/443)。

控制是否將 fast_mode 傳播到 agent 呼叫。僅接受真正的布林值——字串 `"true"` 會被拒絕。

**注意：** `fast_mode` 僅可通過 API 執行時傳播（`api` speed:"fast"）。Claude Code 沒有按 subagent 的快速模式機制——`/fast` 僅在會話級別，因此在 Claude subagent 上發出 `fast_mode` 前言鍵是靜默無操作。`resolve-execution` 輸出中的 `fast_mode_supported` 告知您配置的執行時是否支援它。

**優先順序（從高到低）：**
1. 呼叫覆蓋（如 `resolve-execution` 上的 `--fast-mode` 標誌）
2. `fast_mode.agent_overrides[<agent-id>]`（布林值）
3. `fast_mode.routing_tier_defaults[<light|standard|heavy>]`（布林值）
4. `fast_mode.enabled`（布林值）
5. `false`

```json
{
  "fast_mode": {
    "enabled": false,
    "routing_tier_defaults": {
      "light":    true,
      "standard": false,
      "heavy":    false
    },
    "agent_overrides": {}
  }
}
```

#### 設定

| 鍵 | 型別 | 預設值 | 描述 |
|---|---|---|---|
| `fast_mode.enabled` | boolean | `false` | 全域性 fast_mode 標誌。無層級/agent 覆蓋匹配時才生效。 |
| `fast_mode.routing_tier_defaults.light` | boolean | `true` | 輕量層級 agent 的快速模式。 |
| `fast_mode.routing_tier_defaults.standard` | boolean | `false` | 標準層級 agent 的快速模式。 |
| `fast_mode.routing_tier_defaults.heavy` | boolean | `false` | 重量層級 agent 的快速模式。 |
| `fast_mode.agent_overrides.<agent-id>` | boolean | （無） | 按 agent 的 fast_mode 覆蓋。 |

---

### 執行查詢（`resolve-execution`）

使用 `node gsd-tools.cjs resolve-execution <agent-type> [--effort <level>] [--fast-mode <true|false>] [--attempt <n>]` 獲取 agent 的完整解析後執行上下文：

```json
{
  "model":             "opus",
  "profile":           "balanced",
  "effort":            "xhigh",
  "effort_rendered":   "xhigh",
  "effort_param":      "output_config.effort",
  "effort_propagation": "frontmatter",
  "fast_mode":         false,
  "fast_mode_supported": false
}
```

`effort_param` 告知您要設定哪個執行時引數。`fast_mode_supported` 告知您配置的執行時是否支援按 agent 的 fast_mode 傳播。

---

### 非 Claude 執行時（Codex、OpenCode、Gemini CLI、Kilo）

> **Codex CLI 最低支援版本：`0.130.0`**（issue [#3562](https://github.com/open-gsd/gsd-core/issues/3562)）。
>
> [Codex CLI 0.130.0](https://github.com/openai/codex/releases/tag/rust-v0.130.0)（2026-05-08 釋出）通過 [openai/codex#21485](https://github.com/openai/codex/pull/21485) 移除了通過 extra-skills-roots 發現功能。從此版本起，Codex CLI 僅掃描 `~/.codex/skills/<name>/SKILL.md`、`<project>/.codex/skills/` 和已註冊的外掛根目錄以查詢可呼叫技能。GSD 將 `$gsd-*` 介面安裝為 `~/.codex/skills/gsd-<name>/SKILL.md`，因此命令在 Codex 重啟後解析。早期 Codex CLI 版本可能顯示重複列表（舊版 extra-roots 掃描加上使用者根目錄副本）——重啟 Codex 並升級到 ≥ 0.130.0，或在升級前接受重複項。

當 GSD 為非 Claude 執行時安裝時，安裝器自動在 `~/.gsd/defaults.json` 中設定 `resolve_model_ids: "omit"`。這使 GSD 為所有 agent 返回空模型引數，因此每個 agent 使用執行時配置的任何模型。預設情況下無需額外設定。

如果您希望不同 agent 使用不同模型，請使用帶有執行時可識別的完全限定模型 ID 的 `model_overrides`：

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3",
    "gsd-codebase-mapper": "o4-mini"
  }
}
```

意圖與 Claude 配置檔案層級相同——對規劃和除錯使用更強的模型（推理品質最重要的地方），對執行和對映使用更廉價的模型（計劃中已包含推理）。

**何時使用哪種方式：**

| 場景 | 設定 | 效果 |
|----------|---------|--------|
| 非 Claude 執行時，單一模型 | `resolve_model_ids: "omit"`（安裝器預設） | 所有 agent 使用執行時預設模型 |
| 非 Claude 執行時，分層模型 | `resolve_model_ids: "omit"` + `model_overrides` | 命名 agent 使用特定模型，其他使用執行時預設 |
| 帶 OpenRouter/本地提供商的 Claude Code | `model_profile: "inherit"` | 所有 agent 遵循會話模型 |
| 帶 OpenRouter 的 Claude Code，分層 | `model_profile: "inherit"` + `model_overrides` | 命名 agent 使用特定模型，其他繼承 |

**`resolve_model_ids` 值：**

| 值 | 行為 | 使用場景 |
|-------|----------|----------|
| `false`（預設） | 返回 Claude 別名（`opus`、`sonnet`、`haiku`） | 使用原生 Anthropic API 的 Claude Code |
| `true` | 將別名對映到完整 Claude 模型 ID（`claude-opus-4-8`） | 使用需要完整 ID 的 API 的 Claude Code |
| `"omit"` | 返回空字串（執行時選擇其預設值） | 非 Claude 執行時（Codex、OpenCode、Gemini CLI、Kilo） |

### 執行時感知配置檔案（#2517）

當設定了 `runtime` 時，配置檔案層級（`opus`/`sonnet`/`haiku`）解析為執行時原生模型 ID，而非 Claude 別名。這讓單個共享的 `.planning/config.json` 在 Claude 和 Codex 之間乾淨執行。

`resolve-model` JSON 輸出包含 `reasoning_effort`（當為該 agent 解析的執行時層級定義了 `reasoning_effort` 時）。執行時介面卡可將該值傳遞給支援它的子 agent 啟動呼叫；不明確支援的執行時省略它。

**內建層級對映：**

| 執行時 | `opus` | `sonnet` | `haiku` | reasoning_effort |
|---------|--------|----------|---------|------------------|
| `claude` | `claude-opus-4-8` | `claude-sonnet-4-6` | `claude-haiku-4-5` | （不使用） |
| `codex` | `gpt-5.5` | `gpt-5.3-codex` | `gpt-5.4-mini` | `xhigh` / `medium` / `medium` |
| `gemini` | `gemini-3-pro` | `gemini-3-flash` | `gemini-2.5-flash-lite` | （不使用） |
| `qwen` | `qwen3-max-2026-01-23` | `qwen3-coder-plus` | `qwen3-coder-next` | （不使用） |
| `opencode` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-4-6` | `anthropic/claude-haiku-4-5` | （不使用） |
| `copilot` | `claude-opus-4-8` | `claude-sonnet-4-6` | `claude-haiku-4-5` | （不使用） |
| `hermes` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-4-6` | `anthropic/claude-haiku-4-5` | （不使用） |
| B 組（`kilo`、`cline`、`cursor`、`windsurf`、`augment`、`trae`、`codebuddy`、`antigravity`） | （無內建預設——您的執行時處理模型選擇） | | | |

**Codex 示例** — 單個配置，分層模型，無大型 `model_overrides` 塊：

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

這將 `gsd-planner` 解析為 `gpt-5.5`（xhigh），`gsd-executor` 解析為 `gpt-5.3-codex`（medium），`gsd-codebase-mapper` 解析為 `gpt-5.4-mini`（medium）。Codex 安裝器將 `model = "..."` 和 `model_reasoning_effort = "..."` 嵌入每個生成的 agent TOML。

**Claude 示例** — 顯式選擇解析到完整 Claude ID（無需 `resolve_model_ids: true`）：

```json
{
  "runtime": "claude",
  "model_profile": "quality"
}
```

**按執行時覆蓋** — 替換一個或多個層級預設值：

```json
{
  "runtime": "codex",
  "model_profile": "quality",
  "model_profile_overrides": {
    "codex": {
      "opus": "gpt-5-pro",
      "haiku": { "model": "gpt-5-nano", "reasoning_effort": "low" }
    }
  }
}
```

**優先順序（從高到低）：**

1. `model_overrides[<agent>]` — 顯式的按 agent ID 始終優先。
2. **執行時感知層級解析**（本節）——當設定了 `runtime` 且配置檔案不是 `inherit` 時。
3. `resolve_model_ids: "omit"` — 未設定 `runtime` 時返回空字串。
4. Claude 原生預設——`model_profile` 層級作為別名（當前預設）。
5. `inherit` — 為 `Task(model="inherit")` 語義傳播字面量 `inherit`。

**向後相容性。** 未設定 `runtime` 的配置零行為變化——每個現有配置繼續完全相同地工作。自動設定 `resolve_model_ids: "omit"` 的 Codex 安裝繼續省略模型欄位，除非使用者通過設定 `runtime: "codex"` 選擇啟用。

**未知執行時。** 如果 `runtime` 設定為沒有內建層級對映且沒有 `model_profile_overrides[<runtime>]` 的值，GSD 回退到 Claude 別名安全預設值，而非發出執行時無法接受的模型 ID。要支援新執行時，請在 `model_profile_overrides.<runtime>.{opus,sonnet,haiku}` 中填入有效 ID。

### 配置檔案哲學

| 配置檔案 | 哲學 | 何時使用 |
|---------|-----------|-------------|
| `quality` | 所有決策用 Opus，驗證用 Sonnet | 配額充足、關鍵架構工作 |
| `balanced` | 僅規劃用 Opus，其餘一切用 Sonnet | 常規開發（預設） |
| `budget` | 程式碼編寫用 Sonnet，研究/驗證用 Haiku | 大批次工作、不太關鍵的階段 |
| `inherit` | 所有 agent 使用當前會話模型 | 動態模型切換、**非 Anthropic 提供商**（OpenRouter、本地模型） |

---

## 模型策略預設（`model_policy`）— v1.42 新增

> **[#49](https://github.com/open-gsd/gsd-core/issues/49)** — 提供商中立的模型策略配置介面。在舊版 `model_profile_overrides` 之前解析。

`model_policy` 提供了一種更簡單、提供商中立的方式來跨執行時配置模型層級。對於手動知道正確模型 ID 需要使用 `model_profile_overrides` 的非 Anthropic 執行時，這是首選介面。通過 `/gsd:settings` → 第 8 節（模型策略）配置。

### 已知提供商預設

通過設定工作流選擇提供商和預算級別；GSD 為該提供商/預算組合寫入規範模型 ID：

```json
{
  "runtime": "codex",
  "model_policy": {
    "provider": "openai",
    "budget": "medium",
    "high":   "gpt-5.5",
    "medium": "gpt-5.3-codex",
    "low":    "gpt-5.4-mini"
  }
}
```

已知提供商：`openai`、`anthropic`、`google`、`qwen`。預算級別：`high`、`medium`、`low`。

對於高階的按執行時控制，`runtime_tiers` 接受使用內部配置檔案層級名稱（`opus`、`sonnet`、`haiku`）的顯式條目：

```json
{
  "runtime": "codex",
  "model_policy": {
    "provider": "openai",
    "runtime_tiers": {
      "codex": {
        "opus":   { "model": "gpt-5.5",        "reasoning_effort": "high" },
        "sonnet": { "model": "gpt-5.3-codex",  "reasoning_effort": "medium" },
        "haiku":  { "model": "gpt-5.4-mini",   "reasoning_effort": "low" }
      }
    }
  }
}
```

### 通用提供商（逃生艙口）

對於 OpenRouter、LiteLLM、本地閘道器或任何需要提供精確模型 ID 的執行時，使用 `provider: "generic"`（或 `"custom"`）。GSD 將模型 ID 視為不透明字串——無字首推斷，無提供商特定預設值：

```json
{
  "runtime": "opencode",
  "model_policy": {
    "provider": "generic",
    "high":   "openrouter/anthropic/claude-opus-4-5",
    "medium": "openrouter/anthropic/claude-sonnet-4-5",
    "low":    "openrouter/anthropic/claude-haiku-4-5"
  }
}
```

### 推理努力門控

`runtime_tiers` 條目中的 `reasoning_effort` 僅轉發給宣告支援它的執行時（當前：`codex`）。不在允許列表中的任何執行時都不接收該欄位——它被靜默剝離，從不洩露。

### 優先順序

`model_policy` 解析位於解析器中 `model_profile_overrides` 之上：

1. `model_overrides[<agent>]` — 按 agent 顯式 ID（最高）
2. `model_policy.runtime_tiers[<runtime>][<tier>]` — 顯式執行時/層級條目
3. `model_policy` 扁平 `high`/`medium`/`low` 鍵 — 用於 `generic`/`custom` 提供商
4. `model_profile_overrides[<runtime>][<tier>]` — 舊版按執行時覆蓋
5. 內建執行時目錄預設值
6. `model_profile` 層級別名

**向後相容性。** 沒有 `model_policy` 的配置不受影響。現有的 `model_profile_overrides` 塊繼續完全按之前工作。

---

## 環境變數

| 變數 | 用途 |
|----------|---------|
| `CLAUDE_CONFIG_DIR` | 覆蓋預設配置目錄（`~/.claude/`） |
| `GEMINI_API_KEY` | 由上下文監控器檢測以切換鉤子事件名稱 |
| `GSD_AUDIT` | 設定為 `1` 以啟用排程審計檔案（`.planning/.gsd-trace.jsonl`） |
| `GSD_AUDIT_ARGS` | 設定為 `1` 以在審計/錯誤事件中包含命令引數（預設省略） |
| `GSD_PROJECT` | 覆蓋多專案工作空間支援的專案根目錄（v1.32） |
| `GSD_SKIP_SCHEMA_CHECK` | 跳過執行階段期間的 schema 漂移檢測（v1.31） |
| `WSL_DISTRO_NAME` | 由安裝器檢測以處理 WSL 路徑 |

---

## 全域性預設值

將設定儲存為未來專案的全域性預設值：

**位置：** `~/.gsd/defaults.json`

當 `/gsd-new-project` 建立新的 `config.json` 時，它讀取全域性預設值並將其作為初始配置合併。按專案設定始終覆蓋全域性設定。

---

## 可觀測性

命令路由中心在每次排程後發出結構化的 `DispatchEvent`。預設行為是**成功時靜默**，**錯誤時向 stderr 輸出一行結構化 JSON**。

### Stderr 錯誤格式

當排程失敗時，向 stderr 輸出一行 JSON：

```json
{ "kind": "HandlerFailure", "traceId": "...", "command": "plan", "timestamp": "...", "message": "..." }
```

`kind` 欄位匹配中心的錯誤變體之一：`UnknownCommand`、`InvalidArgs`、`HandlerRefusal` 或 `HandlerFailure`。引數預設省略（隱私）；參見下方 `GSD_AUDIT_ARGS`。

### 審計跟蹤（選擇性啟用）

啟用僅追加審計檔案以記錄每次排程（成功和錯誤）：

**通過環境變數：**
```bash
GSD_AUDIT=1 gsd plan
```

**通過配置（`config.audit.enabled`）：**
```json
{
  "audit": {
    "enabled": true
  }
}
```

**審計檔案位置：** `.planning/.gsd-trace.jsonl`（已 gitignore）

每行都是一個完整的 `DispatchEvent` JSON 物件，包含 `traceId`（每次排程的唯一 UUID v4）和 `parentTraceId`（當呼叫者將 `req.parentTraceId` 傳入 `Hub.dispatch` 時存在）。未來的初始化編排器（第 2 階段）將自動連線 `parentTraceId`，使單個頂層呼叫的所有子排程共享一個公共父級；在此之前，葉子排程發出 `parentTraceId: undefined`。您可以通過在審計檔案上過濾 `parentTraceId === <rootTraceId>` 來將子事件關聯到父級。檔案為僅追加，從不截斷；需要時手動輪換或刪除。`parentTraceId` 必須是規範的 UUID v4（RFC 4122，格式 `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`）；不匹配此格式的值會從發出的事件中靜默刪除，不會出現在審計輸出中。

### 引數編輯

預設情況下，命令引數從所有發出的事件（stderr 錯誤和審計檔案）中**省略**。要逐字包含引數：

```bash
GSD_AUDIT_ARGS=1 GSD_AUDIT=1 gsd plan --tdd
```

`GSD_AUDIT_ARGS` 同時適用於 stderr 錯誤行和審計檔案。

---

## 相關連結

- [命令參考](COMMANDS.md)
- [配置模型配置檔案](how-to/configure-model-profiles.md)
- [STATE.md schema](reference/state-md.md)
- [文件索引](README.md)
