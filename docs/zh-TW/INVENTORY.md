# GSD 已釋出功能清單

> 所有已釋出 GSD 功能面的權威目錄：命令、代理、工作流、參考資料、CLI 模組和鉤子。當廣義文件（AGENTS.md、COMMANDS.md、ARCHITECTURE.md、CLI-TOOLS.md）與檔案系統不一致時，以本檔案及程式碼庫目錄樹為準。

## 使用說明

- 本檔案中的數量基於 v1.36.0 快照，版本之間可能存在偏差。如需即時數量，請在檢出目錄中執行 `ls commands/gsd/*.md | wc -l`、`ls agents/gsd-*.md | wc -l` 等命令。
- 本檔案列舉了所有六大類別（代理、命令、工作流、參考資料、CLI 模組、鉤子）中的每個已釋出功能面。廣義文件可能呈現敘述性內容或精選子集；當其與檔案系統不一致時，本檔案及目錄清單為準。
- v1.36.0 之後新增的功能面應首先在此處記錄，再傳播到廣義文件中。`tests/inventory-counts.test.cjs`、`tests/commands-doc-parity.test.cjs`、`tests/agents-doc-parity.test.cjs`、`tests/cli-modules-doc-parity.test.cjs`、`tests/hooks-doc-parity.test.cjs`、`tests/architecture-counts.test.cjs` 和 `tests/command-count-sync.test.cjs` 中的漂移控制測試將數量和清單內容錨定到檔案系統。

這是所有已釋出 GSD Core 功能面的權威目錄。請參閱 [文件索引](README.md) 按主題導航。

---

## 代理 (33 shipped)

完整清單位於 `agents/gsd-*.md`。"主要文件"列標註了 [`docs/AGENTS.md`](../AGENTS.md) 是否提供完整角色卡（*primary*）、"高階與專項代理"章節中的簡短存根（*advanced stub*），或未覆蓋（*inventory only*）。

| 代理 | 角色（一行描述） | 由誰啟動 | 主要文件 |
|------|----------------|----------|----------|
| gsd-project-researcher | 在路線圖建立前研究領域生態系統（技術棧、功能、架構、潛在問題）。 | `/gsd-new-project`、`/gsd-new-milestone` | primary |
| gsd-phase-researcher | 在規劃前研究特定階段的實施方案。 | `/gsd-plan-phase` | primary |
| gsd-ui-researcher | 為前端階段生成 UI 設計契約。 | `/gsd-ui-phase` | primary |
| gsd-assumptions-analyzer | 為 discuss-phase（假設模式）生成有證據支撐的假設。 | `discuss-phase-assumptions` 工作流 | primary |
| gsd-advisor-researcher | 在 discuss-phase 顧問模式下研究單個灰色地帶決策。 | `discuss-phase` 工作流（顧問模式） | primary |
| gsd-research-synthesizer | 將並行研究者的輸出整合為統一的 SUMMARY.md。 | `/gsd-new-project` | primary |
| gsd-planner | 建立可執行的階段計劃，包含任務分解和目標反向驗證。 | `/gsd-plan-phase`、`/gsd-quick` | primary |
| gsd-roadmapper | 建立包含階段分解和需求對映的專案路線圖。 | `/gsd-new-project` | primary |
| gsd-executor | 以原子提交和偏差處理方式執行 GSD 計劃。 | `/gsd-execute-phase`、`/gsd-quick` | primary |
| gsd-plan-checker | 驗證計劃是否能實現階段目標（8 個驗證維度）。 | `/gsd-plan-phase`（驗證迴圈） | primary |
| gsd-integration-checker | 驗證跨階段整合和端到端流程。 | `/gsd-audit-milestone` | primary |
| gsd-ui-checker | 根據品質維度驗證 UI-SPEC.md 設計契約。 | `/gsd-ui-phase`（驗證迴圈） | primary |
| gsd-verifier | 通過目標反向分析驗證階段目標的達成情況。 | `/gsd-execute-phase` | primary |
| gsd-nyquist-auditor | 通過生成測試填補奈奎斯特驗證空缺。 | `/gsd-validate-phase` | primary |
| gsd-ui-auditor | 對已實現前端程式碼進行六柱回溯視覺審計。 | `/gsd-ui-review` | primary |
| gsd-codebase-mapper | 探索程式碼庫並撰寫結構化分析文件。 | `/gsd-map-codebase` | primary |
| gsd-debugger | 使用科學方法和持久狀態調查缺陷。 | `/gsd-debug`、`/gsd-verify-work` | primary |
| gsd-user-profiler | 從 8 個維度評分開發者行為。 | `/gsd-profile-user` | primary |
| gsd-doc-writer | 撰寫並更新專案文件。 | `/gsd-docs-update` | primary |
| gsd-doc-verifier | 驗證生成文件中的事實宣告。 | `/gsd-docs-update` | primary |
| gsd-security-auditor | 驗證 PLAN.md 威脅模型中的威脅緩解措施。 | `/gsd-secure-phase` | primary |
| gsd-pattern-mapper | 將新檔案對映到最近似的已有類似檔案；為規劃者撰寫 PATTERNS.md。 | `/gsd-plan-phase`（在研究與規劃之間） | advanced stub |
| gsd-debug-session-manager | 在隔離上下文中執行完整的 `/gsd-debug` 檢查點和續傳迴圈，保持主上下文精簡。 | `/gsd-debug` | advanced stub |
| gsd-code-reviewer | 審查原始檔中的缺陷、安全問題和程式碼品質問題；生成 REVIEW.md。 | `/gsd-code-review` | advanced stub |
| gsd-code-fixer | 以每次修復原子提交的方式應用 REVIEW.md 中的修復；生成 REVIEW-FIX.md。 | `/gsd-code-review --fix` | advanced stub |
| gsd-ai-researcher | 將所選 AI 框架的官方文件研究成可實施的指導（AI-SPEC.md §3–§4b）。 | `/gsd-ai-integration-phase` | advanced stub |
| gsd-domain-researcher | 為 AI 系統提供領域專家評估標準和失效模式（AI-SPEC.md §1b）。 | `/gsd-ai-integration-phase` | advanced stub |
| gsd-eval-planner | 為 AI 階段設計結構化評估策略（AI-SPEC.md §5–§7）。 | `/gsd-ai-integration-phase` | advanced stub |
| gsd-eval-auditor | 對 AI 階段評估覆蓋率進行回溯審計；生成 EVAL-REVIEW.md（COVERED/PARTIAL/MISSING）。 | `/gsd-eval-review` | advanced stub |
| gsd-framework-selector | ≤6 個問題的互動式決策矩陣，為 AI/LLM 框架評分並給出推薦。 | `/gsd-ai-integration-phase` | advanced stub |
| gsd-intel-updater | 撰寫結構化 intel 檔案（`.planning/intel/*.json`），用作可查詢的程式碼庫知識庫。 | `/gsd-map-codebase --query` | advanced stub |
| gsd-doc-classifier | 將單個規劃文件分類為 ADR、PRD、SPEC、DOC 或 UNKNOWN；並行生成以處理文件語料庫。 | `/gsd-ingest-docs` | advanced stub |
| gsd-doc-synthesizer | 將已分類的規劃文件綜合為一個統一上下文，具有優先順序規則、迴圈檢測和三桶衝突報告。 | `/gsd-ingest-docs` | advanced stub |

**覆蓋說明。** `docs/AGENTS.md` 為 21 個主要代理提供了完整角色卡，併為 12 個高階代理提供了簡潔存根。該檔案中的代理工具許可權摘要僅涵蓋主要的 21 個代理；高階代理的工具列表記錄在 `agents/gsd-*.md` 中各代理的 frontmatter 裡。

---

## 命令 (67 shipped)

完整清單位於 `commands/gsd/*.md`。以下分組與 `docs/COMMANDS.md` 的章節順序一致；每行包含命令名稱、從命令 frontmatter `description:` 派生的一行角色描述，以及原始檔連結。`tests/command-count-sync.test.cjs` 將數量鎖定到檔案系統。

### 名稱空間元技能

以下六個路由器是僅包含描述符的條目，模型優先選擇這些條目；每個條目的主體包含一個路由表，指向正確的具體子技能。它們的存在是為了在完整功能面仍可訪問的情況下降低急切技能列舉的令牌成本。請參閱 [#2792](https://github.com/open-gsd/gsd-core/issues/2792) 瞭解原因；路由表指向 [#2790](https://github.com/open-gsd/gsd-core/issues/2790) 合併後的功能面。

| 命令 | 角色 | 原始檔 |
|------|------|--------|
| `/gsd-workflow` | 階段流水線路由器 — 討論 / 規劃 / 執行 / 驗證 / 階段 / 進度。 | [commands/gsd/ns-workflow.md](../../commands/gsd/ns-workflow.md) |
| `/gsd-project` | 專案生命週期路由器 — 里程碑、審計、摘要。 | [commands/gsd/ns-project.md](../../commands/gsd/ns-project.md) |
| `/gsd-quality` | 品質關卡路由器 — 程式碼審查、除錯、審計、安全、評估、UI。 | [commands/gsd/ns-review.md](../../commands/gsd/ns-review.md) |
| `/gsd-context` | 程式碼庫智慧路由器 — 對映、圖形化、文件、學習。 | [commands/gsd/ns-context.md](../../commands/gsd/ns-context.md) |
| `/gsd-manage` | 管理路由器 — 配置、工作區、工作流、執行緒、更新、釋出、收件箱。 | [commands/gsd/ns-manage.md](../../commands/gsd/ns-manage.md) |
| `/gsd-ideate` | 探索與捕獲路由器 — 探索、草圖、尖峰、規格、捕獲。 | [commands/gsd/ns-ideate.md](../../commands/gsd/ns-ideate.md) |

### 核心工作流

| 命令 | 角色 | 原始檔 |
|------|------|--------|
| `/gsd-new-project` | 通過深度上下文收集和 PROJECT.md 初始化新專案。 | [commands/gsd/new-project.md](../../commands/gsd/new-project.md) |
| `/gsd-workspace` | 管理 GSD 工作區 — 建立（`--new`）、列出（`--list`）或移除（`--remove`）隔離的工作區環境。 | [commands/gsd/workspace.md](../../commands/gsd/workspace.md) |
| `/gsd-discuss-phase` | 在規劃前通過自適應提問收集階段上下文。 | [commands/gsd/discuss-phase.md](../../commands/gsd/discuss-phase.md) |
| `/gsd-mvp-phase` | 將階段規劃為垂直 MVP 切片 — 使用者故事、SPIDR 拆分，然後進行階段規劃。 | [commands/gsd/mvp-phase.md](../../commands/gsd/mvp-phase.md) |
| `/gsd-spec-phase` | 蘇格拉底式規格細化，生成包含可證偽需求的 SPEC.md。 | [commands/gsd/spec-phase.md](../../commands/gsd/spec-phase.md) |
| `/gsd-ui-phase` | 為前端階段生成 UI 設計契約（UI-SPEC.md）。 | [commands/gsd/ui-phase.md](../../commands/gsd/ui-phase.md) |
| `/gsd-ai-integration-phase` | 通過框架選擇、研究和評估規劃生成 AI 設計契約（AI-SPEC.md）。 | [commands/gsd/ai-integration-phase.md](../../commands/gsd/ai-integration-phase.md) |
| `/gsd-plan-phase` | 建立帶有驗證迴圈的詳細階段計劃（PLAN.md）。 | [commands/gsd/plan-phase.md](../../commands/gsd/plan-phase.md) |
| `/gsd-plan-review-convergence` | 跨 AI 計劃收斂迴圈 — 根據審查反饋重新規劃，直到沒有 HIGH 級別問題為止（最多 3 個迴圈）。 | [commands/gsd/plan-review-convergence.md](../../commands/gsd/plan-review-convergence.md) |
| `/gsd-ultraplan-phase` | [BETA] 將計劃階段解除安裝到 Claude Code 的 ultraplan 雲端 — 遠端起草，在瀏覽器中審查，通過 `/gsd-import` 匯入回來。僅限 Claude Code。 | [commands/gsd/ultraplan-phase.md](../../commands/gsd/ultraplan-phase.md) |
| `/gsd-spike` | 通過一次性實驗快速驗證想法；使用 `--wrap-up` 將發現打包為持久技能。 | [commands/gsd/spike.md](../../commands/gsd/spike.md) |
| `/gsd-sketch` | 使用一次性 HTML 原型快速勾畫 UI/設計想法；使用 `--wrap-up` 打包發現。 | [commands/gsd/sketch.md](../../commands/gsd/sketch.md) |
| `/gsd-execute-phase` | 使用基於波次的並行化執行階段中的所有計劃。 | [commands/gsd/execute-phase.md](../../commands/gsd/execute-phase.md) |
| `/gsd-verify-work` | 通過自動診斷的對話式 UAT 驗證已構建的功能。 | [commands/gsd/verify-work.md](../../commands/gsd/verify-work.md) |
| `/gsd-ship` | 驗證後建立 PR、執行審查並準備合併。 | [commands/gsd/ship.md](../../commands/gsd/ship.md) |
| `/gsd-fast` | 內聯執行簡單任務 — 無子代理、無規劃開銷。 | [commands/gsd/fast.md](../../commands/gsd/fast.md) |
| `/gsd-quick` | 以 GSD 保證（原子提交、狀態跟蹤）執行快速任務，但跳過可選代理。 | [commands/gsd/quick.md](../../commands/gsd/quick.md) |
| `/gsd-ui-review` | 對已實現前端程式碼進行六柱回溯視覺審計。 | [commands/gsd/ui-review.md](../../commands/gsd/ui-review.md) |
| `/gsd-code-review` | 審查階段中更改的原始檔中的缺陷、安全問題和程式碼品質問題；使用 `--fix` 自動應用發現。 | [commands/gsd/code-review.md](../../commands/gsd/code-review.md) |
| `/gsd-eval-review` | 回溯審計已執行 AI 階段的評估覆蓋率；生成 EVAL-REVIEW.md。 | [commands/gsd/eval-review.md](../../commands/gsd/eval-review.md) |

### 階段與里程碑管理

| 命令 | 角色 | 原始檔 |
|------|------|--------|
| `/gsd-phase` | 階段的增刪改查 — 在 ROADMAP.md 中新增（預設）、插入（`--insert`）、移除（`--remove`）或編輯（`--edit`）階段。 | [commands/gsd/phase.md](../../commands/gsd/phase.md) |
| `/gsd-add-tests` | 根據 UAT 標準和實現，為已完成階段生成測試。 | [commands/gsd/add-tests.md](../../commands/gsd/add-tests.md) |
| `/gsd-validate-phase` | 回溯審計並填補已完成階段的奈奎斯特驗證空缺。 | [commands/gsd/validate-phase.md](../../commands/gsd/validate-phase.md) |
| `/gsd-secure-phase` | 回溯驗證已完成階段的威脅緩解措施。 | [commands/gsd/secure-phase.md](../../commands/gsd/secure-phase.md) |
| `/gsd-audit-milestone` | 在歸檔前根據原始意圖審計里程碑完成情況。 | [commands/gsd/audit-milestone.md](../../commands/gsd/audit-milestone.md) |
| `/gsd-audit-uat` | 跨階段審計所有待處理的 UAT 和驗證專案。 | [commands/gsd/audit-uat.md](../../commands/gsd/audit-uat.md) |
| `/gsd-audit-fix` | 自主審計到修復流水線 — 查詢問題、分類、修復、測試、提交。 | [commands/gsd/audit-fix.md](../../commands/gsd/audit-fix.md) |
| `/gsd-complete-milestone` | 歸檔已完成的里程碑併為下一個版本做準備。 | [commands/gsd/complete-milestone.md](../../commands/gsd/complete-milestone.md) |
| `/gsd-new-milestone` | 啟動新的里程碑週期 — 更新 PROJECT.md 並路由到需求。 | [commands/gsd/new-milestone.md](../../commands/gsd/new-milestone.md) |
| `/gsd-milestone-summary` | 從里程碑產物生成全面的專案摘要。 | [commands/gsd/milestone-summary.md](../../commands/gsd/milestone-summary.md) |
| `/gsd-cleanup` | 歸檔已完成里程碑中積累的階段目錄。 | [commands/gsd/cleanup.md](../../commands/gsd/cleanup.md) |
| `/gsd-manager` | 用於從單個終端管理多個階段的互動式指揮中心。 | [commands/gsd/manager.md](../../commands/gsd/manager.md) |
| `/gsd-workstreams` | 管理並行工作流 — 列出、建立、切換、狀態、進度、完成、恢復。 | [commands/gsd/workstreams.md](../../commands/gsd/workstreams.md) |
| `/gsd-autonomous` | 自主執行所有剩餘階段 — 每個階段依次討論 → 規劃 → 執行。 | [commands/gsd/autonomous.md](../../commands/gsd/autonomous.md) |
| `/gsd-undo` | 安全的 git 回退 — 使用階段清單回滾階段或計劃提交。 | [commands/gsd/undo.md](../../commands/gsd/undo.md) |

### 會話與導航

| 命令 | 角色 | 原始檔 |
|------|------|--------|
| `/gsd-progress` | 檢查專案進度、顯示上下文並路由到下一個操作；使用 `--next` 自動推進或使用 `--do` 執行自由格式任務。 | [commands/gsd/progress.md](../../commands/gsd/progress.md) |
| `/gsd-capture` | 捕獲想法、任務、筆記和種子 — todo（預設）、`--note`、`--backlog`、`--seed` 或 `--list` 待處理 todo。 | [commands/gsd/capture.md](../../commands/gsd/capture.md) |
| `/gsd-stats` | 顯示專案統計資訊 — 階段、計劃、需求、git 指標、時間線。 | [commands/gsd/stats.md](../../commands/gsd/stats.md) |
| `/gsd-pause-work` | 在階段中途暫停工作時建立上下文交接。 | [commands/gsd/pause-work.md](../../commands/gsd/pause-work.md) |
| `/gsd-resume-work` | 從上一個會話恢復工作並完整還原上下文。 | [commands/gsd/resume-work.md](../../commands/gsd/resume-work.md) |
| `/gsd-explore` | 蘇格拉底式構思和想法路由 — 在承諾之前思考想法。 | [commands/gsd/explore.md](../../commands/gsd/explore.md) |
| `/gsd-review-backlog` | 審查並將待辦事項提升到活躍里程碑。 | [commands/gsd/review-backlog.md](../../commands/gsd/review-backlog.md) |
| `/gsd-thread` | 管理用於跨會話工作的持久上下文執行緒。 | [commands/gsd/thread.md](../../commands/gsd/thread.md) |

### 程式碼庫智慧

| 命令 | 角色 | 原始檔 |
|------|------|--------|
| `/gsd-map-codebase` | 使用並行對映代理分析程式碼庫；使用 `--fast` 進行輕量級掃描或使用 `--query` 進行 intel 查詢。 | [commands/gsd/map-codebase.md](../../commands/gsd/map-codebase.md) |
| `/gsd-graphify` | 在 `.planning/graphs/` 中構建、查詢和檢查專案知識圖譜。 | [commands/gsd/graphify.md](../../commands/gsd/graphify.md) |
| `/gsd-extract-learnings` | 從已完成階段產物中提取決策、經驗、模式和意外發現。 | [commands/gsd/extract-learnings.md](../../commands/gsd/extract-learnings.md) |

### 審查、除錯與恢復

| 命令 | 角色 | 原始檔 |
|------|------|--------|
| `/gsd-review` | 通過外部 AI CLI 請求跨 AI 同行審查階段計劃。 | [commands/gsd/review.md](../../commands/gsd/review.md) |
| `/gsd-debug` | 在上下文重置時進行跨會話持久狀態的系統化除錯。 | [commands/gsd/debug.md](../../commands/gsd/debug.md) |
| `/gsd-forensics` | 針對失敗 GSD 工作流的事後調查 — 分析 git、產物、狀態。 | [commands/gsd/forensics.md](../../commands/gsd/forensics.md) |
| `/gsd-health` | 診斷規劃目錄健康狀態並可選擇修復問題。 | [commands/gsd/health.md](../../commands/gsd/health.md) |
| `/gsd-import` | 攝取外部計劃，並與專案決策進行衝突檢測。 | [commands/gsd/import.md](../../commands/gsd/import.md) |
| `/gsd-inbox` | 根據專案模板分類審查所有未處理的 GitHub 問題和 PR。 | [commands/gsd/inbox.md](../../commands/gsd/inbox.md) |

### 文件、使用者檔案與實用工具

| 命令 | 角色 | 原始檔 |
|------|------|--------|
| `/gsd-docs-update` | 生成或更新經程式碼庫驗證的專案文件。 | [commands/gsd/docs-update.md](../../commands/gsd/docs-update.md) |
| `/gsd-ingest-docs` | 掃描倉庫中混合的 ADR/PRD/SPEC/DOC 文件，通過分類、綜合和衝突報告引導或合併到完整的 `.planning/` 設定中。 | [commands/gsd/ingest-docs.md](../../commands/gsd/ingest-docs.md) |
| `/gsd-profile-user` | 生成開發者行為檔案和 Claude 可發現的產物。 | [commands/gsd/profile-user.md](../../commands/gsd/profile-user.md) |
| `/gsd-settings` | 配置 GSD 工作流開關和模型檔案。 | [commands/gsd/settings.md](../../commands/gsd/settings.md) |
| `/gsd-config` | 配置 GSD 設定 — 工作流開關（預設）、高階旋鈕（`--advanced`）、整合（`--integrations`）或模型檔案（`--profile`）。 | [commands/gsd/config.md](../../commands/gsd/config.md) |
| `/gsd-pr-branch` | 通過過濾掉 `.planning/` 提交來建立乾淨的 PR 分支。 | [commands/gsd/pr-branch.md](../../commands/gsd/pr-branch.md) |
| `/gsd-surface` | 切換哪些技能被呈現 — 應用配置檔案、列出或停用叢集而無需重新安裝。 | [commands/gsd/surface.md](../../commands/gsd/surface.md) |
| `/gsd-update` | 將 GSD 更新到最新版本；使用 `--sync` 跨執行時同步技能或使用 `--reapply` 重新應用本地補丁。 | [commands/gsd/update.md](../../commands/gsd/update.md) |
| `/gsd-help` | 顯示可用的 GSD 命令和使用指南。 | [commands/gsd/help.md](../../commands/gsd/help.md) |

---

## 工作流 (88 shipped)

完整清單位於 `get-shit-done/workflows/*.md`。工作流是命令在內部引用的輕量編排器；大多數不由終端使用者直接閱讀。以下行將每個工作流檔案對映到其角色（來源於 `<purpose>` 塊），以及在適用情況下對映到呼叫它的命令。

| 工作流 | 角色 | 呼叫者 |
|--------|------|--------|
| `add-backlog.md` | 使用 999.x 編號將待辦事項新增到 ROADMAP.md。 | `/gsd-capture --backlog` |
| `add-phase.md` | 在路線圖中當前里程碑的末尾新增新的整數階段。 | `/gsd-phase`（預設） |
| `add-tests.md` | 根據已完成階段的產物生成單元測試和 E2E 測試。 | `/gsd-add-tests` |
| `add-todo.md` | 將會話中出現的想法或任務捕獲為結構化 todo。 | `/gsd-capture`（預設） |
| `ai-integration-phase.md` | 將框架選擇 → AI 研究 → 領域研究 → 評估規劃編排為 AI-SPEC.md。 | `/gsd-ai-integration-phase` |
| `analyze-dependencies.md` | 分析 ROADMAP.md 階段的檔案重疊和語義依賴；建議 `Depends on` 邊。 | `/gsd-manager --analyze-deps` |
| `audit-fix.md` | 自主審計到修復流水線 — 執行審計、解析、分類、修復、測試、提交。 | `/gsd-audit-fix` |
| `audit-milestone.md` | 通過聚合階段驗證來驗證里程碑是否滿足完成定義。 | `/gsd-audit-milestone` |
| `audit-uat.md` | 跨階段審計 UAT 和驗證檔案；生成優先排序的待處理事項列表。 | `/gsd-audit-uat` |
| `autonomous.md` | 自主驅動里程碑階段 — 所有剩餘階段、一個範圍或單個階段。 | `/gsd-autonomous` |
| `check-todos.md` | 列出待處理 todo，允許選擇，載入上下文，並路由到適當的操作。 | `/gsd-capture --list` |
| `cleanup.md` | 歸檔已完成里程碑中積累的階段目錄。 | `/gsd-cleanup` |
| `code-review-fix.md` | 通過 gsd-code-fixer 以每次修復原子提交的方式自動修復 REVIEW.md 中的問題。 | `/gsd-code-review --fix` |
| `code-review.md` | 通過 gsd-code-reviewer 審查階段原始碼變更；生成 REVIEW.md。 | `/gsd-code-review` |
| `complete-milestone.md` | 將已釋出版本標記為完成 — MILESTONES.md 條目、PROJECT.md 演進、標籤。 | `/gsd-complete-milestone` |
| `diagnose-issues.md` | 編排並行除錯代理以調查 UAT 差距並找出根本原因。 | `/gsd-verify-work`（自動診斷） |
| `discovery-phase.md` | 以適當的深度級別執行發現。 | `/gsd-new-project`（發現路徑） |
| `discuss-phase-assumptions.md` | 假設模式討論 — 通過以程式碼庫為先的分析提取實施決策。 | `/gsd-discuss-phase`（當 `discuss_mode=assumptions` 時） |
| `discuss-phase-power.md` | 高階使用者討論 — 將所有問題預生成到 JSON 狀態檔案和 HTML UI 中。 | `/gsd-discuss-phase --power` |
| `discuss-phase.md` | 通過迭代灰色地帶討論提取實施決策。 | `/gsd-discuss-phase` |
| `mvp-phase.md` | 將階段規劃為垂直 MVP 切片 — 使用者故事、SPIDR 拆分，然後進行階段規劃。 | `/gsd-mvp-phase` |
| `do.md` | 將使用者的自由格式文本路由到最匹配的 GSD 命令。 | `/gsd-progress --do` |
| `docs-update.md` | 生成、更新和驗證規範的和手寫的專案文件。 | `/gsd-docs-update` |
| `edit-phase.md` | 就地編輯 ROADMAP.md 中現有階段的任何欄位，保留編號和位置。 | `/gsd-phase --edit` |
| `eval-review.md` | 對已實現 AI 階段的評估覆蓋率進行回溯審計。 | `/gsd-eval-review` |
| `execute-phase.md` | 使用基於波次的並行執行方式執行階段中的所有計劃。 | `/gsd-execute-phase` |
| `execute-plan.md` | 執行階段提示（PLAN.md）並建立結果摘要（SUMMARY.md）。 | `execute-phase.md`（每個計劃的子代理） |
| `explore.md` | 蘇格拉底式構思 — 通過探究性問題引導開發者。 | `/gsd-explore` |
| `debug.md` | 系統化除錯 — 子命令路由、會話建立、委託給 gsd-debug-session-manager。 | `/gsd-debug` |
| `extract-learnings.md` | 從已完成階段產物中提取決策、經驗、模式和意外發現。 | `/gsd-extract-learnings` |
| `fast.md` | 內聯執行簡單任務，無子代理開銷。 | `/gsd-fast` |
| `forensics.md` | 針對失敗工作流的取證調查 — git、產物和狀態分析。 | `/gsd-forensics` |
| `graduation.md` | 跨階段聚類 LEARNINGS.md 中的重複項，並顯示 HITL 提升候選項。 | `transition.md`（graduation_scan 步驟） |
| `health.md` | 驗證 `.planning/` 目錄完整性並報告可操作問題。 | `/gsd-health` |
| `help.md` | 顯示完整的 GSD Core 命令參考。 | `/gsd-help` |
| `import.md` | 攝取外部計劃，並與現有專案決策進行衝突檢測。 | `/gsd-import` |
| `inbox.md` | 根據專案貢獻模板分類未處理的 GitHub 問題和 PR。 | `/gsd-inbox` |
| `ingest-docs.md` | 掃描倉庫中混合的規劃文件；分類、綜合，並通過沖突報告引導或合併到 `.planning/` 中。 | `/gsd-ingest-docs` |
| `insert-phase.md` | 為里程碑中途發現的緊急工作插入十進位制階段。 | `/gsd-phase --insert` |
| `list-phase-assumptions.md` | 在規劃前顯示 Claude 對某個階段的假設。 | `/gsd-discuss-phase --assumptions` |
| `list-workspaces.md` | 列出在 `~/gsd-workspaces/` 中找到的所有 GSD 工作區及其狀態。 | `/gsd-workspace --list` |
| `manager.md` | 互動式里程碑指揮中心 — 儀表板、內聯討論、後臺規劃/執行。 | `/gsd-manager` |
| `map-codebase.md` | 編排並行程式碼庫對映代理以生成 `.planning/codebase/` 文件。 | `/gsd-map-codebase` |
| `milestone-summary.md` | 里程碑摘要綜合 — 從里程碑產物生成的入職和審查產物。 | `/gsd-milestone-summary` |
| `new-milestone.md` | 啟動新里程碑週期 — 載入專案上下文、收集目標、更新 PROJECT.md/STATE.md。 | `/gsd-new-milestone` |
| `new-project.md` | 統一的新專案流程 — 提問、研究（可選）、需求、路線圖。 | `/gsd-new-project` |
| `new-workspace.md` | 建立帶有倉庫 worktree/克隆和獨立 `.planning/` 的隔離工作區。 | `/gsd-workspace --new` |
| `next.md` | 檢測當前專案狀態並自動推進到下一個邏輯步驟。 | `/gsd-progress --next` |
| `node-repair.md` | 用於失敗任務驗證的自主修復運算元；由 `execute-plan` 呼叫。 | `execute-plan.md`（恢復） |
| `note.md` | 零摩擦想法捕獲 — 一次 Write 呼叫，一行確認。 | `/gsd-capture --note` |
| `pause-work.md` | 建立結構化的 `.planning/HANDOFF.json` 和 `.continue-here.md` 交接檔案。 | `/gsd-pause-work` |
| `plan-phase.md` | 建立包含整合研究和驗證迴圈的可執行 PLAN.md 檔案。 | `/gsd-plan-phase`、`/gsd-quick` |
| `plan-review-convergence.md` | 跨 AI 計劃收斂迴圈 — 根據審查反饋重新規劃，直到沒有 HIGH 級別問題為止。 | `/gsd-plan-review-convergence` |
| `plant-seed.md` | 將前瞻性想法捕獲為帶有觸發條件的結構化種子檔案。 | `/gsd-capture --seed` |
| `pr-branch.md` | 通過過濾 `.planning/` 提交為 PR 建立乾淨的分支。 | `/gsd-pr-branch` |
| `profile-user.md` | 編排完整的開發者檔案流程 — 同意、會話掃描、檔案生成。 | `/gsd-profile-user` |
| `progress.md` | 進度渲染 — 專案上下文、位置和下一步操作路由。 | `/gsd-progress` |
| `quick.md` | 以 GSD 保證（原子提交、狀態跟蹤）快速執行任務。 | `/gsd-quick` |
| `reapply-patches.md` | GSD 更新後重新應用本地修改。 | `/gsd-update --reapply` |
| `remove-phase.md` | 從路線圖中移除未來的階段並重新編號後續階段。 | `/gsd-phase --remove` |
| `remove-workspace.md` | 移除 GSD 工作區並清理 worktree。 | `/gsd-workspace --remove` |
| `resume-project.md` | 恢復工作 — 從 STATE.md、HANDOFF.json 和產物中完整還原上下文。 | `/gsd-resume-work` |
| `review.md` | 通過外部 CLI 進行跨 AI 計劃審查；生成 REVIEWS.md。 | `/gsd-review` |
| `scan.md` | 快速單焦點程式碼庫掃描 — map-codebase 的輕量替代方案。 | `/gsd-map-codebase --fast` |
| `secure-phase.md` | 對已完成階段進行回溯威脅緩解審計。 | `/gsd-secure-phase` |
| `session-report.md` | 會話報告 — 令牌使用情況、工作摘要、成果。 | `/gsd-pause-work --report` |
| `settings.md` | 配置 GSD 工作流開關和模型檔案。 | `/gsd-settings`、`/gsd-config --profile` |
| `settings-advanced.md` | 配置 GSD 高階使用者旋鈕 — 計劃回彈、超時、分支模板、跨 AI 執行、執行時旋鈕。 | `/gsd-config --advanced` |
| `settings-integrations.md` | 配置第三方 API 金鑰（Brave/Firecrawl/Exa）、`review.models.<cli>` CLI 路由和帶掩碼（`****<last-4>`）顯示的 `agent_skills.<agent-type>` 注入。 | `/gsd-config --integrations` |
| `ship.md` | 驗證後建立 PR、執行審查並準備合併。 | `/gsd-ship` |
| `sketch.md` | 通過一次性 HTML 原型（每次草圖 2-3 個變體）探索設計方向。 | `/gsd-sketch` |
| `sketch-wrap-up.md` | 整理草圖發現並將其打包為持久的 `sketch-findings-[project]` 技能。 | `/gsd-sketch --wrap-up` |
| `spec-phase.md` | 帶歧義評分的蘇格拉底式規格細化；生成 SPEC.md。 | `/gsd-spec-phase` |
| `spike.md` | 通過聚焦的一次性實驗進行快速可行性驗證。 | `/gsd-spike` |
| `spike-wrap-up.md` | 整理尖峰發現並將其打包為持久的 `spike-findings-[project]` 技能。 | `/gsd-spike --wrap-up` |
| `stats.md` | 專案統計資訊渲染 — 階段、計劃、需求、git 指標。 | `/gsd-stats` |
| `sync-skills.md` | 跨執行時 GSD 技能同步 — 跨執行時根目錄差異並應用 `gsd-*` 技能目錄。 | `/gsd-update --sync` |
| `transition.md` | 階段邊界過渡工作流 — 工作流檢查、狀態推進。 | `execute-phase.md`、`/gsd-progress --next` |
| `ui-phase.md` | 通過 gsd-ui-researcher 生成 UI-SPEC.md 設計契約。 | `/gsd-ui-phase` |
| `ui-review.md` | 通過 gsd-ui-auditor 進行六柱回溯視覺審計。 | `/gsd-ui-review` |
| `ultraplan-phase.md` | [BETA] 將規劃解除安裝到 Claude Code 的 ultraplan 雲端；遠端起草並通過 `/gsd-import` 匯入回來。 | `/gsd-ultraplan-phase` |
| `undo.md` | 安全的 git 回退 — 使用階段清單回滾階段或計劃提交。 | `/gsd-undo` |
| `thread.md` | 為跨會話工作建立、列出、關閉或恢復持久上下文執行緒。 | `/gsd-thread` |
| `update.md` | 將 GSD 更新到最新版本並顯示變更日誌。 | `/gsd-update` |
| `validate-phase.md` | 回溯審計並填補已完成階段的奈奎斯特驗證空缺。 | `/gsd-validate-phase` |
| `verify-phase.md` | 通過目標反向分析驗證階段目標的達成情況。 | `execute-phase.md`（執行後） |
| `verify-work.md` | 帶自動診斷的對話式 UAT — 生成 UAT.md 和修復計劃。 | `/gsd-verify-work` |

> **注意：** 某些工作流沒有直接面向用戶的命令（例如 `execute-plan.md`、`verify-phase.md`、`transition.md`、`node-repair.md`、`diagnose-issues.md`）— 它們由編排器工作流在內部呼叫。`discovery-phase.md` 是 `/gsd-new-project` 的備用入口。

---

## 參考資料 (62 shipped)

完整清單位於 `get-shit-done/references/*.md`。參考資料是工作流和代理 `@-reference` 的共享知識文件。以下分組與 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#references-get-shit-donereferencesmd) 一致 — 核心、工作流、思維模型叢集和模組化規劃器分解。

### 核心參考資料

| 參考資料 | 角色 |
|----------|------|
| `checkpoints.md` | 檢查點型別定義和互動模式。 |
| `gates.md` | 4 種規範關卡型別（Confirm、Quality、Safety、Transition），已連線到 plan-checker 和 verifier。 |
| `model-profiles.md` | 每個代理的模型層級分配。 |
| `model-profile-resolution.md` | 模型解析演算法文件。 |
| `verification-patterns.md` | 如何驗證不同的產物型別。 |
| `verification-overrides.md` | 每種產物的驗證覆蓋規則。 |
| `planning-config.md` | 完整的配置模式和行為。 |
| `git-integration.md` | Git 提交、分支和歷史模式。 |
| `git-planning-commit.md` | 規劃目錄提交約定。 |
| `questioning.md` | 專案初始化的夢想提取哲學。 |
| `tdd.md` | 測試驅動開發整合模式。 |
| `ui-brand.md` | 視覺輸出格式模式。 |
| `common-bug-patterns.md` | 程式碼審查和驗證的常見缺陷模式。 |
| `debugger-philosophy.md` | 由 `gsd-debugger` 載入的長青除錯準則。 |
| `mandatory-initial-read.md` | 注入到代理提示中的共享必讀樣板文本。 |
| `project-skills-discovery.md` | 注入到代理提示中的共享專案技能發現樣板文本。 |

### 工作流參考資料

| 參考資料 | 角色 |
|----------|------|
| `agent-contracts.md` | 編排器與代理之間的正式介面。 |
| `context-budget.md` | 上下文視窗預算分配規則。 |
| `continuation-format.md` | 會話續傳/恢復格式。 |
| `domain-probes.md` | discuss-phase 的領域特定探究問題。 |
| `gate-prompts.md` | 關卡/檢查點提示模板。 |
| `scout-codebase.md` | discuss-phase 偵察步驟的階段型別→程式碼庫對映選擇表（通過 #2551 提取）。 |
| `revision-loop.md` | 計劃修訂迭代模式。 |
| `universal-anti-patterns.md` | 需要檢測和避免的通用反模式。 |
| `worktree-path-safety.md` | Worktree 守衛套件：HEAD 斷言、cwd 漂移哨兵（步驟 0a，#3097）和絕對路徑守衛（步驟 0b，#3099）— 通過 `<execution_context>` 載入到執行器生成提示中。 |
| `artifact-types.md` | 規劃產物型別定義。 |
| `phase-argument-parsing.md` | 階段引數解析約定。 |
| `decimal-phase-calculation.md` | 十進位制子階段編號規則。 |
| `workstream-flag.md` | 工作流活躍指標約定（`--ws`）。 |
| `user-profiling.md` | 使用者行為檔案檢測啟發式方法。 |
| `thinking-partner.md` | 決策點處的條件性思維夥伴啟用。 |
| `autonomous-smart-discuss.md` | 自主模式的智慧討論邏輯。 |
| `ios-scaffold.md` | iOS 應用程式腳手架模式。 |
| `ai-evals.md` | `/gsd-ai-integration-phase` 的 AI 評估設計參考。 |
| `ai-frameworks.md` | `gsd-framework-selector` 的 AI 框架決策矩陣參考。 |
| `executor-examples.md` | gsd-executor 代理的已完成示例。 |
| `doc-conflict-engine.md` | 攝取/匯入工作流的共享衝突檢測契約。 |
| `execute-mvp-tdd.md` | MVP+TDD 模式下 execute-phase 的執行時關卡語義 — 任務前失敗測試驗證、階段結束阻塞性審查。 |
| `mvp-concepts.md` | 六個 MVP 相關參考檔案的交叉引用索引；將每個檔案對映到其目的和載入它的工作流。 |
| `verify-mvp-mode.md` | MVP 模式階段的 UAT 框架規則 — 使用者流程優先排序、延遲技術檢查、使用者故事格式守衛。 |

### 草圖參考資料

`/gsd-sketch` 工作流及其收尾配套使用的參考資料。

| 參考資料 | 角色 |
|----------|------|
| `sketch-interactivity.md` | 使 HTML 草圖感覺互動性強且富有活力的規則。 |
| `sketch-theme-system.md` | 用於跨草圖一致性的共享 CSS 主題變數系統。 |
| `sketch-tooling.md` | 每個草圖中包含的浮動工具欄實用工具。 |
| `sketch-variant-patterns.md` | 多變體 HTML 模式（標籤頁、並排、疊加層）。 |

### 思維模型參考資料

將思維類模型（o3、o4-mini、Gemini 2.5 Pro）整合到 GSD 工作流中的參考資料。

| 參考資料 | 角色 |
|----------|------|
| `thinking-models-debug.md` | 用於除錯工作流的思維模型模式。 |
| `thinking-models-execution.md` | 用於執行代理的思維模型模式。 |
| `thinking-models-planning.md` | 用於規劃代理的思維模型模式。 |
| `thinking-models-research.md` | 用於研究代理的思維模型模式。 |
| `thinking-models-verification.md` | 用於驗證代理的思維模型模式。 |

### 模組化規劃器分解

`gsd-planner` 代理被分解為一個核心代理加上參考模組，以適應執行時字元限制。

| 參考資料 | 角色 |
|----------|------|
| `planner-antipatterns.md` | 規劃器反模式和特異性示例。 |
| `planner-chunked.md` | 分塊模式返回格式（`## OUTLINE COMPLETE`、`## PLAN COMPLETE`），用於緩解 Windows stdio 掛起問題。 |
| `planner-gap-closure.md` | 間隙閉合模式行為（讀取 VERIFICATION.md，有針對性地重新規劃）。 |
| `planner-reviews.md` | 跨 AI 審查整合（讀取來自 `/gsd-review` 的 REVIEWS.md）。 |
| `planner-revision.md` | 迭代細化的計劃修訂模式。 |
| `planner-source-audit.md` | 規劃器原始碼審計和許可權限制規則。 |
| `planner-mvp-mode.md` | MVP 模式的垂直切片規劃規則。 |
| `planner-human-verify-mode.md` | `workflow.human_verify_mode = end-of-phase` 的規則：抑制 `checkpoint:human-verify` 任務發射，並通過 `<verify><human-check>` 路由延遲的專案。 |
| `planner-graphify-auto-update.md` | `load_graph_context` 如何在現有陳舊性註釋旁邊顯示 `.last-build-status.json` 自動更新狀態（執行中/失敗/陳舊頭部）。通過 `graphify.auto_update` 選擇啟用（#3347）。 |
| `planner-interface-context.md` | 執行器的介面上下文規則 — 如何從現有程式碼中提取關鍵介面/型別/匯出，並記錄下遊計劃將使用的新介面。 |
| `skeleton-template.md` | 為新專案行走骨架（階段 1 + `--mvp`）生成的 SKELETON.md 模板。 |
| `user-story-template.md` | MVP 規劃的使用者故事格式 — "作為 / 我想要 / 以便" 結構化欄位。 |
| `spidr-splitting.md` | 用於在 MVP 模式下處理大型使用者故事的 SPIDR 拆分分解規則。 |

> **子目錄：** `get-shit-done/references/few-shot-examples/` 包含額外的少樣本示例（`plan-checker.md`、`verifier.md`），這些示例從特定代理中引用。它們不計入 62 個頂級參考資料。

---

## CLI 模組 (81 shipped)

完整清單：`get-shit-done/bin/lib/*.cjs`。

| 模組 | 職責 |
|------|------|
| `active-workstream-store.cjs` | 工作流來源優先順序和選擇（CLI `--ws` > `GSD_WORKSTREAM` 環境變數 > 儲存的指標）；名稱驗證和環境傳播 |
| `adr-parser.cjs` | 用於 plan-phase 攝取快速路徑的 ADR 決策解析器；規範化章節同義詞，解析狀態/決策/範圍圍欄，並強制執行狀態拒絕關卡 |
| `agent-command-router.cjs` | `gsd-tools agent` 的輕量 CJS 子命令路由介面卡 |
| `artifacts.cjs` | 規範產物登錄檔 — 已知的 `.planning/` 根檔名；被 `gsd-health` W019 lint 使用 |
| `audit.cjs` | 審計分發、審計開放會話、審計儲存幫助器 |
| `check-command-router.cjs` | `gsd-tools check` 的輕量 CJS 子命令路由介面卡 |
| `cjs-command-router-adapter.cjs` | 清單支援的 CJS 命令族路由器的共享相容性介面卡 |
| `clock.cjs` | 用於確定性鎖測試的可注入時鐘接縫（now/sleep） |
| `clusters.cjs` | 執行時 surface 模組的技能叢集定義（ADR-0011 階段 2） |
| `code-review-flags.cjs` | `/gsd:code-review` 的型別化標誌解析器；匯出 `parseCodeReviewFlags(argv)`（→ `{ fix, all, auto, depth, files }`）和 `resolveCodeReviewWorkflow(flags)`（→ `'code-review.md' \| 'code-review-fix.md'`）；`--fix`/`--all`/`--auto` 路由的規範分發接縫 |
| `command-aliases.cjs` | 清單支援的族路由器的別名/子命令後設資料 |
| `command-arg-projection.cjs` | 跨命令族路由器共享的型別化標誌和位置引數投影幫助器 |
| `command-routing-hub.cjs` | 純結果分發中心，集中了所有命令族路由器的模式決策（SDK vs CJS）、錯誤分類和無丟擲契約（#3788） |
| `commands.cjs` | 雜項 CLI 命令（slug、時間戳、todo、腳手架、統計資訊） |
| `config-schema.cjs` | `VALID_CONFIG_KEYS` 和動態鍵模式的單一真實來源；由驗證器和 config-schema-docs 奇偶性測試匯入 |
| `config.cjs` | `config.json` 讀寫、章節初始化；從 `config-schema.cjs` 匯入驗證器 |
| `config-types.cjs` | `model_policy` 配置塊的 TypeScript 型別定義 — `ModelPolicyConfig`、`TierEntry`、`RuntimeTiers`；在釋出時從 `src/config-types.cts` 編譯（ADR-457） |
| `configuration.cjs` | 配置模組 — 規範的配置載入、舊版鍵規範化、預設值合併和顯式磁碟遷移；SDK 和 CJS 消費者的真實來源 |
| `context-utilization.cjs` | `gsd-health --context` 的純分類器 — 根據 60%/70% 斷裂點閾值將（tokensUsed, contextWindow）轉換為 `{ percent, state }` 分類結果（#2792） |
| `core.cjs` | 錯誤處理、輸出格式化、共享工具、執行時回退；規劃工作區幫助器的相容性重新匯出 |
| `decisions.cjs` | 解析 CONTEXT.md `<decisions>` 塊；接受數字（D-42）和字母數字（D-INFRA-01）ID；返回 `{id, text, category, tags, trackable}` |
| `docs.cjs` | 文件更新工作流初始化、Markdown 掃描、單體倉庫檢測 |
| `drift.cjs` | 執行後代碼庫結構漂移檢測器（#2003）：將檔案更改分類為新目錄/桶/遷移/路由類別，並迴圈處理 `last_mapped_commit` frontmatter |
| `fallow-runner.cjs` | `/gsd-code-review` 的 fallow 審計介面卡：二進位制解析（`PATH` 然後 `node_modules/.bin`）、可操作的缺少二進位制錯誤和結構性發現規範化 |
| `frontmatter.cjs` | YAML frontmatter 增刪改查操作 |
| `gap-checker.cjs` | 規劃後間隙分析（#2493）：REQUIREMENTS.md + CONTEXT.md 決策 vs PLAN.md 覆蓋率報告（`gsd-tools gap-analysis`） |
| `graphify.cjs` | `/gsd-graphify` 的知識圖譜構建/查詢/狀態/差異 |
| `gsd2-import.cjs` | `/gsd-import --from-gsd2` 的外部計劃攝取 |
| `init-command-router.cjs` | `gsd-tools init` 的輕量 CJS 子命令路由介面卡 |
| `init.cjs` | 每種工作流型別的複合上下文載入 |
| `install-profiles.cjs` | `--minimal` 安裝的安裝配置檔案允許列表和技能暫存（#2762）；哪些 `gsd-*` 技能/代理落入執行時配置目錄的單一真實來源 |
| `installer-migration-authoring.cjs` | 記錄後設資料、顯式範圍、所有權證據和執行時契約引用的安裝程式遷移創作守衛 |
| `installer-migration-report.cjs` | 安裝/更新整合的安裝程式遷移報告投影和阻止操作守衛 |
| `installer-migrations.cjs` | 安裝程式遷移規劃、產物分類、安裝狀態持久化、日誌化應用和回滾幫助器 |
| `intel.cjs` | 支援 `/gsd-map-codebase --query` 和 `gsd-intel-updater` 的程式碼庫 intel 儲存 |
| `learnings.cjs` | `/gsd-extract-learnings` 的跨階段學習提取 |
| `milestone.cjs` | 里程碑歸檔、需求標記 |
| `model-catalog.cjs` | 共享模型目錄 JSON 上的 CJS 介面卡；匯出所有 CLI 消費者的規範執行時層級預設值、代理配置檔案對映、別名對映和路由後設資料 |
| `model-profiles.cjs` | 源自 `model-catalog.cjs` 的向後相容配置檔案幫助器；不再擁有自己的模型表 |
| `package-identity.cjs` | GSD 已釋出包座標（npm 名稱、bin 名稱、倉庫 slug、變更日誌 URL、手動安裝命令）的生成單一來源，源自 package.json；由更新工作程序、`check-latest-version` 和安裝程式讀取（#498） |
| `phase-command-router.cjs` | `gsd-tools phase` 的輕量 CJS 子命令路由介面卡 |
| `phase-lifecycle.cjs` | 從 phase-lifecycle SDK 處理程序中提取的純計算階段生命週期幫助器 |
| `phase.cjs` | 階段目錄操作、十進位制編號、計劃索引 |
| `phases-command-router.cjs` | `gsd-tools phases` 的輕量 CJS 子命令路由介面卡 |
| `plan-scan.cjs` | 用於檢測平面和巢狀佈局中計劃和摘要檔案的規範階段計劃掃描器（k014） |
| `planning-workspace.cjs` | 規劃路徑/工作流接縫（`planningDir`、`planningPaths`、活躍工作流路由、`.planning/.lock` 編排） |
| `project-root.cjs` | 使用四種啟發式方法從起始目錄解析專案根目錄（自己的 `.planning/` 守衛、`sub_repos` 配置、`multiRepo` 標誌、`.git` 啟發式） |
| `profile-output.cjs` | 檔案渲染、USER-PROFILE.md 和 dev-preferences.md 生成 |
| `profile-pipeline.cjs` | 使用者行為檔案資料流水線、會話檔案掃描 |
| `prompt-budget.cjs` | 審查提示的純令牌預算核算 — 估算令牌，應用確定性修剪優先順序（縮減 PROJECT.md 頭部、按比例截斷計劃、刪除上下文/研究/需求、硬失敗守衛），返回 `review.max_prompt_tokens` 的結構化後設資料（#3081） |
| `review-reviewer-selection.cjs` | `/gsd-review` 預設審查者策略和優先順序的審查者選擇/規範化幫助器 |
| `roadmap-command-router.cjs` | `gsd-tools roadmap` 的輕量 CJS 子命令路由介面卡 |
| `roadmap-upgrade.cjs` | 將舊版 `Phase N` 條目轉換為里程碑字首 `Phase M-NN` 約定的遷移工具；`computeMigrationPlan` + `applyMigration`，預設為試執行並具有原子回滾 |
| `roadmap.cjs` | ROADMAP.md 解析、階段提取、計劃進度 |
| `runtime-artifact-layout.cjs` | 執行時產物佈局模組 — 解析每個受支援執行時的產物目錄形狀（命令、代理、技能）；每個執行時產物放置的單一真實來源（#3663） |
| `runtime-name-policy.cjs` | 執行時名稱規範化策略 — 用於路徑構建和顯示的執行時識別符號的規範令牌清理 |
| `runtime-homes.cjs` | 規範的執行時 → 全域性配置/技能目錄對映；對所有 15 個執行時的一流支援，包括 Hermes 巢狀佈局和 Cline 基於規則的排除（#3126） |
| `runtime-slash.cjs` | 執行時感知的斜槓命令格式化器 — 在面向使用者的輸出和持久化產物中發出 `/gsd-<cmd>`（基於技能的執行時）和 `$gsd-<cmd>`（codex）的單一真實來源（#3584） |
| `schema-detect.cjs` | ORM 模式的模式漂移檢測（Prisma、Drizzle、Supabase、TypeORM、Payload）；匯出 `detectSchemaFiles`、`detectSchemaOrm`、`checkSchemaDrift`、`SCHEMA_PATTERNS`、`ORM_INFO` |
| `secrets.cjs` | 整合金鑰的金鑰配置掩碼約定（`****<last-4>`）；匯出 `SECRET_CONFIG_KEYS`、`isSecretKey`、`maskSecret`、`maskIfSecret` |
| `semver-compare.cjs` | 共享 semver 比較策略幫助器（`compareSemverCore`、穩定三元組驗證、規範化元組解析），由更新檢查鉤子、statusline 開發安裝檢測和變更集提取範圍邏輯使用（#10） |
| `security.cjs` | 路徑遍歷防護、提示注入檢測、安全 JSON/shell 幫助器 |
| `shell-command-projection.cjs` | 託管鉤子序列化的執行時感知 shell 命令投影：根據執行時/平臺決定 PowerShell 呼叫運算子使用，並規範化 Windows 指令碼路徑令牌 |
| `state-command-router.cjs` | `gsd-tools state` 的輕量 CJS 子命令路由介面卡 |
| `state.cjs` | STATE.md 解析、更新、進度推進、指標 |
| `state-document.cjs` | 純 STATE.md 欄位提取、替換、狀態規範化和進度計算轉換 |
| `surface.cjs` | 執行時 surface 模組 — 獨立於安裝時配置檔案標記管理執行時啟用/停用 surface 狀態（ADR-0011 階段 2） |
| `task-command-router.cjs` | `gsd-tools task` 的輕量 CJS 子命令路由介面卡 |
| `template.cjs` | 帶變數替換的模板選擇和填充 |
| `uat.cjs` | UAT 檔案解析、驗證債務跟蹤、audit-uat 支援 |
| `ui-safety-gate.cjs` | 無 shell 的詞邊界 UI 令牌檢測器（#3706，#3718）；從 stdin 讀取階段章節文本，退出 0（找到 UI）或 1（未找到 UI）；也部署到 `get-shit-done/bin/lib/`，以便 GSD 安裝程式將其傳送到 `$RUNTIME_DIR`（#448） |
| `update-context.cjs` | `/gsd:update` 的純安裝上下文解析器 — 從 update.md bash 移植的執行時/範圍/配置目錄/版本檢測（LOCAL/GLOBAL/UNKNOWN）；支援 `gsd-tools update-context`（#498） |
| `validate-command-router.cjs` | `gsd-tools validate` 的輕量 CJS 子命令路由介面卡 |
| `validate.cjs` | 純階段變體規範化幫助器（`phaseVariants`、`buildRoadmapPhaseVariants`、`buildNotStartedPhaseVariants`），被 `verify.cjs` 用於 W006/W007 檢查；無 I/O，無非同步 |
| `verify-command-router.cjs` | `gsd-tools verify` 的輕量 CJS 子命令路由介面卡 |
| `verify.cjs` | 計劃結構、階段完整性、參考、提交驗證 |
| `workstream-inventory-builder.cjs` | 純工作流清單投影構建器 |
| `workstream-inventory.cjs` | 共享工作流清單投影：狀態欄位、階段/計劃/摘要計數、路線圖階段計數和活躍標記 — 將純投影委託給 `workstream-inventory-builder.cjs` 的輕量編排器 |
| `workstream-name-policy.cjs` | 規範的工作流名稱驗證（`isValidActiveWorkstreamName`、`hasInvalidPathSegment`、`validateWorkstreamName`）和 slug 規範化（`toWorkstreamSlug`） |
| `workstream.cjs` | 工作流增刪改查、遷移、會話作用域活躍指標 |
| `worktree-safety.cjs` | Worktree 根目錄解析和非破壞性清理策略決策；擁有 W017 健康檢查邏輯 |

[`docs/CLI-TOOLS.md`](CLI-TOOLS.md) 可能描述這些模組的子集；當其與檔案系統不一致時，本表和目錄清單為準。

---

## 鉤子 (14 shipped)

完整清單：`hooks/`。

| 鉤子 | 事件 | 目的 |
|------|------|------|
| `gsd-statusline.js` | `statusLine` | 顯示模型、任務、目錄、上下文使用情況 |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | 在剩餘 35%/25% 時注入面向代理的上下文警告 |
| `gsd-check-update.js` | `SessionStart` | 後臺檢查新的 GSD 版本 |
| `gsd-check-update-worker.js` | （工作程序） | check-update 的後臺工作程序幫助器 |
| `gsd-update-banner.js` | `SessionStart` | 當未使用 GSD statusline 時選擇性地顯示更新可用橫幅（PR #2795） |
| `gsd-prompt-guard.js` | `PreToolUse` | 掃描 `.planning/` 寫入中的提示注入模式（建議性） |
| `gsd-workflow-guard.js` | `PreToolUse` | 檢測 GSD 工作流上下文之外的檔案編輯（建議性，可選啟用） |
| `gsd-read-guard.js` | `PreToolUse` | 防止對未讀檔案執行 Edit/Write 的建議性守衛 |
| `gsd-read-injection-scanner.js` | `PostToolUse` | 掃描工具 Read 結果中的提示注入模式（v1.36+，PR #2201） |
| `gsd-worktree-path-guard.js` | `PreToolUse` | 硬性阻止對 worktree 根目錄之外絕對路徑執行 Edit/Write/MultiEdit（PR #579，#260） |
| `gsd-session-state.sh` | `PostToolUse` | 基於 shell 執行時的會話狀態跟蹤 |
| `gsd-validate-commit.sh` | `PostToolUse` | 常規提交強制執行的提交驗證 |
| `gsd-phase-boundary.sh` | `PostToolUse` | 工作流過渡的階段邊界檢測 |
| `gsd-graphify-update.sh` | `PostToolUse` | 在主 HEAD 推進後自動重建知識圖譜（可選啟用，預設關閉 — #3347） |

---

## 維護

- 當新的命令、代理、工作流、參考資料、CLI 模組或鉤子釋出時，請在釋出前更新此處對應的章節。
- `tests/` 下的漂移守衛測試（參見上方的"使用說明"）斷言每個已釋出檔案都在此清單中列舉。未在此處有對應行的新檔案將導致 CI 失敗。
- 當檔案系統與 `docs/ARCHITECTURE.md` 的數量或精選子集文件（例如 `docs/AGENTS.md` 的主要名冊）不一致時，本檔案為準。

## 相關資料

- [命令](COMMANDS.md) — 面向使用者的命令參考
- [架構](ARCHITECTURE.md) — 功能面如何協同工作
- [文件索引](README.md)
