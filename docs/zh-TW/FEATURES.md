# GSD 功能參考

> GSD Core 的功能索引與參考文件。架構細節請參見[架構文件](ARCHITECTURE.md)。命令語法請參見[命令參考](COMMANDS.md)。返回[文件索引](README.md)。

---

## 目錄

- [核心功能](#core-features)
  - [專案初始化](#1-project-initialization)
  - [階段討論](#2-phase-discussion)
  - [UI 設計契約](#3-ui-design-contract)
  - [階段規劃](#4-phase-planning)
  - [階段執行](#5-phase-execution)
  - [工作驗收](#6-work-verification)
  - [UI 審查](#7-ui-review)
  - [里程碑管理](#8-milestone-management)
- [規劃功能](#planning-features)
  - [階段管理](#9-phase-management)
  - [快速模式](#10-quick-mode)
  - [自主模式](#11-autonomous-mode)
  - [自由路由](#12-freeform-routing)
  - [筆記捕獲](#13-note-capture)
  - [自動推進 (Next)](#14-auto-advance-next)
- [品質保障功能](#quality-assurance-features)
  - [Nyquist 驗證](#15-nyquist-validation)
  - [計劃檢查](#16-plan-checking)
  - [執行後驗證](#17-post-execution-verification)
  - [節點修復](#18-node-repair)
  - [健康驗證](#19-health-validation)
  - [跨階段迴歸門控](#20-cross-phase-regression-gate)
  - [需求覆蓋門控](#21-requirements-coverage-gate)
- [上下文工程功能](#context-engineering-features)
  - [上下文視窗監控](#22-context-window-monitoring)
  - [會話管理](#23-session-management)
  - [會話報告](#24-session-reporting)
  - [多智慧體編排](#25-multi-agent-orchestration)
  - [模型配置](#26-model-profiles)
- [棕地功能](#brownfield-features)
  - [程式碼庫對映](#27-codebase-mapping)
- [實用功能](#utility-features)
  - [除錯系統](#28-debug-system)
  - [待辦事項管理](#29-todo-management)
  - [統計儀表板](#30-statistics-dashboard)
  - [更新系統](#31-update-system)
  - [設定管理](#32-settings-management)
  - [測試生成](#33-test-generation)
- [基礎設施功能](#infrastructure-features)
  - [Git 整合](#34-git-integration)
  - [CLI 工具](#35-cli-tools)
  - [多執行時支援](#36-multi-runtime-support)
  - [鉤子系統](#37-hook-system)
  - [開發者畫像](#38-developer-profiling)
  - [執行加固](#39-execution-hardening)
  - [驗證債務追蹤](#40-verification-debt-tracking)
- [v1.27 功能](#v127-features)
  - [快速模式](#41-fast-mode)
  - [跨 AI 同行評審](#42-cross-ai-peer-review)
  - [待辦停車場](#43-backlog-parking-lot)
  - [持久化上下文執行緒](#44-persistent-context-threads)
  - [PR 分支過濾](#45-pr-branch-filtering)
  - [安全加固](#46-security-hardening)
  - [多倉庫工作區支援](#47-multi-repo-workspace-support)
  - [討論審計追蹤](#48-discussion-audit-trail)
- [v1.28 功能](#v128-features)
  - [取證分析](#49-forensics)
  - [里程碑摘要](#50-milestone-summary)
  - [工作流名稱空間](#51-workstream-namespacing)
  - [管理儀表板](#52-manager-dashboard)
  - [假設討論模式](#53-assumptions-discussion-mode)
  - [UI 階段自動檢測](#54-ui-phase-auto-detection)
  - [多執行時安裝選擇](#55-multi-runtime-installer-selection)
- [v1.29 功能](#v129-features)
  - [Windsurf 執行時支援](#56-windsurf-runtime-support)
  - [國際化文件](#57-internationalized-documentation)
- [v1.31 功能](#v131-features)
  - [Schema 漂移檢測](#59-schema-drift-detection)
  - [安全強制執行](#60-security-enforcement)
  - [文件生成](#61-documentation-generation)
  - [討論鏈模式](#62-discuss-chain-mode)
  - [單階段自主執行](#63-single-phase-autonomous)
  - [範圍縮減檢測](#64-scope-reduction-detection)
  - [宣告來源標記](#65-claim-provenance-tagging)
  - [工作樹切換](#66-worktree-toggle)
  - [專案程式碼字首](#67-project-code-prefixing)
  - [Claude Code 技能遷移](#68-claude-code-skills-migration)
- [v1.32 功能](#v132-features)
  - [STATE.md 一致性門控](#69-statemd-consistency-gates)
  - [自主 `--to N` 標誌](#70-autonomous---to-n-flag)
  - [研究門控](#71-research-gate)
  - [驗證器里程碑範圍過濾](#72-verifier-milestone-scope-filtering)
  - [編輯前讀取守護鉤子](#73-read-before-edit-guard-hook)
  - [上下文壓縮](#74-context-reduction)
  - [討論階段 `--power` 標誌](#75-discuss-phase---power-flag)
  - [除錯 `--diagnose` 標誌](#76-debug---diagnose-flag)
  - [階段依賴分析](#77-phase-dependency-analysis)
  - [反模式嚴重級別](#78-anti-pattern-severity-levels)
  - [方法論構件型別](#79-methodology-artifact-type)
  - [規劃器可達性檢查](#80-planner-reachability-check)
  - [Playwright-MCP UI 驗證](#81-playwright-mcp-ui-verification)
  - [暫停工作擴充套件](#82-pause-work-expansion)
  - [響應語言配置](#83-response-language-config)
  - [手動更新流程](#84-manual-update-procedure)
  - [新執行時支援（Trae、Cline、Augment Code）](#85-new-runtime-support-trae-cline-augment-code)
  - [自主 `--interactive` 標誌](#86-autonomous---interactive-flag)
  - [提交文件守護鉤子](#87-commit-docs-guard-hook)
  - [社群鉤子選項](#88-community-hooks-opt-in)
- [v1.34.0 功能](#v1340-features)
  - [全域性學習儲存](#89-global-learnings-store)
  - [可查詢程式碼庫智慧](#90-queryable-codebase-intelligence)
  - [執行上下文配置](#91-execution-context-profiles)
  - [門控分類](#92-gates-taxonomy)
  - [程式碼審查流水線](#93-code-review-pipeline)
  - [蘇格拉底式探索](#94-socratic-exploration)
  - [安全撤銷](#95-safe-undo)
  - [計劃匯入](#96-plan-import)
  - [快速程式碼庫掃描](#97-rapid-codebase-scan)
  - [自主審計修復](#98-autonomous-audit-to-fix)
  - [改進的提示注入掃描器](#99-improved-prompt-injection-scanner)
  - [規劃階段停滯檢測](#100-stall-detection-in-plan-phase)
  - [/gsd-progress --next 中的硬停止安全門控](#101-hard-stop-safety-gates-in-gsd-progress---next)
  - [自適應模型預設](#102-adaptive-model-preset)
  - [合併後 Hunk 驗證](#103-post-merge-hunk-verification)
- [v1.35.0 功能](#v1350-features)
  - [新執行時支援（Cline、CodeBuddy、Qwen Code）](#104-new-runtime-support-cline-codebuddy-qwen-code)
  - [GSD-2 反向遷移](#105-gsd-2-reverse-migration)
  - [AI 整合階段嚮導](#106-ai-integration-phase-wizard)
  - [AI 評估審查](#107-ai-eval-review)
- [v1.36.0 功能](#v1360-features)
  - [計劃彈跳](#108-plan-bounce)
  - [外部程式碼審查命令](#109-external-code-review-command)
  - [跨 AI 執行委託](#110-cross-ai-execution-delegation)
  - [架構職責對映](#111-architectural-responsibility-mapping)
  - [提取學習成果](#112-extract-learnings)
  - [上下文視窗感知提示精簡](#114-context-window-aware-prompt-thinning)
  - [可配置的 CLAUDE.md 路徑](#115-configurable-claudemd-path)
  - [TDD 流水線模式](#116-tdd-pipeline-mode)
- [v1.37.0 功能](#v1370-features)
  - [Spike 命令](#117-spike-command)
  - [Sketch 命令](#118-sketch-command)
  - [智慧體大小預算強制](#119-agent-size-budget-enforcement)
  - [共享樣板提取](#120-shared-boilerplate-extraction)
  - [知識圖譜整合](#121-knowledge-graph-integration)
- [v1.40.0 功能](#v1400-features)
  - [技能介面整合](#122-skill-surface-consolidation)
  - [名稱空間元技能（兩階段路由）](#123-namespace-meta-skills-two-stage-routing)
  - [上下文視窗利用率守護](#124-context-window-utilization-guard)
  - [階段生命週期狀態行讀取側](#125-phase-lifecycle-status-line-read-side)
- [v1.41.0 功能](#v1410-features)
  - [按階段型別選擇模型](#126-per-phase-type-model-selection)
  - [帶失敗層級升級的動態路由](#127-dynamic-routing-with-failure-tier-escalation)
  - [更新橫幅選項](#128-update-banner-opt-in)
  - [Issue 驅動編排指南](#129-issue-driven-orchestration-guide)
  - [Graphify 基於提交的過期檢測](#130-graphify-commit-based-staleness)
- [v1.42.1 功能](#v1421-features)
  - [包合法性門控](#132-package-legitimacy-gate)
  - [技能介面預算](#133-skill-surface-budgeting)
  - [安裝遷移](#134-installer-migrations)
  - [自定義 Ship PR 正文節區](#135-custom-ship-pr-body-sections)
  - [評審預設審查者](#136-review-default-reviewers)
  - [Fallow 結構性審查預處理](#137-fallow-structural-review-pre-pass)
  - [階段末人工驗證模式](#138-end-of-phase-human-verification-mode)
  - [配額與速率限制失敗分類](#139-quota-and-rate-limit-failure-classification)
  - [狀態列上下文位置](#140-statusline-context-position)
  - [里程碑標籤建立開關](#141-milestone-tag-creation-toggle)
  - [結構化 JSON 錯誤模式](#142-structured-json-error-mode)

---

## 核心功能

### 1. 專案初始化

**命令：** `/gsd-new-project [--auto @file.md]`

**目的：** 將使用者想法轉化為具有研究支撐、範圍需求和階段路線圖的完整結構化專案。

**需求：**
- REQ-INIT-01：系統必須進行自適應提問，直到充分理解專案範圍
- REQ-INIT-02：系統必須派生並行研究智慧體，調查領域生態系統
- REQ-INIT-03：系統必須將需求提取並分類為 v1（必須有）、v2（未來）和超出範圍三類
- REQ-INIT-04：系統必須生成具有需求可追溯性的階段路線圖
- REQ-INIT-05：系統必須在繼續之前要求使用者審批路線圖
- REQ-INIT-06：當 `.planning/PROJECT.md` 已存在時，系統必須阻止重新初始化
- REQ-INIT-07：系統必須支援 `--auto @file.md` 標誌，以跳過互動式問題並從文件中提取資訊

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `PROJECT.md` | 專案願景、約束條件、技術決策、演進規則 |
| `REQUIREMENTS.md` | 帶唯一 ID（REQ-XX）的範圍化需求 |
| `ROADMAP.md` | 帶狀態跟蹤和需求對映的階段分解 |
| `STATE.md` | 含位置、決策、指標的初始專案狀態 |
| `config.json` | 工作流配置 |
| `research/SUMMARY.md` | 綜合領域研究 |
| `research/STACK.md` | 技術棧調研 |
| `research/FEATURES.md` | 功能實現模式 |
| `research/ARCHITECTURE.md` | 架構模式與權衡 |
| `research/PITFALLS.md` | 常見失敗模式與緩解措施 |

**流程：**
1. **提問** — 以"夢想提取"理念（而非需求收集）為指導的自適應提問
2. **研究** — 4 個並行研究智慧體分別調查技術棧、功能、架構和陷阱
3. **綜合** — 研究綜合器將發現彙總為 SUMMARY.md
4. **需求** — 從使用者回答與研究成果中提取，按範圍分類
5. **路線圖** — 階段分解對映至需求，粒度設定控制階段數量

**功能需求：**
- 問題根據檢測到的專案型別（Web 應用、CLI、移動端、API 等）自適應調整
- 研究智慧體具備網頁搜尋能力，可獲取當前生態系統資訊
- 粒度設定控制階段數量：`coarse`（3-5）、`standard`（5-8）、`fine`（8-12）
- `--auto` 模式從提供的文件中提取所有資訊，無需互動式提問
- 如果存在來自 `/gsd-map-codebase` 的程式碼庫上下文，將自動載入

---

### 2. 階段討論

**命令：** `/gsd-discuss-phase [N] [--auto] [--batch]`

**目的：** 在研究和規劃開始之前，捕獲使用者的實現偏好和決策。消除導致 AI 猜測的灰色地帶。

**需求：**
- REQ-DISC-01：系統必須分析階段範圍並識別決策區域（灰色地帶）
- REQ-DISC-02：系統必須按型別（視覺、API、內容、組織等）對灰色地帶進行分類
- REQ-DISC-03：系統必須只提問先前 CONTEXT.md 檔案中尚未回答的問題
- REQ-DISC-04：系統必須將決策持久化到 `{phase}-CONTEXT.md`，並附帶規範引用
- REQ-DISC-05：系統必須支援 `--auto` 標誌，自動選擇推薦的預設值
- REQ-DISC-06：系統必須支援 `--batch` 標誌，用於分組問題採集
- REQ-DISC-07：系統必須在識別灰色地帶之前偵查相關原始檔（程式碼感知討論）
- REQ-DISC-08：當 USER-PROFILE.md 顯示使用者為非技術負責人時（learning_style: guided、frustration_triggers 中含行話，或解釋深度偏高層），系統必須將灰色地帶語言調整為產品成果術語
- REQ-DISC-09：當 REQ-DISC-08 適用時，advisor_research 理由段落必須用通俗語言改寫——相同的決策，轉化後的表達方式

**產出物：** `{padded_phase}-CONTEXT.md` — 輸入研究和規劃的使用者偏好

**灰色地帶類別：**
| 類別 | 決策示例 |
|----------|-------------------|
| 視覺功能 | 佈局、密度、互動、空狀態 |
| API/CLI | 響應格式、標誌、錯誤處理、詳細程度 |
| 內容系統 | 結構、語氣、深度、流程 |
| 組織 | 分組標準、命名、重複項、例外情況 |

---

### 3. UI 設計契約

**命令：** `/gsd-ui-phase [N]`

**目的：** 在規劃之前鎖定設計決策，使階段中所有元件共享一致的視覺標準。

**需求：**
- REQ-UI-01：系統必須檢測現有設計系統狀態（shadcn components.json、Tailwind 配置、令牌）
- REQ-UI-02：系統必須只提問尚未回答的設計契約問題
- REQ-UI-03：系統必須從 6 個維度進行驗證（文案、視覺、顏色、排版、間距、登錄檔安全）
- REQ-UI-04：當驗證返回 BLOCKED 時，系統必須進入修訂迴圈（最多 2 次迭代）
- REQ-UI-05：對於沒有 `components.json` 的 React/Next.js/Vite 專案，系統必須提供 shadcn 初始化
- REQ-UI-06：系統必須對第三方 shadcn 登錄檔實施登錄檔安全門控

**產出物：** `{padded_phase}-UI-SPEC.md` — 執行者使用的設計契約

**6 個驗證維度：**
1. **文案** — CTA 標籤、空狀態、錯誤訊息
2. **視覺** — 焦點、視覺層次、圖示無障礙
3. **顏色** — 強調色使用規範、60/30/10 合規性
4. **排版** — 字型大小/粗細約束遵守情況
5. **間距** — 網格對齊、令牌一致性
6. **登錄檔安全** — 第三方元件檢查要求

**shadcn 整合：**
- 檢測 React/Next.js/Vite 專案中缺失的 `components.json`
- 引導使用者完成 `ui.shadcn.com/create` 預設配置
- 預設字串成為可跨階段復現的規劃構件
- 安全門控要求在使用第三方元件前執行 `npx shadcn view` 和 `npx shadcn diff`

---

### 4. 階段規劃

**命令：** `/gsd-plan-phase [N] [--auto] [--skip-research] [--skip-verify]`

**目的：** 研究實現領域，生成經過驗證的原子化執行計劃。

**需求：**
- REQ-PLAN-01：系統必須派生階段研究員來調查實現方案
- REQ-PLAN-02：系統必須生成每個包含 2-3 個任務的計劃，大小適合單個上下文視窗
- REQ-PLAN-03：系統必須將計劃結構化為 XML，`<task>` 元素包含 `name`、`files`、`action`、`verify` 和 `done` 欄位
- REQ-PLAN-04：系統必須在每個計劃中包含 `read_first` 和 `acceptance_criteria` 節區
- REQ-PLAN-05：系統必須執行計劃檢查驗證迴圈（最多 3 次迭代），除非設定了 `--skip-verify`
- REQ-PLAN-06：系統必須支援 `--skip-research` 標誌以繞過研究階段
- REQ-PLAN-07：當檢測到前端階段且不存在 UI-SPEC.md 時，系統必須提示使用者執行 `/gsd-ui-phase`（UI 安全門控）
- REQ-PLAN-08：當 `workflow.nyquist_validation` 啟用時，系統必須包含 Nyquist 驗證對映
- REQ-PLAN-09：規劃完成前，系統必須驗證所有階段需求至少被一個計劃覆蓋（需求覆蓋門控）

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `{phase}-RESEARCH.md` | 生態系統研究發現 |
| `{phase}-{N}-PLAN.md` | 原子化執行計劃（每個 2-3 個任務） |
| `{phase}-VALIDATION.md` | 測試覆蓋對映（Nyquist 層） |

**計劃結構（XML）：**
```xml
<task type="auto">
  <name>Create login endpoint</name>
  <files>src/app/api/auth/login/route.ts</files>
  <action>
    Use jose for JWT. Validate credentials against users table.
    Return httpOnly cookie on success.
  </action>
  <verify>curl -X POST localhost:3000/api/auth/login returns 200 + Set-Cookie</verify>
  <done>Valid credentials return cookie, invalid return 401</done>
</task>
```

**計劃檢查驗證（8 個維度）：**
1. 需求覆蓋 — 計劃覆蓋所有階段需求
2. 任務原子性 — 每個任務可獨立提交
3. 依賴順序 — 任務正確排序
4. 檔案範圍 — 計劃之間無過多檔案重疊
5. 驗證命令 — 每個任務有可測試的完成標準
6. 上下文適配 — 任務適合單個上下文視窗
7. 間隙檢測 — 無缺失的實現步驟
8. Nyquist 合規 — 任務有自動化驗證命令（啟用時）

---

### 5. 階段執行

**命令：** `/gsd-execute-phase <N>`

**目的：** 使用基於波次的並行化方式執行階段中所有計劃，每個執行器使用全新的上下文視窗。

**需求：**
- REQ-EXEC-01：系統必須分析計劃依賴關係並將其分組為執行波次
- REQ-EXEC-02：系統必須在每個波次內並行派生獨立計劃
- REQ-EXEC-03：系統必須為每個執行器提供全新的上下文視窗（200K tokens）
- REQ-EXEC-04：系統必須為每個任務生成原子化 git 提交
- REQ-EXEC-05：系統必須為每個已完成的計劃生成 SUMMARY.md
- REQ-EXEC-06：系統必須執行執行後驗證器，檢查階段目標是否達成
- REQ-EXEC-07：系統必須支援 git 分支策略（`none`、`phase`、`milestone`）
- REQ-EXEC-08：當任務驗證失敗時，系統必須呼叫節點修復運算子（啟用時）
- REQ-EXEC-09：在驗證之前，系統必須執行先前階段的測試套件，以捕獲跨階段迴歸

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `{phase}-{N}-SUMMARY.md` | 每個計劃的執行結果 |
| `{phase}-VERIFICATION.md` | 執行後驗證報告 |
| Git 提交 | 每個任務的原子化提交 |

**波次執行：**
- 無依賴的計劃 → 波次 1（並行）
- 依賴波次 1 的計劃 → 波次 2（並行，等待波次 1 完成）
- 持續直到所有計劃完成
- 檔案衝突迫使同一波次內順序執行

**執行器能力：**
- 讀取包含完整任務指令的 PLAN.md
- 可訪問 PROJECT.md、STATE.md、CONTEXT.md、RESEARCH.md
- 使用結構化提交訊息原子化地提交每個任務
- 並行執行期間使用 `--no-verify` 提交，避免構建鎖競爭
- 處理檢查點型別：`auto`、`checkpoint:human-verify`、`checkpoint:decision`、`checkpoint:human-action`
- 在 SUMMARY.md 中報告對計劃的偏差

**並行安全：**
- **pre-commit 鉤子**：並行智慧體跳過（`--no-verify`），每個波次後由編排器統一執行一次
- **STATE.md 鎖定**：檔案級鎖檔案防止智慧體間併發寫入損壞

---

### 6. 工作驗收

**命令：** `/gsd-verify-work [N]`

**目的：** 使用者驗收測試 — 引導使用者逐一測試每個可交付成果，並自動診斷失敗。

**需求：**
- REQ-VERIFY-01：系統必須從階段中提取可測試的可交付成果
- REQ-VERIFY-02：系統必須逐一呈現可交付成果供使用者確認
- REQ-VERIFY-03：系統必須派生除錯智慧體自動診斷失敗
- REQ-VERIFY-04：系統必須為識別出的問題建立修復計劃
- REQ-VERIFY-05：對於修改伺服器/資料庫/種子/啟動檔案的階段，系統必須注入冷啟動冒煙測試
- REQ-VERIFY-06：系統必須生成包含通過/失敗結果的 UAT.md

**產出物：** `{phase}-UAT.md` — 使用者驗收測試結果，如有問題則附修復計劃

---

### 6.5. Ship

**命令：** `/gsd-ship [N] [--draft]`

**目的：** 將本地完成狀態橋接到已合併的 PR。驗證通過後，推送分支，根據規劃構件自動生成 PR 正文，建立 PR，可選觸發審查，並在 STATE.md 中跟蹤。

**需求：**
- REQ-SHIP-01：系統必須在釋出前驗證階段已通過驗證
- REQ-SHIP-02：系統必須通過 `gh` CLI 推送分支並建立 PR
- REQ-SHIP-03：系統必須從 SUMMARY.md、VERIFICATION.md 和 REQUIREMENTS.md 自動生成 PR 正文
- REQ-SHIP-04：系統必須用釋出狀態和 PR 號更新 STATE.md
- REQ-SHIP-05：系統必須支援 `--draft` 標誌，用於草稿 PR
- REQ-SHIP-06：系統必須支援通過 `ship.pr_body_sections` 配置的僅追加專案 PR 正文節區

**前提條件：** 階段已驗證、已安裝並認證 `gh` CLI、工作在功能分支上

**產出物：** 具有豐富正文的 GitHub PR，可選配置的 PRD 風格節區，STATE.md 已更新

**使用者文件：** [自定義 PR 正文節區](../ship-pr-body-sections.md)

---

### 7. UI 審查

**命令：** `/gsd-ui-review [N]`

**目的：** 對已實現的前端程式碼進行追溯性 6 支柱視覺審計。可作為獨立工具用於任何專案。

**需求：**
- REQ-UIREVIEW-01：系統必須對 6 個支柱分別按 1-4 分進行評分
- REQ-UIREVIEW-02：系統必須通過 Playwright CLI 截圖並儲存到 `.planning/ui-reviews/`
- REQ-UIREVIEW-03：系統必須為截圖目錄建立 `.gitignore`
- REQ-UIREVIEW-04：系統必須識別優先順序最高的 3 個修復點
- REQ-UIREVIEW-05：系統必須能獨立執行（無需 UI-SPEC.md），使用抽象品質標準

**6 個審計支柱（1-4 分）：**
1. **文案** — CTA 標籤、空狀態、錯誤狀態
2. **視覺** — 焦點、視覺層次、圖示無障礙
3. **顏色** — 強調色使用規範、60/30/10 合規性
4. **排版** — 字型大小/粗細約束遵守情況
5. **間距** — 網格對齊、令牌一致性
6. **體驗設計** — 載入/錯誤/空狀態覆蓋

**產出物：** `{padded_phase}-UI-REVIEW.md` — 評分和優先順序修復建議

---

### 8. 里程碑管理

**命令：** `/gsd-audit-milestone`、`/gsd-complete-milestone`、`/gsd-new-milestone [name]`

**目的：** 驗證里程碑完成情況，歸檔，打發布標籤，啟動下一個開發週期。

**需求：**
- REQ-MILE-01：審計必須驗證所有里程碑需求均已滿足
- REQ-MILE-02：審計必須檢測存根、佔位符實現和未測試程式碼
- REQ-MILE-03：審計必須檢查各階段的 Nyquist 驗證合規性
- REQ-MILE-04：完成時必須將里程碑資料歸檔到 MILESTONES.md
- REQ-MILE-05：完成時必須提供釋出的 git 標籤建立選項
- REQ-MILE-06：完成時必須提供壓縮合並或帶歷史合併的選項（用於分支策略）
- REQ-MILE-07：完成時必須清理 UI 審查截圖
- REQ-MILE-08：新里程碑必須遵循與新專案相同的流程（提問 → 研究 → 需求 → 路線圖）
- REQ-MILE-09：新里程碑不得重置現有工作流配置


---

## 規劃功能

### 9. 階段管理

**命令：** `/gsd-phase`、`/gsd-phase --insert [N]`、`/gsd-phase --remove [N]`

**目的：** 開發過程中動態修改路線圖。

**需求：**
- REQ-PHASE-01：新增操作必須在當前路線圖末尾追加新階段
- REQ-PHASE-02：插入操作必須在現有階段之間使用小數編號（例如 3.1）
- REQ-PHASE-03：刪除操作必須對後續所有階段重新編號
- REQ-PHASE-04：刪除操作必須阻止刪除已執行的階段
- REQ-PHASE-05：所有操作必須更新 ROADMAP.md 並建立/刪除階段目錄

---

### 10. 快速模式

**命令：** `/gsd-quick [--full] [--discuss] [--research]`

**目的：** 臨時任務執行，具備 GSD 保證但路徑更快。

**需求：**
- REQ-QUICK-01：系統必須接受自由格式的任務描述
- REQ-QUICK-02：系統必須使用與完整工作流相同的規劃器 + 執行器智慧體
- REQ-QUICK-03：預設情況下，系統必須跳過研究、計劃檢查和驗證器
- REQ-QUICK-04：`--full` 標誌必須啟用計劃檢查（最多 2 次迭代）和執行後驗證
- REQ-QUICK-05：`--discuss` 標誌必須執行輕量級預規劃討論
- REQ-QUICK-06：`--research` 標誌必須在規劃之前派生專注研究智慧體
- REQ-QUICK-07：標誌必須可組合（`--discuss --research --full`）
- REQ-QUICK-08：系統必須在 `.planning/quick/YYMMDD-xxx-slug/` 中跟蹤快速任務
- REQ-QUICK-09：系統必須為快速任務執行生成原子化提交

---

### 11. 自主模式

**命令：** `/gsd-autonomous [--from N]`

**目的：** 自主執行所有剩餘階段 — 每個階段依次執行討論 → 規劃 → 執行。

**需求：**
- REQ-AUTO-01：系統必須按路線圖順序遍歷所有未完成的階段
- REQ-AUTO-02：系統必須為每個階段執行討論 → 規劃 → 執行
- REQ-AUTO-03：系統必須暫停以獲取明確的使用者決策（灰色地帶確認、阻塞問題、驗證）
- REQ-AUTO-04：系統必須在每個階段完成後重新讀取 ROADMAP.md，以捕獲動態插入的階段
- REQ-AUTO-05：`--from N` 標誌必須從指定的階段號開始

---

### 12. 自由路由

**命令：** `/gsd-progress --do`（另見 `/gsd-manager` 用於互動式路由）

**目的：** 分析自由文本並路由到適當的 GSD 命令。

**需求：**
- REQ-DO-01：系統必須從自然語言輸入中解析使用者意圖
- REQ-DO-02：系統必須將意圖對映到最匹配的 GSD 命令
- REQ-DO-03：系統必須在執行前向用戶確認路由
- REQ-DO-04：系統必須針對專案已存在與無專案的上下文采用不同處理方式

---

### 13. 筆記捕獲

**命令：** `/gsd-capture`

**目的：** 零摩擦的想法捕獲，不中斷工作流。追加帶時間戳的筆記、列出所有筆記，或將筆記提升為結構化待辦事項。

**需求：**
- REQ-NOTE-01：系統必須通過單次 Write 呼叫儲存帶時間戳的筆記檔案
- REQ-NOTE-02：系統必須支援 `list` 子命令，顯示專案和全域性範圍內的所有筆記
- REQ-NOTE-03：系統必須支援 `promote N` 子命令，將筆記轉換為結構化待辦事項
- REQ-NOTE-04：系統必須支援 `--global` 標誌用於全域性範圍操作
- REQ-NOTE-05：系統不得使用 Task、AskUserQuestion 或 Bash — 僅內聯執行

---

### 14. 自動推進 (Next)

**命令：** `/gsd-progress --next`

**目的：** 自動檢測當前專案狀態並推進到下一個邏輯工作流步驟，無需記憶所在的階段/步驟。

**需求：**
- REQ-NEXT-01：系統必須讀取 STATE.md、ROADMAP.md 和階段目錄以確定當前位置
- REQ-NEXT-02：系統必須檢測是否需要討論、規劃、執行或驗證
- REQ-NEXT-03：系統必須自動呼叫正確的命令
- REQ-NEXT-04：如果不存在專案，系統必須建議 `/gsd-new-project`
- REQ-NEXT-05：當所有階段完成時，系統必須建議 `/gsd-complete-milestone`

**狀態檢測邏輯：**
| 狀態 | 操作 |
|-------|--------|
| 無 `.planning/` 目錄 | 建議 `/gsd-new-project` |
| 階段無 CONTEXT.md | 執行 `/gsd-discuss-phase` |
| 階段無 PLAN.md 檔案 | 執行 `/gsd-plan-phase` |
| 階段有計劃但無 SUMMARY.md | 執行 `/gsd-execute-phase` |
| 階段已執行但無 VERIFICATION.md | 執行 `/gsd-verify-work` |
| 所有階段完成 | 建議 `/gsd-complete-milestone` |

---

## 品質保障功能

### 15. Nyquist 驗證

**目的：** 在編寫任何程式碼之前，將自動化測試覆蓋對映到階段需求。以奈奎斯特取樣定理命名 — 確保每個需求都有反饋訊號。

**需求：**
- REQ-NYQ-01：系統必須在規劃階段研究期間檢測現有測試基礎設施
- REQ-NYQ-02：系統必須將每個需求對映到特定的測試命令
- REQ-NYQ-03：系統必須識別波次 0 任務（實現之前需要測試腳手架）
- REQ-NYQ-04：計劃檢查器必須將 Nyquist 合規性作為第 8 個驗證維度強制執行
- REQ-NYQ-05：系統必須通過 `/gsd-validate-phase` 支援追溯驗證
- REQ-NYQ-06：系統必須可通過 `workflow.nyquist_validation: false` 停用

**產出物：** `{phase}-VALIDATION.md` — 測試覆蓋契約

**追溯驗證（`/gsd-validate-phase [N]`）：**
- 掃描實現並將需求對映到測試
- 識別需求缺乏自動化驗證的間隙
- 派生審計器生成測試（最多 3 次嘗試）
- 絕不修改實現程式碼 — 僅修改測試檔案和 VALIDATION.md
- 將實現錯誤標記為需要使用者處理的升級項

---

### 16. 計劃檢查

**目的：** 目標反向驗證，確保計劃在執行前能夠實現階段目標。

**需求：**
- REQ-PLANCK-01：系統必須從 8 個品質維度驗證計劃
- REQ-PLANCK-02：系統必須迴圈最多 3 次迭代，直到計劃通過
- REQ-PLANCK-03：系統必須對失敗提供具體、可操作的反饋
- REQ-PLANCK-04：系統必須可通過 `workflow.plan_check: false` 停用

---

### 17. 執行後驗證

**目的：** 自動檢查程式碼庫是否交付了階段所承諾的內容。

**需求：**
- REQ-POSTVER-01：系統必須對照階段目標進行檢查，而不僅僅是任務完成情況
- REQ-POSTVER-02：系統必須生成帶有通過/失敗分析的 VERIFICATION.md
- REQ-POSTVER-03：系統必須記錄問題供 `/gsd-verify-work` 處理
- REQ-POSTVER-04：系統必須可通過 `workflow.verifier: false` 停用

---

### 18. 節點修復

**目的：** 當執行期間任務驗證失敗時進行自主恢復。

**需求：**
- REQ-REPAIR-01：系統必須分析失敗並選擇一種策略：RETRY（重試）、DECOMPOSE（分解）或 PRUNE（修剪）
- REQ-REPAIR-02：RETRY 必須通過具體調整進行嘗試
- REQ-REPAIR-03：DECOMPOSE 必須將任務分解為更小的可驗證子步驟
- REQ-REPAIR-04：PRUNE 必須刪除不可實現的任務並向用戶升級
- REQ-REPAIR-05：系統必須遵守修復預算（預設：每個任務 2 次嘗試）
- REQ-REPAIR-06：系統必須可通過 `workflow.node_repair_budget` 和 `workflow.node_repair` 配置

---

### 19. 健康驗證

**命令：** `/gsd-health [--repair]`

**目的：** 驗證 `.planning/` 目錄完整性並自動修復問題。

**需求：**
- REQ-HEALTH-01：系統必須檢查缺少的必需檔案
- REQ-HEALTH-02：系統必須驗證配置一致性
- REQ-HEALTH-03：系統必須檢測無摘要的孤立計劃
- REQ-HEALTH-04：系統必須檢查階段編號和路線圖同步
- REQ-HEALTH-05：`--repair` 標誌必須自動修復可恢復的問題

---

### 20. 跨階段迴歸門控

**目的：** 通過在執行後執行先前階段的測試套件，防止迴歸問題在階段間累積。

**需求：**
- REQ-REGR-01：系統必須在階段執行後執行所有已完成的先前階段的測試套件
- REQ-REGR-02：系統必須將任何測試失敗報告為跨階段迴歸
- REQ-REGR-03：迴歸問題必須在執行後驗證之前浮現
- REQ-REGR-04：系統必須識別哪個先前階段的測試被破壞

**觸發時機：** 在 `/gsd-execute-phase` 期間，在驗證器步驟之前自動執行。

---

### 21. 需求覆蓋門控

**目的：** 確保所有階段需求在規劃完成前至少被一個計劃覆蓋。

**需求：**
- REQ-COVGATE-01：系統必須從 ROADMAP.md 中提取分配到該階段的所有需求 ID
- REQ-COVGATE-02：系統必須驗證每個需求至少出現在一個 PLAN.md 中
- REQ-COVGATE-03：未覆蓋的需求必須阻止規劃完成
- REQ-COVGATE-04：系統必須報告哪些具體需求缺乏計劃覆蓋

**觸發時機：** 在 `/gsd-plan-phase` 結束時，在計劃檢查器迴圈之後自動執行。

---

## 上下文工程功能

### 22. 上下文視窗監控

**目的：** 在上下文即將耗盡時向用戶和智慧體發出警報，防止上下文腐爛。

**需求：**
- REQ-CTX-01：狀態行必須向用戶顯示上下文使用百分比
- REQ-CTX-02：上下文監控器必須在剩餘 ≤35% 時注入面向智慧體的警告（WARNING）
- REQ-CTX-03：上下文監控器必須在剩餘 ≤25% 時注入面向智慧體的警告（CRITICAL）
- REQ-CTX-04：警告必須去抖動（兩次重複警告之間間隔 5 次工具使用）
- REQ-CTX-05：嚴重性升級（WARNING→CRITICAL）必須繞過去抖動
- REQ-CTX-06：上下文監控器必須區分 GSD 啟用與非 GSD 啟用專案
- REQ-CTX-07：警告必須是建議性的，絕不是覆蓋使用者偏好的命令式指令
- REQ-CTX-08：所有鉤子必須靜默失敗，絕不阻止工具執行

**架構：** 雙部分橋接系統：
1. 狀態行將指標寫入 `/tmp/claude-ctx-{session}.json`
2. 上下文監控器讀取指標並注入 `additionalContext` 警告

---

### 23. 會話管理

**命令：** `/gsd-pause-work`、`/gsd-resume-work`、`/gsd-progress`

**目的：** 在上下文重置和會話間維護專案連續性。

**需求：**
- REQ-SESSION-01：暫停必須將當前位置和後續步驟儲存到 `continue-here.md` 和結構化的 `HANDOFF.json`
- REQ-SESSION-02：恢復必須從 HANDOFF.json（優先）或狀態檔案（回退）恢復完整專案上下文
- REQ-SESSION-03：進度必須顯示當前位置、下一步操作和整體完成情況
- REQ-SESSION-04：進度必須讀取所有狀態檔案（STATE.md、ROADMAP.md、階段目錄）
- REQ-SESSION-05：所有會話操作必須在 `/clear`（上下文重置）後正常工作
- REQ-SESSION-06：HANDOFF.json 必須包含阻塞問題、待處理的人工操作和正在進行的任務狀態
- REQ-SESSION-07：恢復必須在會話開始時立即呈現人工操作和阻塞問題

---

### 24. 會話報告

**命令：** `/gsd-pause-work --report`

**目的：** 生成結構化的會話後摘要文件，記錄已執行的工作、取得的成果和預估的資源使用情況。

**需求：**
- REQ-REPORT-01：系統必須從 STATE.md、git 日誌和計劃/摘要檔案中收集資料
- REQ-REPORT-02：系統必須包含已提交的記錄、已執行的計劃和推進的階段
- REQ-REPORT-03：系統必須根據會話活動估算 token 使用量和成本
- REQ-REPORT-04：系統必須包含活躍的阻塞問題和已做出的決策
- REQ-REPORT-05：系統必須推薦後續步驟

**產出物：** `.planning/reports/SESSION_REPORT.md`

**報告節區：**
- 會話概覽（持續時間、里程碑、階段）
- 已執行工作（提交、計劃、階段）
- 成果和可交付成果
- 阻塞問題和決策
- 資源估算（tokens、成本）
- 後續步驟建議

---

### 25. 多智慧體編排

**目的：** 協調專業智慧體，每個任務使用全新的上下文視窗。

**需求：**
- REQ-ORCH-01：每個智慧體必須接收全新的上下文視窗
- REQ-ORCH-02：編排器必須保持精簡 — 派生智慧體、收集結果、路由到下一步
- REQ-ORCH-03：上下文負載必須包含所有相關的專案構件
- REQ-ORCH-04：並行智慧體必須完全獨立（無共享可變狀態）
- REQ-ORCH-05：智慧體結果必須在編排器處理之前寫入磁碟
- REQ-ORCH-06：失敗的智慧體必須被檢測到（抽查實際輸出與報告的失敗）

---

### 26. 模型配置

**命令：** `/gsd-config --profile <quality|balanced|budget|adaptive|inherit>`

**目的：** 控制每個智慧體使用的 AI 模型，平衡品質與成本。

**需求：**
- REQ-MODEL-01：系統必須支援 4 種配置：`quality`、`balanced`、`budget`、`inherit`
- REQ-MODEL-02：每種配置必須為每個智慧體定義模型層級（見配置表）
- REQ-MODEL-03：每個智慧體的覆蓋設定必須優先於配置檔案
- REQ-MODEL-04：`inherit` 配置必須遵從執行時當前的模型選擇
- REQ-MODEL-04a：在使用非 Anthropic 提供商（OpenRouter、本地模型）時，必須使用 `inherit` 配置，以避免意外的 API 費用
- REQ-MODEL-05：配置檔案切換必須是程式化的（指令碼，而非 LLM 驅動）
- REQ-MODEL-06：模型解析必須在每次編排時發生一次，而非每次派生時發生

**配置分配：**

| 智慧體 | `quality` | `balanced` | `budget` | `inherit` |
|-------|-----------|------------|----------|-----------|
| gsd-planner | Opus | Opus | Sonnet | Inherit |
| gsd-roadmapper | Opus | Sonnet | Sonnet | Inherit |
| gsd-executor | Opus | Sonnet | Sonnet | Inherit |
| gsd-phase-researcher | Opus | Sonnet | Haiku | Inherit |
| gsd-project-researcher | Opus | Sonnet | Haiku | Inherit |
| gsd-research-synthesizer | Sonnet | Sonnet | Haiku | Inherit |
| gsd-debugger | Opus | Sonnet | Sonnet | Inherit |
| gsd-codebase-mapper | Sonnet | Haiku | Haiku | Inherit |
| gsd-verifier | Sonnet | Sonnet | Haiku | Inherit |
| gsd-plan-checker | Sonnet | Sonnet | Haiku | Inherit |
| gsd-integration-checker | Sonnet | Sonnet | Haiku | Inherit |
| gsd-nyquist-auditor | Sonnet | Sonnet | Haiku | Inherit |

---

## 棕地功能

### 27. 程式碼庫對映

**命令：** `/gsd-map-codebase [area]`

**目的：** 在啟動新專案之前分析現有程式碼庫，使 GSD 瞭解已有內容。

**需求：**
- REQ-MAP-01：系統必須為每個分析領域派生並行對映智慧體
- REQ-MAP-02：系統必須在 `.planning/codebase/` 中生成結構化文件
- REQ-MAP-03：系統必須檢測：技術棧、架構模式、編碼規範、關注點
- REQ-MAP-04：後續的 `/gsd-new-project` 必須載入程式碼庫對映，並將問題集中在新增內容上
- REQ-MAP-05：可選的 `[area]` 引數必須將對映範圍限定到特定區域

**產出物：**
| 文件 | 內容 |
|----------|---------|
| `STACK.md` | 語言、框架、資料庫、基礎設施 |
| `ARCHITECTURE.md` | 模式、層次、資料流、邊界 |
| `CONVENTIONS.md` | 命名規範、檔案組織、程式碼風格、測試模式 |
| `CONCERNS.md` | 技術債務、安全問題、效能瓶頸 |
| `STRUCTURE.md` | 目錄佈局和檔案組織 |
| `TESTING.md` | 測試基礎設施、覆蓋率、模式 |
| `INTEGRATIONS.md` | 外部服務、API、第三方依賴 |

**增量重對映 — `--paths` (#2003)：** 對映器接受可選的 `--paths <p1,p2,...>` 範圍提示。提供時，它將探索限制在列出的倉庫相對字首，而非掃描整個程式碼樹。這是執行後代碼庫漂移門控用於僅重新整理階段實際修改的子樹的路徑。每個生成的文件在其 YAML 前置後設資料中攜帶 `last_mapped_commit`，以便相對於對映點（而非 HEAD）來測量漂移。

### 27a. 執行後代碼庫漂移檢測

**引入版本：** #2003
**觸發條件：** 在每次 `/gsd-execute-phase` 結束時自動執行
**配置：**
- `workflow.drift_threshold`（整數，預設 `3`）— 門控觸發前的最小新增結構元素數。
- `workflow.drift_action`（`warn` | `auto-remap`，預設 `warn`）— 僅警告或派生 `gsd-codebase-mapper` 並將 `--paths` 限定到受影響的子樹。

**漂移計入的情況：**
- 對映路徑之外的新目錄
- `(packages|apps)/*/src/index.*` 處的新桶匯出
- 新的遷移檔案（supabase/prisma/drizzle/src/migrations/…）
- `routes/` 或 `api/` 下的新路由模組

**非阻塞保證：** 任何內部失敗（缺少 STRUCTURE.md、git 錯誤、對映器派生失敗）都只記錄一行日誌，階段繼續執行。漂移檢測不能導致驗證失敗。

**需求：**
- REQ-DRIFT-01：系統必須從 `git diff --name-status last_mapped_commit..HEAD` 檢測四類漂移
- REQ-DRIFT-02：僅當元素數量 ≥ `workflow.drift_threshold` 時才觸發操作
- REQ-DRIFT-03：`warn` 操作不得派生任何智慧體
- REQ-DRIFT-04：`auto-remap` 操作必須向對映器傳遞經過淨化的 `--paths`
- REQ-DRIFT-05：檢測/重對映失敗對 `/gsd-execute-phase` 必須是非阻塞的
- REQ-DRIFT-06：`last_mapped_commit` 通過每個 `.planning/codebase/*.md` 檔案的 YAML 前置後設資料進行往返

---

## 實用功能

### 28. 除錯系統

**命令：** `/gsd-debug [description]`

**目的：** 系統化除錯，在上下文重置後保持持久狀態。

**需求：**
- REQ-DEBUG-01：系統必須在 `.planning/debug/` 中建立除錯會話檔案
- REQ-DEBUG-02：系統必須跟蹤假設、證據和已排除的理論
- REQ-DEBUG-03：系統必須持久化狀態，以便除錯能在上下文重置後繼續
- REQ-DEBUG-04：系統必須在標記為已解決之前要求人工驗證
- REQ-DEBUG-05：已解決的會話必須追加到 `.planning/debug/knowledge-base.md`
- REQ-DEBUG-06：新除錯會話必須參考知識庫，防止重複調查

**除錯會話狀態：** `gathering` → `investigating` → `fixing` → `verifying` → `awaiting_human_verify` → `resolved`

---

### 29. 待辦事項管理

**命令：** `/gsd-capture [desc]`、`/gsd-capture --list`

**目的：** 在會話期間捕獲想法和任務以供後續工作。

**需求：**
- REQ-TODO-01：系統必須從當前對話上下文中捕獲待辦事項
- REQ-TODO-02：待辦事項必須儲存在 `.planning/todos/pending/`
- REQ-TODO-03：已完成的待辦事項必須移至 `.planning/todos/completed/`
- REQ-TODO-04：檢視待辦事項必須列出所有待處理專案，並提供選擇處理其中一項的功能

---

### 30. 統計儀表板

**命令：** `/gsd-stats`

**目的：** 顯示專案指標 — 階段、計劃、需求、git 歷史和時間線。

**需求：**
- REQ-STATS-01：系統必須顯示階段/計劃完成數量
- REQ-STATS-02：系統必須顯示需求覆蓋情況
- REQ-STATS-03：系統必須顯示 git 提交指標
- REQ-STATS-04：系統必須支援多種輸出格式（json、table、bar）

---

### 31. 更新系統

**命令：** `/gsd-update`

**目的：** 使用變更日誌預覽將 GSD 更新至最新版本。

**需求：**
- REQ-UPDATE-01：系統必須通過 npm 檢查新版本
- REQ-UPDATE-02：系統必須在更新前顯示新版本的變更日誌
- REQ-UPDATE-03：系統必須感知執行時並針對正確的目錄
- REQ-UPDATE-04：系統必須將本地修改的檔案備份到 `gsd-local-patches/`
- REQ-UPDATE-05：`/gsd-update --reapply` 必須在更新後恢復本地修改

---

### 32. 設定管理

**命令：** `/gsd-settings`

**目的：** 互動式配置工作流開關和模型配置。

**需求：**
- REQ-SETTINGS-01：系統必須以切換選項呈現當前設定
- REQ-SETTINGS-02：系統必須更新 `.planning/config.json`
- REQ-SETTINGS-03：系統必須支援儲存為全域性預設值（`~/.gsd/defaults.json`）

**可配置設定：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `mode` | enum | `interactive` | `interactive` 或 `yolo`（自動審批） |
| `granularity` | enum | `standard` | `coarse`、`standard` 或 `fine` |
| `model_profile` | enum | `balanced` | `quality`、`balanced`、`budget` 或 `inherit` |
| `models.<phase_type>` | enum | （無） | 每階段型別層級覆蓋（`planning`、`discuss`、`research`、`execution`、`verification`、`completion`）。取值：`opus`、`sonnet`、`haiku`、`inherit`。粗粒度階段級調優，優先於 `model_profile`，但低於每智慧體 `model_overrides`。參見 [CONFIGURATION.md](CONFIGURATION.md#per-phase-type-models-models--added-in-v140)。v1.40 新增 |
| `dynamic_routing.enabled` | boolean | `false` | 失敗層級升級的主開關。為 `true` 時，智慧體解析到 `tier_models[default_tier]`，並在編排器檢測到軟失敗時升級一級。受 `max_escalations` 限制。參見 [CONFIGURATION.md](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140)。v1.40 新增 |
| `workflow.research` | boolean | `true` | 規劃前的領域研究 |
| `workflow.plan_check` | boolean | `true` | 計劃驗證迴圈 |
| `workflow.verifier` | boolean | `true` | 執行後驗證 |
| `workflow.auto_advance` | boolean | `false` | 自動連結討論→規劃→執行 |
| `workflow.nyquist_validation` | boolean | `true` | Nyquist 測試覆蓋對映 |
| `workflow.ui_phase` | boolean | `true` | UI 設計契約生成 |
| `workflow.ui_safety_gate` | boolean | `true` | 在前端階段提示執行 ui-phase |
| `workflow.node_repair` | boolean | `true` | 自主任務修復 |
| `workflow.node_repair_budget` | number | `2` | 每個任務的最大修復嘗試次數 |
| `planning.commit_docs` | boolean | `true` | 將 `.planning/` 檔案提交到 git |
| `planning.search_gitignored` | boolean | `false` | 在搜尋中包含 gitignored 檔案 |
| `parallelization.enabled` | boolean | `true` | 同時執行獨立計劃 |
| `git.branching_strategy` | enum | `none` | `none`、`phase` 或 `milestone` |

---

### 33. 測試生成

**命令：** `/gsd-add-tests [N]`

**目的：** 根據 UAT 標準和實現，為已完成的階段生成測試。

**需求：**
- REQ-TEST-01：系統必須分析已完成階段的實現
- REQ-TEST-02：系統必須根據 UAT 標準和驗收標準生成測試
- REQ-TEST-03：系統必須使用現有的測試基礎設施模式

---

## 基礎設施功能

### 34. Git 整合

**目的：** 原子化提交、分支策略和清晰的歷史管理。

**需求：**
- REQ-GIT-01：每個任務必須有其原子化提交
- REQ-GIT-02：提交訊息必須遵循結構化格式：`type(scope): description`
- REQ-GIT-03：系統必須支援 3 種分支策略：`none`、`phase`、`milestone`
- REQ-GIT-04：phase 策略必須為每個階段建立一個分支
- REQ-GIT-05：milestone 策略必須為每個里程碑建立一個分支
- REQ-GIT-06：完成里程碑必須提供壓縮合並（推薦）或帶歷史合併選項
- REQ-GIT-07：系統必須遵守 `.planning/` 檔案的 `commit_docs` 設定
- REQ-GIT-08：系統必須自動檢測 `.gitignore` 中的 `.planning/` 並跳過提交

**提交格式：**
```
type(phase-plan): description

# 示例：
docs(08-02): complete user registration plan
feat(08-02): add email confirmation flow
fix(03-01): correct auth token expiry
```

---

### 35. CLI 工具

**目的：** 工作流和智慧體的程式化實用工具，替代重複性的內聯 bash 模式。

**需求：**
- REQ-CLI-01：系統必須提供用於狀態、配置、階段、路線圖操作的原子化命令
- REQ-CLI-02：系統必須提供複合 `init` 命令，為每個工作流載入所有上下文
- REQ-CLI-03：系統必須支援 `--raw` 標誌用於機器可讀輸出
- REQ-CLI-04：系統必須支援 `--cwd` 標誌用於沙箱子智慧體操作
- REQ-CLI-05：所有操作在 Windows 上必須使用正斜槓路徑

**命令類別：** 狀態（11 個子命令）、階段（5）、路線圖（3）、驗證（8）、模板（2）、前置後設資料（4）、腳手架（4）、初始化（12）、驗證（2）、進度、統計、待辦

---

### 36. 多執行時支援

**目的：** 跨多個 AI 程式設計智慧體執行時執行 GSD。

**需求：**
- REQ-RUNTIME-01：系統必須支援 Claude Code、OpenCode、Gemini CLI、Kilo、Codex、Copilot、Antigravity、Trae、Cline、Augment Code、CodeBuddy、Qwen Code
- REQ-RUNTIME-02：安裝器必須按執行時轉換內容（工具名稱、路徑、前置後設資料）
- REQ-RUNTIME-03：安裝器必須支援互動式和非互動式（`--claude --global`）模式
- REQ-RUNTIME-04：安裝器必須支援全域性和本地安裝
- REQ-RUNTIME-05：解除安裝必須乾淨地移除所有 GSD 檔案，不影響其他配置
- REQ-RUNTIME-06：安裝器必須處理平臺差異（Windows、macOS、Linux、WSL、Docker）

**執行時轉換：**

| 方面 | Claude Code | OpenCode | Gemini | Kilo | Codex | Copilot | Antigravity | Trae | Cline | Augment | CodeBuddy | Qwen Code |
|--------|------------|----------|--------|-------|-------|---------|-------------|------|-------|---------|-----------|-----------|
| 命令 | 斜槓命令 | 斜槓命令 | 斜槓命令 | 斜槓命令 | Skills (TOML) | 斜槓命令 | Skills | Skills | Rules | Skills | Skills | Skills |
| 智慧體格式 | Claude 原生 | `mode: subagent` | Claude 原生 | `mode: subagent` | Skills | 工具對映 | Skills | Skills | Rules | Skills | Skills | Skills |
| 鉤子事件 | `PostToolUse` | N/A | `AfterTool` | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 配置 | `settings.json` | `opencode.json(c)` | `settings.json` | `kilo.json(c)` | TOML | Instructions | Config | Config | `.clinerules` | Config | Config | Config |

---

### 37. 鉤子系統

**目的：** 用於上下文監控、狀態顯示和更新檢查的執行時事件鉤子。

**需求：**
- REQ-HOOK-01：狀態行必須顯示模型、當前任務、目錄和上下文使用情況
- REQ-HOOK-02：上下文監控器必須在閾值級別注入面向智慧體的警告
- REQ-HOOK-03：更新檢查器必須在會話開始時在後臺執行
- REQ-HOOK-04：所有鉤子必須遵守 `CLAUDE_CONFIG_DIR` 環境變數
- REQ-HOOK-05：所有鉤子必須包含 3 秒 stdin 超時守護
- REQ-HOOK-06：所有鉤子在發生任何錯誤時必須靜默失敗
- REQ-HOOK-07：上下文使用情況必須針對自動壓縮緩衝區進行歸一化（保留 16.5%）
- REQ-HOOK-08：更新橫幅必須是選項，且在沒有可用更新時保持靜默（PR #2795）

**狀態行顯示：**
```text
[⬆ /gsd-update │] model │ [current task │] directory [█████░░░░░ 50%]
```

顏色編碼：<50% 綠色，<65% 黃色，<80% 橙色，≥80% 紅色帶骷髏表情

**更新橫幅（選項，當未使用 GSD 狀態行時）：**

當用戶拒絕（或保留非 GSD）狀態行時，安裝器提供一個 SessionStart 橫幅，在不佔用狀態行空間的情況下顯示更新可用性。橫幅讀取 `~/.cache/gsd/gsd-update-check.json`（由 `gsd-check-update-worker.js` 寫入），僅在有可用更新時輸出一行：

```text
GSD update available: 1.39.0 → 1.40.0. Run /gsd-update.
```

無更新時橫幅保持靜默，"檢查失敗"診斷每 24 小時限流一次。通過 `npx @opengsd/gsd-core --uninstall` 或刪除引用 `gsd-update-banner.js` 的 SessionStart 條目可乾淨移除。

### 38. 開發者畫像

**命令：** `/gsd-profile-user [--questionnaire] [--refresh]`

**目的：** 分析 Claude Code 會話歷史，從 8 個維度構建行為畫像，生成可個性化 Claude 響應風格的構件。

**維度：**
1. 溝通風格（簡潔 vs 冗長，正式 vs 隨意）
2. 決策模式（快速 vs 審慎，風險承受度）
3. 除錯方式（系統化 vs 直覺化，日誌偏好）
4. 使用者體驗偏好（設計敏感度、無障礙意識）
5. 供應商/技術選擇（框架偏好、生態系統熟悉度）
6. 挫折觸發點（工作流中造成摩擦的因素）
7. 學習風格（文件 vs 示例，深度偏好）
8. 解釋深度（高層次 vs 實現細節）

**生成的構件：**
- `USER-PROFILE.md` — 帶證據引用的完整行為畫像
- `CLAUDE.md` 畫像節區 — 由 Claude Code 自動發現

**標誌：**
- `--questionnaire` — 當會話歷史不可用時的互動式問卷回退
- `--refresh` — 重新分析會話並重新生成畫像

**流水線模組：**
- `profile-pipeline.cjs` — 會話掃描、訊息提取、取樣
- `profile-output.cjs` — 畫像渲染、問卷、構件生成
- `gsd-user-profiler` 智慧體 — 從會話資料進行行為分析

**需求：**
- REQ-PROF-01：會話分析必須涵蓋至少 8 個行為維度
- REQ-PROF-02：畫像必須引用實際會話訊息中的證據
- REQ-PROF-03：當沒有會話歷史時，必須提供問卷作為回退
- REQ-PROF-04：生成的構件必須可被 Claude Code 發現（CLAUDE.md 整合）

### 39. 執行加固

**目的：** 執行流水線的三項附加品質改進，在級聯之前捕獲跨計劃失敗。

**元件：**

**1. 波次前依賴檢查**（execute-phase）
在派生波次 N+1 之前，驗證先前波次構件中的關鍵連結是否存在並正確連線。在下游失敗級聯之前捕獲跨計劃依賴間隙。

**2. 跨計劃資料契約 — 維度 9**（plan-checker）
新增分析維度，檢查共享資料流水線的計劃具有相容的轉換。當一個計劃剝離了另一個計劃在原始形式下需要的資料時進行標記。

**3. 匯出級別抽查**（verify-phase）
在第 3 級連線驗證通過後，對單個匯出進行實際使用抽查。捕獲存在於連線檔案中但從未被呼叫的死儲存。

**需求：**
- REQ-HARD-01：波次前檢查必須在派生下一波次之前驗證所有先前波次構件中的關鍵連結
- REQ-HARD-02：跨計劃契約檢查必須檢測計劃間不相容的資料轉換
- REQ-HARD-03：匯出抽查必須識別連線檔案中的死儲存

---

### 40. 驗證債務追蹤

**命令：** `/gsd-audit-uat`

**目的：** 當專案在有待處理測試的階段後推進時，防止 UAT/驗證專案的靜默丟失。跨所有先前階段呈現驗證債務，確保專案不被遺忘。

**元件：**

**1. 跨階段健康檢查**（progress.md 步驟 1.6）
每次 `/gsd-progress` 呼叫都會掃描當前里程碑中的所有階段，查詢未處理專案（pending、skipped、blocked、human_needed）。顯示帶可操作連結的非阻塞警告節區。

**2. `status: partial`**（verify-work.md、UAT.md）
新的 UAT 狀態，區分"會話結束"和"所有測試已解決"。當測試仍處於待處理、阻塞或無故跳過狀態時，阻止 `status: complete`。

**3. 帶 `blocked_by` 標籤的 `result: blocked`**（verify-work.md、UAT.md）
被外部依賴項（伺服器、物理裝置、釋出構建、第三方服務）阻塞的測試的新結果型別。與跳過的測試分開分類。

**4. HUMAN-UAT.md 持久化**（execute-phase.md）
當驗證返回 `human_needed` 時，專案作為帶 `status: partial` 的可追蹤 HUMAN-UAT.md 檔案持久化。用於跨階段健康檢查和審計系統。

**5. 階段完成警告**（phase.cjs、transition.md）
`phase complete` CLI 在其 JSON 輸出中返回驗證債務警告。過渡工作流在確認前呈現未處理專案。

**需求：**
- REQ-DEBT-01：系統必須在 `/gsd-progress` 中呈現所有先前階段的未處理 UAT/驗證專案
- REQ-DEBT-02：系統必須區分不完整測試（partial）和已完成測試（complete）
- REQ-DEBT-03：系統必須使用 `blocked_by` 標籤對阻塞的測試進行分類
- REQ-DEBT-04：系統必須將 human_needed 驗證專案持久化為可追蹤的 UAT 檔案
- REQ-DEBT-05：系統在階段完成和過渡期間發現驗證債務時，必須發出（非阻塞）警告
- REQ-DEBT-06：`/gsd-audit-uat` 必須掃描所有階段，按可測試性分類專案，並生成人工測試計劃

---

## v1.27 功能

### 41. 快速模式

**命令：** `/gsd-fast [task description]`

**目的：** 內聯執行簡單任務，無需派生子智慧體或生成 PLAN.md 檔案。適用於不值得規劃開銷的任務：修復拼寫錯誤、配置更改、小型重構、遺漏的提交、簡單新增。

**需求：**
- REQ-FAST-01：系統必須直接在當前上下文中執行任務，無需子智慧體
- REQ-FAST-02：系統必須為更改生成原子化 git 提交
- REQ-FAST-03：系統必須在 `.planning/quick/` 中跟蹤任務以保持狀態一致性
- REQ-FAST-04：系統不得用於需要研究、多步驟規劃或驗證的任務

**何時使用 vs `/gsd-quick`：**
- `/gsd-fast` — 可在 2 分鐘內完成的一句話任務（拼寫錯誤、配置更改、小型新增）
- `/gsd-quick` — 任何需要研究、多步驟規劃或驗證的事項

---

### 42. 跨 AI 同行評審

**命令：** `/gsd-review --phase N [--gemini] [--claude] [--codex] [--coderabbit] [--opencode] [--qwen] [--cursor] [--agy] [--ollama] [--lm-studio] [--llama-cpp] [--all]`

**目的：** 呼叫外部 AI CLI（Gemini、Claude、Codex、CodeRabbit、OpenCode、Qwen Code、Cursor、Antigravity）獨立審查階段計劃。生成包含每位審查者反饋的結構化 REVIEWS.md。

**需求：**
- REQ-REVIEW-01：系統必須檢測系統上可用的 AI CLI
- REQ-REVIEW-02：系統必須從階段計劃構建結構化審查提示
- REQ-REVIEW-03：系統必須獨立呼叫每個選定的 CLI
- REQ-REVIEW-04：系統必須收集響應並生成 `REVIEWS.md`
- REQ-REVIEW-05：審查結果必須可被 `/gsd-plan-phase --reviews` 使用
- REQ-REVIEW-06：系統必須通過 `review.default_reviewers` 支援專案級無標誌預設值
- REQ-REVIEW-07：審查者優先順序必須為：明確標誌 > `--all` > `review.default_reviewers` > 所有檢測到的審查者

**產出物：** `{phase}-REVIEWS.md` — 每位審查者的結構化反饋

**使用者配置說明：**
- 在 `.planning/config.json` 中（或通過 `gsd config-set`）設定 `review.default_reviewers`，控制無標誌 `/gsd-review` 的扇出。
- 使用 `--all` 進行完整的預合併掃描，而不更改專案預設值。
- 對於上下文視窗較小的本地模型伺服器，設定 `review.max_prompt_tokens_per_reviewer` 可按審查者自動裁剪提示 — 參見 CONFIGURATION.md 中的[小上下文審查者提示預算](../CONFIGURATION.md#prompt-budgets-for-small-context-reviewers)。

---

### 43. 待辦停車場

**命令：** `/gsd-capture --backlog <description>`、`/gsd-review-backlog`、`/gsd-capture --seed <idea>`

**目的：** 捕獲尚未準備好進行主動規劃的想法。待辦事項使用 999.x 編號，保持在活躍階段序列之外。種子是具有觸發條件的前瞻性想法，在適當的里程碑時自動浮現。

**需求：**
- REQ-BACKLOG-01：待辦事項必須使用 999.x 編號，保持在活躍階段序列之外
- REQ-BACKLOG-02：必須立即建立階段目錄，以便 `/gsd-discuss-phase` 和 `/gsd-plan-phase` 可以在其上執行
- REQ-BACKLOG-03：`/gsd-review-backlog` 必須支援每個專案的提升、保留和刪除操作
- REQ-BACKLOG-04：提升的專案必須重新編號進入活躍里程碑序列
- REQ-SEED-01：種子必須捕獲完整的原因和浮現時機條件
- REQ-SEED-02：`/gsd-new-milestone` 必須掃描種子並呈現匹配項

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `.planning/phases/999.x-slug/` | 待辦事項目錄 |
| `.planning/seeds/SEED-NNN-slug.md` | 帶觸發條件的種子 |

---

### 44. 持久化上下文執行緒

**命令：** `/gsd-thread [name | description]`

**目的：** 跨會話的輕量級知識儲存，用於跨多個會話但不屬於任何特定階段的工作。比 `/gsd-pause-work` 更輕量 — 無階段狀態，無計劃上下文。

**需求：**
- REQ-THREAD-01：系統必須支援建立、列出和恢復模式
- REQ-THREAD-02：執行緒必須以 Markdown 檔案形式儲存在 `.planning/threads/`
- REQ-THREAD-03：執行緒檔案必須包含目標、上下文、參考資料和後續步驟節區
- REQ-THREAD-04：恢復執行緒必須將其完整上下文載入到當前會話
- REQ-THREAD-05：執行緒必須可提升為階段或待辦事項

**產出物：** `.planning/threads/{slug}.md` — 持久化上下文執行緒

---

### 45. PR 分支過濾

**命令：** `/gsd-pr-branch [target branch]`

**目的：** 通過過濾掉 `.planning/` 提交，建立適合拉取請求的乾淨分支。審查者只看到程式碼更改，而不是 GSD 規劃構件。

**需求：**
- REQ-PRBRANCH-01：系統必須識別僅修改 `.planning/` 檔案的提交
- REQ-PRBRANCH-02：系統必須建立過濾掉規劃提交的新分支
- REQ-PRBRANCH-03：程式碼更改必須完全按照提交時的狀態保留

---

### 46. 安全加固

**目的：** GSD 規劃構件的縱深防禦安全機制。由於 GSD 生成的 Markdown 檔案會成為 LLM 系統提示，流入這些檔案的使用者控制文本是潛在的間接提示注入向量。

**元件：**

**1. 集中式安全模組**（`security.cjs`）
- 路徑遍歷防護 — 驗證檔案路徑是否解析在專案目錄內
- 提示注入檢測 — 掃描使用者提供的文本中的已知注入模式
- 安全 JSON 解析 — 在狀態損壞之前捕獲格式錯誤的輸入
- 欄位名驗證 — 通過配置欄位名防止注入
- Shell 引數驗證 — 在 shell 插值之前對使用者文本進行淨化

**2. 提示注入守護鉤子**（`gsd-prompt-guard.js`）
PreToolUse 鉤子，掃描針對 `.planning/` 的 Write/Edit 呼叫中的注入模式。僅為建議 — 記錄檢測結果以提高意識，不阻止合法操作。

**3. 工作流守護鉤子**（`gsd-workflow-guard.js`）
PreToolUse 鉤子，檢測 Claude 在 GSD 工作流上下文之外嘗試檔案編輯的情況。建議使用 `/gsd-quick` 或 `/gsd-fast` 替代直接編輯。可通過 `hooks.workflow_guard` 配置（預設：false）。

**4. CI 就緒注入掃描器**（`prompt-injection-scan.test.cjs`）
掃描所有智慧體、工作流和命令檔案中嵌入注入向量的測試套件。

**需求：**
- REQ-SEC-01：所有使用者提供的檔案路徑必須針對專案目錄進行驗證
- REQ-SEC-02：提示注入模式必須在文本進入規劃構件之前被檢測
- REQ-SEC-03：安全鉤子必須僅為建議性（永不阻止合法操作）
- REQ-SEC-04：對使用者輸入的 JSON 解析必須優雅地捕獲格式錯誤的資料
- REQ-SEC-05：macOS `/var` → `/private/var` 符號連結解析必須在路徑驗證中處理

---

### 47. 多倉庫工作區支援

**目的：** 單體倉庫和多倉庫設定的自動檢測和專案根路徑解析。支援 `.planning/` 可能需要跨倉庫邊界解析的工作區。

**需求：**
- REQ-MULTIREPO-01：系統必須自動檢測多倉庫工作區配置
- REQ-MULTIREPO-02：系統必須跨倉庫邊界解析專案根路徑
- REQ-MULTIREPO-03：執行器必須在多倉庫模式下記錄每個倉庫的提交雜湊

---

### 48. 討論審計追蹤

**目的：** 在 `/gsd-discuss-phase` 期間自動生成 `DISCUSSION-LOG.md`，提供討論期間做出決策的完整審計追蹤。

**需求：**
- REQ-DISCLOG-01：系統必須在 discuss-phase 期間自動生成 DISCUSSION-LOG.md
- REQ-DISCLOG-02：日誌必須捕獲提出的問題、呈現的選項和做出的決策
- REQ-DISCLOG-03：決策 ID 必須實現從 discuss-phase 到 plan-phase 的可追溯性

---

## v1.28 功能

### 49. 取證分析

**命令：** `/gsd-forensics [description]`

**目的：** 對失敗或卡住的 GSD 工作流進行事後調查。

**需求：**
- REQ-FORENSICS-01：系統必須分析 git 歷史中的異常（卡住的迴圈、長時間間隔、重複提交）
- REQ-FORENSICS-02：系統必須檢查構件完整性（已完成階段應有預期的檔案）
- REQ-FORENSICS-03：系統必須生成儲存到 `.planning/forensics/` 的 Markdown 報告
- REQ-FORENSICS-04：系統必須提供建立 GitHub Issue 的選項並附上發現結果
- REQ-FORENSICS-05：系統不得修改專案檔案（只讀調查）

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `.planning/forensics/report-{timestamp}.md` | 事後調查報告 |

**流程：**
1. **掃描** — 分析 git 歷史中的異常：卡住的迴圈、提交間的長時間間隔、重複的相同提交
2. **完整性檢查** — 驗證已完成階段是否有預期的構件檔案
3. **報告** — 生成 Markdown 報告，儲存到 `.planning/forensics/`
4. **Issue** — 提供建立 GitHub Issue 的選項，以便團隊瞭解發現結果

---

### 50. 里程碑摘要

**命令：** `/gsd-milestone-summary [version]`

**目的：** 從里程碑構件生成全面的專案摘要，用於團隊入職。

**需求：**
- REQ-SUMMARY-01：系統必須聚合階段計劃、摘要和驗證結果
- REQ-SUMMARY-02：系統必須適用於當前和已歸檔的里程碑
- REQ-SUMMARY-03：系統必須生成單個可導航的文件

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `MILESTONE-SUMMARY.md` | 里程碑構件的全面可導航摘要 |

**流程：**
1. **收集** — 從目標里程碑聚合階段計劃、摘要和驗證結果
2. **綜合** — 將構件合併為帶交叉引用的單個可導航文件
3. **輸出** — 編寫適合團隊入職和利益相關方審查的 `MILESTONE-SUMMARY.md`

---

### 51. 工作流名稱空間

**命令：** `/gsd-workstreams`

**目的：** 並行工作流，用於在不同里程碑區域上同時工作。

**需求：**
- REQ-WS-01：系統必須在獨立的 `.planning/workstreams/{name}/` 目錄中隔離工作流狀態
- REQ-WS-02：系統必須驗證工作流名稱（僅限字母數字 + 連字元，無路徑遍歷）
- REQ-WS-03：系統必須支援 list、create、switch、status、progress、complete、resume 子命令

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `.planning/workstreams/{name}/` | 隔離的工作流目錄結構 |

**流程：**
1. **建立** — 使用隔離的 `.planning/workstreams/{name}/` 目錄初始化命名工作流
2. **切換** — 為後續 GSD 命令更改活躍工作流上下文
3. **管理** — 列出、檢查狀態、跟蹤進度、完成或恢復工作流

---

### 52. 管理儀表板

**命令：** `/gsd-manager`

**目的：** 從一個終端管理多個階段的互動式命令中心。

**需求：**
- REQ-MGR-01：系統必須顯示所有階段及其狀態的概覽
- REQ-MGR-02：系統必須過濾到當前里程碑範圍
- REQ-MGR-03：系統必須顯示階段依賴關係和衝突

**產出物：** 互動式終端輸出

**流程：**
1. **掃描** — 載入當前里程碑中的所有階段及其狀態
2. **顯示** — 渲染顯示階段依賴關係、衝突和進度的概覽
3. **互動** — 接受命令以導航、檢查或對單個階段採取行動

---

### 53. 假設討論模式

**命令：** `/gsd-discuss-phase` 配合 `workflow.discuss_mode: 'assumptions'`

**目的：** 用程式碼庫優先的假設分析替代訪談式提問。

**需求：**
- REQ-ASSUME-01：系統必須在提問之前分析程式碼庫以生成結構化假設
- REQ-ASSUME-02：系統必須按置信度（Confident/Likely/Unclear）對假設進行分類
- REQ-ASSUME-03：系統必須生成與預設討論模式格式相同的 CONTEXT.md
- REQ-ASSUME-04：系統必須支援基於置信度的跳過門控（全部 HIGH = 不提問）

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `{phase}-CONTEXT.md` | 與預設討論模式格式相同 |

**流程：**
1. **分析** — 掃描程式碼庫以生成關於實現方法的結構化假設
2. **分類** — 按置信度級別對假設進行分類：Confident、Likely、Unclear
3. **門控** — 如果所有假設都具有高置信度，則完全跳過提問
4. **確認** — 將不明確的假設作為有針對性的問題呈現給使用者
5. **輸出** — 以與預設討論模式相同的格式生成 `{phase}-CONTEXT.md`

---

### 54. UI 階段自動檢測

**屬於：** `/gsd-new-project` 和 `/gsd-progress`

**目的：** 自動檢測 UI 密集型專案並呈現 `/gsd-ui-phase` 建議。

**需求：**
- REQ-UI-DETECT-01：系統必須檢測專案描述中的 UI 訊號（關鍵字、框架引用）
- REQ-UI-DETECT-02：當適用時，系統必須在 ROADMAP.md 階段中新增 `ui_hint` 註釋
- REQ-UI-DETECT-03：系統必須在 UI 密集型階段的後續步驟中建議 `/gsd-ui-phase`
- REQ-UI-DETECT-04：系統不得將 `/gsd-ui-phase` 設為強制性

**流程：**
1. **檢測** — 掃描專案描述和技術棧中的 UI 訊號（關鍵字、框架引用）
2. **標註** — 在 ROADMAP.md 中為適用階段新增 `ui_hint` 標記
3. **呈現** — 在 UI 密集型階段的後續步驟中包含 `/gsd-ui-phase` 建議

---

### 55. 多執行時安裝選擇

**屬於：** `npx @opengsd/gsd-core`

**目的：** 在單個互動式安裝會話中選擇多個執行時。

**需求：**
- REQ-MULTI-RT-01：互動式提示必須支援多選（例如 Claude Code + Gemini）
- REQ-MULTI-RT-02：CLI 標誌必須繼續適用於非互動式安裝

**流程：**
1. **檢測** — 識別系統上可用的 AI CLI 執行時
2. **提示** — 呈現執行時選擇的多選介面
3. **安裝** — 在單個會話中為所有選定的執行時配置 GSD

---

## v1.29 功能

### 56. Windsurf 執行時支援

**屬於：** `npx @opengsd/gsd-core`

**目的：** 將 Windsurf 新增為 GSD 安裝和執行支援的 AI CLI 執行時。

**需求：**
- REQ-WINDSURF-01：安裝器必須檢測 Windsurf 執行時並將其作為目標提供
- REQ-WINDSURF-02：GSD 命令必須在 Windsurf 會話中正確執行

**流程：**
1. **檢測** — 識別系統上 Windsurf 執行時的可用性
2. **安裝** — 為 Windsurf 環境配置 GSD 技能和鉤子

---

### 57. 國際化文件

**屬於：** `docs/`

**目的：** 提供葡萄牙語、韓語和日語版本的 GSD 文件。

**需求：**
- REQ-I18N-01：文件必須提供葡萄牙語（pt）、韓語（ko）和日語（ja）版本
- REQ-I18N-02：翻譯必須與英文源文件保持同步

**流程：**
1. **翻譯** — 將核心文件轉換為目標語言
2. **釋出** — 使翻譯後的文件與英文原版一同可訪問

---

## v1.31 功能

### 59. Schema 漂移檢測

**命令：** 在 `/gsd-execute-phase` 期間自動執行

**目的：** 檢測 ORM schema 檔案在沒有相應遷移或推送命令的情況下被修改，防止誤報驗證。

**需求：**
- REQ-SCHEMA-01：系統必須檢測對 ORM schema 檔案的修改（Prisma、Drizzle、Payload、Sanity、Mongoose）
- REQ-SCHEMA-02：當檢測到 schema 變更時，系統必須驗證對應的遷移/推送命令是否存在
- REQ-SCHEMA-03：系統必須實現雙層防護：計劃時注入和執行時門控
- REQ-SCHEMA-04：系統必須支援 `GSD_SKIP_SCHEMA_CHECK` 環境變數以覆蓋檢測
- REQ-SCHEMA-05：系統必須防止 schema 在沒有遷移的情況下修改導致的誤報驗證

**流程：**
1. **檢測** — 在計劃執行期間監控 ORM schema 檔案修改
2. **驗證** — 檢查計劃中是否存在對應的遷移/推送命令
3. **門控** — 如果檢測到沒有遷移的 schema 漂移，則阻止執行（執行時門控）
4. **注入** — 在計劃生成期間新增遷移提醒（計劃時注入）

**配置：** `GSD_SKIP_SCHEMA_CHECK` 環境變數，用於繞過檢測。

---

### 60. 安全強制執行

**命令：** `/gsd-secure-phase <N>`

**目的：** 對階段實現進行以威脅模型為基礎的安全驗證。

**需求：**
- REQ-SEC-01：系統必須執行以威脅模型為基礎的驗證（非盲目掃描）
- REQ-SEC-02：系統必須支援可配置的 OWASP ASVS 驗證級別（1-3）
- REQ-SEC-03：系統必須根據可配置的嚴重性閾值阻止階段推進
- REQ-SEC-04：系統必須派生 `gsd-security-auditor` 智慧體進行分析

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| 安全審計報告 | 帶嚴重性分類的以威脅模型為基礎的發現結果 |

**流程：**
1. **建模** — 從階段實現上下文構建威脅模型
2. **審計** — 派生 `gsd-security-auditor` 根據威脅模型進行驗證
3. **門控** — 如果發現結果達到或超過 `security_block_on` 嚴重性，則阻止階段推進

**配置：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `security_enforcement` | boolean | `true` | 啟用以威脅模型為基礎的安全驗證 |
| `security_asvs_level` | number (1-3) | `1` | OWASP ASVS 驗證級別 |
| `security_block_on` | string | `"high"` | 阻止階段推進的最低嚴重性 |

---

### 61. 文件生成

**命令：** `/gsd-docs-update`

**目的：** 通過準確性檢查生成和驗證專案文件。

**需求：**
- REQ-DOCS-01：系統必須派生 `gsd-doc-writer` 智慧體生成文件
- REQ-DOCS-02：系統必須派生 `gsd-doc-verifier` 智慧體檢查準確性
- REQ-DOCS-03：系統必須驗證生成的文件與實際實現的一致性

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| 更新的專案文件 | 已生成和驗證的文件檔案 |

**流程：**
1. **生成** — 派生 `gsd-doc-writer` 從實現建立或更新文件
2. **驗證** — 派生 `gsd-doc-verifier` 根據程式碼庫檢查文件準確性
3. **輸出** — 生成帶準確性註釋的已驗證文件

---

### 62. 討論鏈模式

**標誌：** `/gsd-discuss-phase <N> --chain`

**目的：** 在一個流程中自動連結討論、規劃和執行階段，減少手動命令排序。

**需求：**
- REQ-CHAIN-01：提供 `--chain` 標誌時，系統必須自動連結討論 → 規劃 → 執行
- REQ-CHAIN-02：系統必須在連結階段之間遵守所有門控設定
- REQ-CHAIN-03：如果任何階段失敗，系統必須停止鏈

**流程：**
1. **討論** — 執行 discuss-phase 以收集上下文
2. **規劃** — 使用收集的上下文自動呼叫 plan-phase
3. **執行** — 使用生成的計劃自動呼叫 execute-phase

---

### 63. 單階段自主執行

**標誌：** `/gsd-autonomous --only N`

**目的：** 僅自主執行一個階段，而不是所有剩餘階段。

**需求：**
- REQ-ONLY-01：提供 `--only N` 時，系統必須只執行指定的階段號
- REQ-ONLY-02：系統必須遵循與完整自主模式相同的討論 → 規劃 → 執行流程
- REQ-ONLY-03：指定階段完成後，系統必須停止

**流程：**
1. **選擇** — 從 `--only N` 引數識別目標階段
2. **執行** — 為該單個階段執行完整的自主流程（討論 → 規劃 → 執行）
3. **停止** — 階段完成後停止，而不是推進到下一個

---

### 64. 範圍縮減檢測

**屬於：** `/gsd-plan-phase`

**目的：** 通過三層防護防止計劃生成期間需求被靜默刪除。

**需求：**
- REQ-SCOPE-01：系統必須禁止規劃器在沒有明確理由的情況下縮減範圍
- REQ-SCOPE-02：系統必須讓計劃檢查器驗證需求維度覆蓋
- REQ-SCOPE-03：系統必須讓編排器恢復被刪除的需求並重新注入
- REQ-SCOPE-04：系統必須實現三層防護：規劃器禁止、檢查器維度、編排器恢復

**流程：**
1. **禁止** — 規劃器指令明確禁止範圍縮減
2. **檢查** — 計劃檢查器驗證計劃中涵蓋了所有階段需求
3. **恢復** — 編排器檢測被刪除的需求並將其重新注入規劃迴圈

---

### 65. 宣告來源標記

**屬於：** `/gsd-plan-phase --research-phase <N>`

**目的：** 確保研究宣告被標記有來源證據，假設單獨記錄。

**需求：**
- REQ-PROVENANCE-01：研究員必須用來源證據引用標記宣告
- REQ-PROVENANCE-02：假設必須與有來源的宣告分開記錄
- REQ-PROVENANCE-03：系統必須區分有證據的事實和推斷的假設

**流程：**
1. **研究** — 研究員從程式碼庫和領域來源收集資訊
2. **標記** — 每個宣告都用其來源進行註釋（檔案路徑、文件、API 響應）
3. **分離** — 沒有直接證據的假設記錄在獨立節區

---

### 66. 工作樹切換

**配置：** `workflow.use_worktrees: false`

**目的：** 對於偏好順序執行的使用者，停用 git 工作樹隔離。

**需求：**
- REQ-WORKTREE-01：系統在決定隔離策略時必須遵守 `workflow.use_worktrees` 設定
- REQ-WORKTREE-02：系統必須預設為 `true`（啟用工作樹）以保持向後相容
- REQ-WORKTREE-03：停用工作樹時，系統必須回退到順序執行

**配置：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `workflow.use_worktrees` | boolean | `true` | 為 `false` 時，停用 git 工作樹隔離 |

---

### 67. 專案程式碼字首

**配置：** `project_code: "ABC"`

**目的：** 使用專案程式碼為階段目錄名稱新增字首，用於多專案消歧義。

**需求：**
- REQ-PREFIX-01：配置後，系統必須為階段目錄新增專案程式碼字首（例如 `ABC-01-setup/`）
- REQ-PREFIX-02：未設定 `project_code` 時，系統必須使用標準命名
- REQ-PREFIX-03：系統必須在所有階段操作中一致應用字首

**配置：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `project_code` | string | （無） | 階段目錄名稱的字首 |

---

### 68. Claude Code 技能遷移

**屬於：** `npx @opengsd/gsd-core`

**目的：** 將 GSD 命令遷移到 Claude Code 2.1.88+ 技能格式，同時保持向後相容性。

**需求：**
- REQ-SKILLS-01：安裝器必須為 Claude Code 2.1.88+ 寫入 `skills/gsd-*/SKILL.md`
- REQ-SKILLS-02：安裝器必須自動清理舊版 `commands/gsd/` 目錄
- REQ-SKILLS-03：安裝器必須通過 Gemini 路徑維護與舊版 Claude Code 的向後相容性

**流程：**
1. **檢測** — 檢查 Claude Code 版本以確定技能支援情況
2. **遷移** — 為每個 GSD 命令寫入 `skills/gsd-*/SKILL.md` 檔案
3. **清理** — 如果已安裝技能，則刪除舊版 `commands/gsd/` 目錄
4. **回退** — 為舊版 Claude Code 維護 Gemini 路徑相容性

---

## v1.32 功能

### 69. STATE.md 一致性門控

**命令：** `state validate`、`state sync [--verify]`、`state planned-phase --phase N --plans N`

**目的：** 檢測並修復 STATE.md 與實際檔案系統之間的漂移，防止過時狀態導致的級聯錯誤。

**需求：**
- REQ-STATE-01：`state validate` 必須檢測 STATE.md 欄位與檔案系統現實之間的漂移
- REQ-STATE-02：`state sync` 必須從磁碟上的實際專案狀態重建 STATE.md
- REQ-STATE-03：`state sync --verify` 必須執行演習，顯示建議的更改而不寫入
- REQ-STATE-04：`state planned-phase` 必須在 plan-phase 完成後記錄狀態轉換（已計劃/準備執行）

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| 更新的 `STATE.md` | 反映檔案系統現實的已更正狀態 |

**流程：**
1. **驗證** — 將 STATE.md 欄位與檔案系統（階段目錄、計劃檔案、摘要）進行比較
2. **同步** — 檢測到漂移時從磁碟重建 STATE.md
3. **轉換** — 記錄帶有計劃數量的規劃後狀態，用於執行階段準備就緒

---

### 70. 自主 `--to N` 標誌

**標誌：** `/gsd-autonomous --to N`

**目的：** 在完成特定階段後停止自主執行，允許部分自主執行。

**需求：**
- REQ-TO-01：系統必須在指定的階段號完成後停止執行
- REQ-TO-02：系統必須對每個直到 N 的階段遵循相同的討論 -> 規劃 -> 執行流程
- REQ-TO-03：`--to N` 必須可與 `--from N` 組合，用於有界自主範圍

**流程：**
1. **限制** — 從 `--to N` 引數設定階段上限
2. **執行** — 對每個直到（包括）階段 N 的階段執行自主流程
3. **停止** — 階段 N 完成後停止

---

### 71. 研究門控

**屬於：** `/gsd-plan-phase`

**目的：** 當 RESEARCH.md 有未解決的開放問題時阻止規劃，防止在不完整資訊基礎上制定計劃。

**需求：**
- REQ-RESGATE-01：規劃開始前，系統必須掃描 RESEARCH.md 中未解決的開放問題
- REQ-RESGATE-02：當存在開放問題時，系統必須阻止進入 plan-phase
- REQ-RESGATE-03：系統必須向用戶呈現具體的未解決問題

**流程：**
1. **掃描** — 檢查 RESEARCH.md 中帶有未解決專案的開放問題節區
2. **門控** — 發現未解決問題時阻止規劃
3. **呈現** — 顯示需要解決的具體開放問題

---

### 72. 驗證器里程碑範圍過濾

**屬於：** `/gsd-execute-phase`（驗證器步驟）

**目的：** 區分真正的間隙和推遲到後續階段的專案，減少驗證中的假陰性。

**需求：**
- REQ-VSCOPE-01：驗證器必須檢查間隙是否在後續里程碑階段中得到解決
- REQ-VSCOPE-02：在後續階段中解決的間隙必須標記為"推遲"，而不是"間隙"
- REQ-VSCOPE-03：只有真正的間隙（未被任何未來階段覆蓋）必須報告為失敗

**流程：**
1. **驗證** — 執行標準的目標反向驗證
2. **過濾** — 將檢測到的間隙與後續里程碑階段進行交叉引用
3. **分類** — 將推遲的專案與真正的間隙分開標記

---

### 73. 編輯前讀取守護鉤子

**屬於：** 鉤子（`PreToolUse`）

**目的：** 通過確保在編輯之前讀取檔案，防止非 Claude 執行時中的無限重試迴圈。

**需求：**
- REQ-RBE-01：鉤子必須檢測針對在會話中未先讀取的檔案的 Edit/Write 工具呼叫
- REQ-RBE-02：鉤子必須建議先讀取檔案（建議性，非阻塞）
- REQ-RBE-03：鉤子必須防止在沒有內建編輯前讀取強制的執行時中常見的無限重試迴圈

---

### 74. 上下文壓縮

**屬於：** 提示組裝流水線

**目的：** 通過 Markdown 截斷和快取友好的提示排序來減少上下文提示大小。

**需求：**
- REQ-CTXRED-01：系統必須截斷超大 Markdown 構件以適應上下文預算
- REQ-CTXRED-02：系統必須為快取友好的組裝對提示進行排序（穩定的字首優先）
- REQ-CTXRED-03：壓縮必須保留必要資訊（標題、需求、任務結構）
- REQ-CTXRED-04：技能 `description:` 欄位必須 ≤ 100 個字元；由 `npm run lint:descriptions` 強制執行（參見 `scripts/lint-descriptions.cjs` 和 `tests/enh-2789-description-budget.test.cjs`）

**流程：**
1. **測量** — 計算工作流的總提示大小
2. **截斷** — 對超大構件應用 Markdown 感知截斷
3. **排序** — 為最優 KV 快取重用安排提示節區

---

### 75. 討論階段 `--power` 標誌

**標誌：** `/gsd-discuss-phase --power`

**目的：** 基於檔案的 discuss-phase 批次問題回答，支援從準備好的答案檔案進行批次輸入。

**需求：**
- REQ-POWER-01：系統必須接受包含討論問題預寫答案的檔案
- REQ-POWER-02：系統必須將答案對映到對應的灰色地帶問題
- REQ-POWER-03：系統必須生成與互動式 discuss-phase 相同的 CONTEXT.md

---

### 76. 除錯 `--diagnose` 標誌

**標誌：** `/gsd-debug --diagnose`

**目的：** 僅診斷模式，調查但不嘗試修復。

**需求：**
- REQ-DIAG-01：系統必須執行完整的除錯調查（假設、證據、根因）
- REQ-DIAG-02：系統不得嘗試任何程式碼修改
- REQ-DIAG-03：系統必須生成包含發現結果和推薦修復的診斷報告

---

### 77. 階段依賴分析

**命令：** `/gsd-manager --analyze-deps`

**目的：** 在執行 `/gsd-manager` 之前檢測階段依賴關係，並建議在 ROADMAP.md 中新增 `Depends on` 條目。

**需求：**
- REQ-DEP-01：系統必須檢測階段間的檔案重疊
- REQ-DEP-02：系統必須檢測語義依賴（API/Schema 生產者和消費者）
- REQ-DEP-03：系統必須檢測資料流依賴（輸出生產者和讀取者）
- REQ-DEP-04：系統必須在寫入前提出帶使用者確認的依賴條目建議

**產出物：** 依賴建議表；可選擇更新 ROADMAP.md `Depends on` 欄位

---

### 78. 反模式嚴重級別

**屬於：** `/gsd-resume-work`

**目的：** 在恢復時進行強制性理解檢查，並基於嚴重性的反模式強制執行。

**需求：**
- REQ-ANTI-01：系統必須按嚴重級別對反模式進行分類
- REQ-ANTI-02：系統必須在會話恢復時強制執行理解檢查
- REQ-ANTI-03：較高嚴重性的反模式必須在被確認之前阻止工作流推進

---

### 79. 方法論構件型別

**屬於：** 規劃構件

**目的：** 為方法論文件定義消費機制，確保智慧體正確消費它們。

**需求：**
- REQ-METHOD-01：系統必須將方法論支援為獨特的構件型別
- REQ-METHOD-02：方法論構件必須為智慧體定義消費機制

---

### 80. 規劃器可達性檢查

**屬於：** `/gsd-plan-phase`

**目的：** 在提交執行之前驗證計劃步驟是否可實現。

**需求：**
- REQ-REACH-01：規劃器必須驗證每個計劃步驟引用的檔案和 API 是否可達
- REQ-REACH-02：不可達的步驟必須在規劃期間標記，而不是在執行期間發現

---

### 81. Playwright-MCP UI 驗證

**屬於：** `/gsd-verify-work`（可選）

**目的：** 在 verify-phase 期間使用 Playwright-MCP 進行自動化視覺驗證。

**需求：**
- REQ-PLAY-01：系統必須支援在 verify-phase 期間進行可選的 Playwright-MCP 視覺驗證
- REQ-PLAY-02：視覺驗證必須是選項，而非強制
- REQ-PLAY-03：系統必須根據 UI-SPEC.md 預期捕獲並比較視覺狀態

---

### 82. 暫停工作擴充套件

**屬於：** `/gsd-pause-work`

**目的：** 支援非階段上下文，提供更豐富的切換資料，擴大暫停工作的適用性。

**需求：**
- REQ-PAUSE-01：系統必須支援在非階段上下文（快速任務、除錯會話、執行緒）中暫停
- REQ-PAUSE-02：切換資料必須包含適合當前工作型別的更豐富上下文

---

### 83. 響應語言配置

**配置：** `response_language`

**目的：** 為非英語使用者實現跨階段語言一致性。

**需求：**
- REQ-LANG-01：系統必須在所有階段和智慧體中遵守 `response_language` 設定
- REQ-LANG-02：設定必須傳播到所有派生智慧體，以保持一致的語言輸出

**配置：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `response_language` | string | （無） | 智慧體響應的語言程式碼（例如 `"pt"`、`"ko"`、`"ja"`） |

---

### 84. 手動更新流程

**屬於：** `docs/manual-update.md`

**目的：** 為 `npx` 不可用或 npm 釋出出現故障的環境記錄手動更新路徑。

**需求：**
- REQ-MANUAL-01：文件必須描述逐步的手動更新流程
- REQ-MANUAL-02：流程必須在不使用 npm 訪問的情況下正常工作

---

### 85. 新執行時支援（Trae、Cline、Augment Code）

**屬於：** `npx @opengsd/gsd-core`

**目的：** 將 GSD 安裝擴充套件到 Trae IDE、Cline 和 Augment Code 執行時。

**需求：**
- REQ-TRAE-01：安裝器必須支援 `--trae` 標誌用於 Trae IDE 安裝
- REQ-CLINE-01：安裝器必須通過 `.clinerules` 配置支援 Cline
- REQ-AUGMENT-01：安裝器必須支援帶有技能轉換和配置管理的 Augment Code

---

### 86. 自主 `--interactive` 標誌

**標誌：** `/gsd-autonomous --interactive`

**目的：** 精簡上下文自主模式，保持 discuss-phase 互動（使用者回答問題），同時將規劃和執行作為後臺智慧體派發。

**需求：**
- REQ-INTERACT-01：`--interactive` 必須在主上下文中內聯執行 discuss-phase，進行互動式提問（不自動回答）
- REQ-INTERACT-02：`--interactive` 必須將 plan-phase 和 execute-phase 作為後臺智慧體派發，用於上下文隔離
- REQ-INTERACT-03：`--interactive` 必須啟用流水線並行性 — 在階段 N 構建時討論階段 N+1
- REQ-INTERACT-04：主上下文必須只積累討論對話（精簡上下文）

**流程：**
1. **內聯討論** — 在主上下文中與使用者互動執行 discuss-phase
2. **派發** — 將規劃和執行傳送到帶全新上下文視窗的後臺智慧體
3. **流水線** — 當後臺智慧體構建階段 N 時，開始討論階段 N+1

---

### 87. 提交文件守護鉤子

**鉤子：** `gsd-commit-docs.js`

**目的：** PreToolUse 鉤子，強制執行 `commit_docs` 配置，當 `planning.commit_docs` 為 `false` 時防止提交 `.planning/` 檔案。

**需求：**
- REQ-COMMITDOCS-01：鉤子必須攔截暫存 `.planning/` 檔案的 git commit 命令
- REQ-COMMITDOCS-02：當 `commit_docs` 為 `false` 時，鉤子必須阻止包含 `.planning/` 檔案的提交
- REQ-COMMITDOCS-03：鉤子必須是建議性的 — 當 `commit_docs` 為 `true` 或不存在時不阻止

---

### 88. 社群鉤子選項

**鉤子：** `gsd-validate-commit.sh`、`gsd-session-state.sh`、`gsd-phase-boundary.sh`

**目的：** GSD 專案的可選 git 和會話鉤子，在配置中通過 `hooks.community: true` 門控。

**需求：**
- REQ-COMMUNITY-01：所有社群鉤子在 `.planning/config.json` 中 `hooks.community` 為 `true` 之前必須為無操作
- REQ-COMMUNITY-02：`gsd-validate-commit.sh` 必須對 git commit 訊息強制執行常規提交格式
- REQ-COMMUNITY-03：`gsd-session-state.sh` 必須跟蹤會話狀態轉換
- REQ-COMMUNITY-04：`gsd-phase-boundary.sh` 必須強制執行階段邊界檢查

**配置：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `hooks.community` | boolean | `false` | 啟用用於提交驗證、會話狀態和階段邊界的可選社群鉤子 |

---

## v1.34.0 功能

  - [全域性學習儲存](#89-global-learnings-store)
  - [可查詢程式碼庫智慧](#90-queryable-codebase-intelligence)
  - [執行上下文配置](#91-execution-context-profiles)
  - [門控分類](#92-gates-taxonomy)
  - [程式碼審查流水線](#93-code-review-pipeline)
  - [蘇格拉底式探索](#94-socratic-exploration)
  - [安全撤銷](#95-safe-undo)
  - [計劃匯入](#96-plan-import)
  - [快速程式碼庫掃描](#97-rapid-codebase-scan)
  - [自主審計修復](#98-autonomous-audit-to-fix)
  - [改進的提示注入掃描器](#99-improved-prompt-injection-scanner)
  - [規劃階段停滯檢測](#100-stall-detection-in-plan-phase)
  - [/gsd-progress --next 中的硬停止安全門控](#101-hard-stop-safety-gates-in-gsd-progress---next)
  - [自適應模型預設](#102-adaptive-model-preset)
  - [合併後 Hunk 驗證](#103-post-merge-hunk-verification)

---

### 89. 全域性學習儲存

**命令：** 在階段完成時自動觸發；由規劃器使用
**配置：** `features.global_learnings`

**目的：** 在全域性儲存中持久化跨會話、跨專案的學習成果，以便規劃智慧體能夠從整個專案歷史中的模式學習，而不僅僅是當前會話。

**需求：**
- REQ-LEARN-01：學習成果必須在階段完成時自動從 `.planning/` 複製到全域性儲存
- REQ-LEARN-02：規劃智慧體必須在派生時通過注入接收相關學習成果
- REQ-LEARN-03：注入必須受 `learnings.max_inject` 限制，以避免上下文膨脹
- REQ-LEARN-04：功能必須通過 `features.global_learnings: true` 選項啟用

**配置：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `features.global_learnings` | boolean | `false` | 啟用跨專案學習流水線 |
| `learnings.max_inject` | number | （系統預設值） | 注入規劃器的最大學習條目數 |

---

### 90. 可查詢程式碼庫智慧

**命令：** `/gsd-map-codebase --query [<term>|status|diff|refresh]`
**配置：** `intel.enabled`

**目的：** 在 `.planning/intel/` 中維護可查詢的程式碼庫結構、API 表面、依賴圖、檔案角色和架構決策的 JSON 索引。支援在不讀取整個程式碼庫的情況下進行有針對性的查詢。

**需求：**
- REQ-INTEL-01：Intel 檔案必須作為 JSON 儲存在 `.planning/intel/`
- REQ-INTEL-02：`query` 模式必須在所有 intel 檔案中搜索某個詞並按檔案分組結果
- REQ-INTEL-03：`status` 模式必須報告新鮮度（FRESH/STALE，過期閾值：24 小時）
- REQ-INTEL-04：`diff` 模式必須將當前 intel 狀態與上一個快照進行比較
- REQ-INTEL-05：`refresh` 模式必須派生 intel 更新器智慧體重建所有檔案
- REQ-INTEL-06：功能必須通過 `intel.enabled: true` 選項啟用

**生成的 Intel 檔案：**
| 檔案 | 內容 |
|------|----------|
| `stack.json` | 技術棧和依賴項 |
| `api-map.json` | 匯出函式和 API 表面 |
| `dependency-graph.json` | 模組間依賴關係 |
| `file-roles.json` | 每個原始檔的角色分類 |
| `arch-decisions.json` | 檢測到的架構決策 |

---

### 91. 執行上下文配置

**配置：** `context_profile`

**目的：** 選擇針對特定型別工作調整的預配置執行上下文（模式、模型、工作流設定），無需手動調整單個設定。

**需求：**
- REQ-CTX-01：`dev` 配置必須針對迭代開發最佳化（balanced 模型，啟用 plan_check）
- REQ-CTX-02：`research` 配置必須針對研究密集型工作最佳化（較高模型層級，啟用研究）
- REQ-CTX-03：`review` 配置必須針對程式碼審查工作最佳化（啟用 verifier 和 code_review）

**可用配置：** `dev`、`research`、`review`

**配置：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `context_profile` | string | （無） | 執行上下文預設：`dev`、`research` 或 `review` |

---

### 92. 門控分類

**參考：** `get-shit-done/references/gates.md`
**智慧體：** plan-checker、verifier

**目的：** 定義構建所有工作流決策點的 4 種規範門控型別，使 plan-checker 和 verifier 智慧體能夠應用一致的門控邏輯。

**門控型別：**
| 型別 | 描述 |
|------|-------------|
| **確認（Confirm）** | 繼續前使用者審批（例如，路線圖審查） |
| **品質（Quality）** | 自動化品質檢查必須通過（例如，計劃驗證迴圈） |
| **安全（Safety）** | 檢測到風險或違反策略時的硬停止 |
| **過渡（Transition）** | 階段或里程碑邊界確認 |

**需求：**
- REQ-GATES-01：plan-checker 必須將每個檢查點分類為 4 種門控型別之一
- REQ-GATES-02：verifier 必須應用適合門控型別的門控邏輯
- REQ-GATES-03：硬停止安全門控絕不得被 `--auto` 標誌繞過

---

### 93. 程式碼審查流水線

**命令：** `/gsd-code-review`、`/gsd-code-review --fix`

**目的：** 對階段期間更改的原始檔進行結構化審查，並通過單獨的自動修復過程，每次修復以原子化提交。

**需求：**
- REQ-REVIEW-01：`gsd-code-review` 必須使用 SUMMARY.md 和 git diff 回退將檔案範圍限定到階段
- REQ-REVIEW-02：審查必須支援三個深度級別：`quick`、`standard`、`deep`
- REQ-REVIEW-03：發現結果必須按嚴重性分類：Critical、Warning、Info
- REQ-REVIEW-04：`gsd-code-review --fix` 必須讀取 REVIEW.md 並預設修復 Critical + Warning 發現
- REQ-REVIEW-05：每次修復必須以描述性訊息原子化提交
- REQ-REVIEW-06：`--auto` 標誌必須啟用修復 + 重新審查的迭代迴圈，上限為 3 次迭代
- REQ-REVIEW-07：功能必須受 `workflow.code_review` 配置標誌門控

**配置：**
| 設定 | 型別 | 預設值 | 描述 |
|---------|------|---------|-------------|
| `workflow.code_review` | boolean | `true` | 啟用程式碼審查命令 |
| `workflow.code_review_depth` | string | `standard` | 預設審查深度：`quick`、`standard` 或 `deep` |

---

### 94. 蘇格拉底式探索

**命令：** `/gsd-explore [topic]`

**目的：** 在提交計劃之前，通過蘇格拉底式探究性問題引導開發者探索想法。將輸出路由到適當的 GSD 構件：筆記、待辦事項、種子、研究問題、需求更新或新階段。

**需求：**
- REQ-EXPLORE-01：探索必須使用蘇格拉底式探究 — 在提出解決方案之前提問
- REQ-EXPLORE-02：會話必須提供將輸出路由到適當 GSD 構件的選項
- REQ-EXPLORE-03：可選的主題引數必須為第一個問題提供引導
- REQ-EXPLORE-04：探索必須可選擇派生研究智慧體進行技術可行性分析

---

### 95. 安全撤銷

**命令：** `/gsd-undo --last N | --phase NN | --plan NN-MM`

**目的：** 使用階段清單和 git 日誌安全回滾 GSD 階段或計劃提交，進行依賴性檢查，並在應用任何回滾之前設定硬確認門控。

**需求：**
- REQ-UNDO-01：`--phase` 模式必須通過清單和 git 日誌回退識別階段的所有提交
- REQ-UNDO-02：`--plan` 模式必須識別特定計劃的所有提交
- REQ-UNDO-03：`--last N` 模式必須顯示最近的 GSD 提交供互動式選擇
- REQ-UNDO-04：系統必須在回滾之前檢查依賴的階段/計劃
- REQ-UNDO-05：執行任何 git revert 之前必須顯示確認門控

---

### 96. 計劃匯入

**命令：** `/gsd-import --from <filepath>`

**目的：** 將外部計劃檔案攝入 GSD 規劃系統，檢測與 `PROJECT.md` 決策的衝突，將其轉換為有效的 GSD PLAN.md，並通過 plan-checker 進行驗證。

**需求：**
- REQ-IMPORT-01：匯入器必須檢測外部計劃與現有 PROJECT.md 決策之間的衝突
- REQ-IMPORT-02：所有檢測到的衝突必須在寫入之前呈現給使用者解決
- REQ-IMPORT-03：匯入的計劃必須以有效的 GSD PLAN.md 格式寫入
- REQ-IMPORT-04：寫入的計劃必須通過 `gsd-plan-checker` 驗證

---

### 97. 快速程式碼庫掃描

**命令：** `/gsd-map-codebase --fast [--focus tech|arch|quality|concerns]`

**目的：** `/gsd-map-codebase` 的輕量級替代方案，為一兩個組合的焦點區域派生單個對映智慧體，在 `.planning/codebase/` 中生成有針對性的輸出，無需 4 個並行智慧體的開銷。

**需求：**
- REQ-SCAN-01：掃描必須精確派生一個對映智慧體（而非四個並行智慧體）
- REQ-SCAN-02：焦點區域必須是以下之一：`tech`、`arch`、`quality`、`concerns` 或組合的 `tech+arch` 簡寫（預設：`tech+arch`）；組合焦點在單次通過中作為單個智慧體執行，覆蓋兩個區域
- REQ-SCAN-03：輸出必須以與 `/gsd-map-codebase` 相同的格式寫入 `.planning/codebase/`

---

### 98. 自主審計修復

**命令：** `/gsd-audit-fix [--source <audit>] [--severity high|medium|all] [--max N] [--dry-run]`

**目的：** 端到端流水線，執行審計，將發現結果分類為可自動修復與僅手動處理，然後自主修復可自動修復的問題，進行測試驗證並原子化提交。

**需求：**
- REQ-AUDITFIX-01：進行任何更改之前，發現結果必須被分類為可自動修復或僅手動處理
- REQ-AUDITFIX-02：每次修復必須在提交之前通過測試驗證
- REQ-AUDITFIX-03：每次修復必須原子化提交
- REQ-AUDITFIX-04：`--dry-run` 必須顯示分類表而不應用任何修復
- REQ-AUDITFIX-05：`--max N` 必須限制單次執行中應用的修復數量（預設：5）

---

### 99. 改進的提示注入掃描器

**鉤子：** `gsd-prompt-guard.js`
**指令碼：** `scripts/prompt-injection-scan.sh`

**目的：** 增強對規劃構件中提示注入嘗試的檢測，新增不可見 Unicode 字元檢測、編碼混淆模式和基於熵的分析。

**需求：**
- REQ-SCAN-INJ-01：掃描器必須檢測不可見 Unicode 字元（零寬空格、軟連字元等）
- REQ-SCAN-INJ-02：掃描器必須檢測編碼混淆模式（base64 編碼的指令、同形字）
- REQ-SCAN-INJ-03：掃描器必須應用熵分析以標記意外位置的高熵字串
- REQ-SCAN-INJ-04：掃描器必須保持僅建議性 — 檢測會被記錄，而不會阻止

---

### 100. 規劃階段停滯檢測

**命令：** `/gsd-plan-phase`

**目的：** 檢測規劃器修訂迴圈何時停滯——在多次迭代中產生相同的輸出——並通過升級到不同策略或以明確診斷退出來打破迴圈。

**需求：**
- REQ-STALL-01：修訂迴圈必須檢測連續迭代中相同的計劃輸出
- REQ-STALL-02：檢測到停滯時，系統必須在重試之前升級策略
- REQ-STALL-03：最大停滯重試次數必須有界（上限為現有最大 3 次迭代）

---

### 101. /gsd-progress --next 中的硬停止安全門控

**命令：** `/gsd-progress --next`

**目的：** 通過新增硬停止安全門控和連續呼叫守護來阻止 `/gsd-progress --next` 進入失控迴圈，該守護在檢測到重複的相同步驟時中斷自主鏈式操作。

**需求：**
- REQ-NEXT-GATE-01：`/gsd-progress --next` 必須跟蹤連續的相同步驟呼叫
- REQ-NEXT-GATE-02：重複相同步驟時，系統必須向用戶呈現硬停止門控
- REQ-NEXT-GATE-03：使用者必須明確確認才能通過硬停止門控繼續

---

### 102. 自適應模型預設

**配置：** `model_profile: "adaptive"`

**目的：** 基於角色的模型分配，根據當前智慧體的角色自動選擇適當的模型層級，而不是對所有智慧體應用單一層級。

**需求：**
- REQ-ADAPTIVE-01：`adaptive` 預設必須根據智慧體角色分配模型層級（規劃器 → quality 層，執行器 → balanced 層等）
- REQ-ADAPTIVE-02：`adaptive` 必須可通過 `/gsd-config --profile adaptive` 選擇

---

### 103. 合併後 Hunk 驗證

**命令：** `/gsd-update --reapply`

**目的：** 在更新後應用本地補丁後，通過將預期的補丁內容與即時檔案系統進行比較，驗證所有 hunk 是否實際被應用。立即呈現任何被丟棄或部分應用的 hunk，而不是靜默接受不完整的合併。

**需求：**
- REQ-PATCH-VERIFY-01：重新應用補丁必須在合併後驗證每個 hunk 是否被應用
- REQ-PATCH-VERIFY-02：被丟棄或部分應用的 hunk 必須向用戶報告，附帶檔案和行上下文
- REQ-PATCH-VERIFY-03：驗證必須在所有補丁應用後執行，而不是逐個補丁執行

---

## v1.35.0 功能

- [新執行時支援（Cline、CodeBuddy、Qwen Code）](#104-new-runtime-support-cline-codebuddy-qwen-code)
- [GSD-2 反向遷移](#105-gsd-2-reverse-migration)
- [AI 整合階段嚮導](#106-ai-integration-phase-wizard)
- [AI 評估審查](#107-ai-eval-review)

---

### 104. 新執行時支援（Cline、CodeBuddy、Qwen Code）

**屬於：** `npx @opengsd/gsd-core`

**目的：** 將 GSD 安裝擴充套件到 Cline、CodeBuddy 和 Qwen Code 執行時。

**需求：**
- REQ-CLINE-02：Cline 安裝必須將 `.clinerules` 寫入 `~/.cline/`（全域性）或 `./.cline/`（本地）。無自定義斜槓命令 — 僅基於規則的整合。標誌：`--cline`。
- REQ-CODEBUDDY-01：CodeBuddy 安裝必須將技能部署到 `~/.codebuddy/skills/gsd-*/SKILL.md`。標誌：`--codebuddy`。
- REQ-QWEN-01：Qwen Code 安裝必須將技能部署到 `~/.qwen/skills/gsd-*/SKILL.md`，遵循 Claude Code 2.1.88+ 使用的開放標準。`QWEN_CONFIG_DIR` 環境變數覆蓋預設路徑。標誌：`--qwen`。

**執行時摘要：**

| 執行時 | 安裝格式 | 配置路徑 | 標誌 |
|---------|---------------|-------------|------|
| Cline | `.clinerules` | `~/.cline/` 或 `./.cline/` | `--cline` |
| CodeBuddy | Skills (`SKILL.md`) | `~/.codebuddy/skills/` | `--codebuddy` |
| Qwen Code | Skills (`SKILL.md`) | `~/.qwen/skills/` | `--qwen` |

---

### 105. GSD-2 反向遷移

**命令：** `/gsd-import --from-gsd2 [--dry-run] [--force] [--path <dir>]`

**目的：** 將專案從 GSD-2 格式（帶里程碑→切片→任務層次結構的 `.gsd/` 目錄）遷移回 v1 `.planning/` 格式，恢復與所有 GSD v1 命令的完整相容性。

**需求：**
- REQ-FROM-GSD2-01：匯入器必須從指定或當前目錄讀取 `.gsd/`
- REQ-FROM-GSD2-02：里程碑→切片層次結構必須展平為順序階段號（M001/S01→階段 01，M001/S02→階段 02，M002/S01→階段 03，等）
- REQ-FROM-GSD2-03：系統必須防止在沒有 `--force` 的情況下覆蓋現有的 `.planning/` 目錄
- REQ-FROM-GSD2-04：`--dry-run` 必須預覽所有更改而不寫入任何檔案
- REQ-FROM-GSD2-05：遷移必須生成 `PROJECT.md`、`REQUIREMENTS.md`、`ROADMAP.md`、`STATE.md` 和順序階段目錄

**標誌：**

| 標誌 | 描述 |
|------|-------------|
| `--dry-run` | 預覽遷移輸出而不寫入檔案 |
| `--force` | 覆蓋現有的 `.planning/` 目錄 |
| `--path <dir>` | 指定 GSD-2 根目錄 |

---

### 106. AI 整合階段嚮導

**命令：** `/gsd-ai-integration-phase [N]`

**目的：** 引導開發者在專案階段選擇、整合和規劃 AI/LLM 能力的評估。生成結構化的 `AI-SPEC.md`，輸入規劃和驗證。

**需求：**
- REQ-AISPEC-01：嚮導必須呈現涵蓋框架選擇、模型選擇和整合方式的互動式決策矩陣
- REQ-AISPEC-02：系統必須呈現與專案型別相關的特定領域失敗模式和評估標準
- REQ-AISPEC-03：系統必須派生 3 個並行專業智慧體：領域研究員、框架選擇器和評估規劃器
- REQ-AISPEC-04：輸出必須生成帶有框架推薦、實現指南和評估策略的 `{phase}-AI-SPEC.md`

**產出物：** 階段目錄中的 `{phase}-AI-SPEC.md`

---

### 107. AI 評估審查

**命令：** `/gsd-eval-review [N]`

**目的：** 對已執行 AI 階段的評估覆蓋與 `AI-SPEC.md` 計劃進行追溯審計。在階段關閉之前識別計劃與實現評估之間的間隙。

**需求：**
- REQ-EVALREVIEW-01：審查必須讀取指定階段的 `AI-SPEC.md`
- REQ-EVALREVIEW-02：每個評估維度必須被評為 COVERED、PARTIAL 或 MISSING
- REQ-EVALREVIEW-03：輸出必須包含發現結果、間隙描述和補救指南
- REQ-EVALREVIEW-04：`EVAL-REVIEW.md` 必須寫入階段目錄

**產出物：** 帶評分評估維度、間隙分析和補救步驟的 `{phase}-EVAL-REVIEW.md`

---

## v1.36.0 功能

### 108. 計劃彈跳

**命令：** `/gsd-plan-phase N --bounce`

**目的：** 計劃通過檢查器後，可選地通過外部指令碼（第二個 AI、linter、自定義驗證器）對其進行最佳化。彈跳步驟備份每個計劃，執行指令碼，驗證結果的 YAML 前置後設資料完整性，重新執行計劃檢查器，如果任何步驟失敗則從備份恢復。

**需求：**
- REQ-BOUNCE-01：`--bounce` 標誌或 `workflow.plan_bounce: true` 啟用該步驟；`--skip-bounce` 始終停用它
- REQ-BOUNCE-02：`workflow.plan_bounce_script` 必須指向有效的執行檔；缺少指令碼會產生警告並跳過
- REQ-BOUNCE-03：在指令碼執行之前，每個計劃都備份到 `*-PLAN.pre-bounce.md`
- REQ-BOUNCE-04：YAML 前置後設資料損壞或無法通過 plan-checker 的彈跳計劃將從備份恢復
- REQ-BOUNCE-05：`workflow.plan_bounce_passes`（預設：2）控制指令碼接收多少次最佳化遍歷

**配置：** `workflow.plan_bounce`、`workflow.plan_bounce_script`、`workflow.plan_bounce_passes`

---

### 109. 外部程式碼審查命令

**命令：** `/gsd-ship`（增強版）

**目的：** 在 `/gsd-ship` 的手動審查步驟之前，如果已配置，自動執行外部程式碼審查命令。命令通過 stdin 接收 diff 和階段上下文，並返回 JSON 判決（`APPROVED` 或 `REVISE`）。無論結果如何，都進入現有的手動審查流程。

**需求：**
- REQ-EXTREVIEW-01：`workflow.code_review_command` 必須設定為命令字串；null 表示跳過
- REQ-EXTREVIEW-02：diff 使用 `--stat` 摘要針對 `BASE_BRANCH` 生成
- REQ-EXTREVIEW-03：審查提示通過 stdin 傳遞（從不進行 shell 插值）
- REQ-EXTREVIEW-04：120 秒超時；失敗時捕獲 stderr
- REQ-EXTREVIEW-05：解析 JSON 輸出中的 `verdict`、`confidence`、`summary`、`issues` 欄位

**配置：** `workflow.code_review_command`

---

### 110. 跨 AI 執行委託

**命令：** `/gsd-execute-phase N --cross-ai`

**目的：** 將單個計劃委託給外部 AI 執行時執行。前置後設資料中帶 `cross_ai: true` 的計劃（或使用 `--cross-ai` 時的所有計劃）通過 stdin 傳送到配置的命令。成功處理的計劃從普通執行器佇列中刪除。

**需求：**
- REQ-CROSSAI-01：`--cross-ai` 強制所有計劃通過跨 AI；`--no-cross-ai` 停用它
- REQ-CROSSAI-02：每個計劃啟用需要 `workflow.cross_ai_execution: true` 和計劃前置後設資料 `cross_ai: true`
- REQ-CROSSAI-03：任務提示通過 stdin 傳遞，以防止注入
- REQ-CROSSAI-04：髒工作樹在執行前產生警告
- REQ-CROSSAI-05：失敗時，使用者選擇：重試、跳過（回退到普通執行器）或中止

**配置：** `workflow.cross_ai_execution`、`workflow.cross_ai_command`、`workflow.cross_ai_timeout`

---

### 111. 架構職責對映

**命令：** `/gsd-plan-phase`（增強研究步驟）

**目的：** 在階段研究期間，階段研究員現在將每個能力對映到其架構層所有者（瀏覽器、前端伺服器、API、CDN/靜態、資料庫）。規劃器對照此對映交叉檢查任務，plan-checker 將層級合規性作為維度 7c 強制執行。

**需求：**
- REQ-ARM-01：階段研究員在 RESEARCH.md 中生成架構職責對映表（步驟 1.5）
- REQ-ARM-02：規劃器對照對映進行任務到層級分配的健全性檢查
- REQ-ARM-03：計劃檢查器將層級合規性驗證為維度 7c（一般不匹配時為 WARNING，安全敏感時為 BLOCKER）

**產出物：** `{phase}-RESEARCH.md` 中的 `## Architectural Responsibility Map` 節區

---

### 112. 提取學習成果

**命令：** `/gsd-extract-learnings N`

**目的：** 從已完成階段構件中提取結構化知識。讀取 PLAN.md 和 SUMMARY.md（必需）以及 VERIFICATION.md、UAT.md 和 STATE.md（可選），生成四類學習成果：決策、教訓、模式和驚喜。可選擇通過 `capture_thought` 工具將每個專案捕獲到外部知識庫。

**需求：**
- REQ-LEARN-01：需要 PLAN.md 和 SUMMARY.md；缺失時以清晰的錯誤退出
- REQ-LEARN-02：每個提取的專案包括來源歸屬（構件和節區）
- REQ-LEARN-03：如果 `capture_thought` 工具可用，使用 `source`、`project` 和 `phase` 後設資料捕獲專案
- REQ-LEARN-04：如果 `capture_thought` 不可用，成功完成並記錄外部捕獲已跳過
- REQ-LEARN-05：執行兩次會覆蓋之前的 `LEARNINGS.md`

**產出物：** 帶 YAML 前置後設資料（階段、專案、每類別計數、missing_artifacts）的 `{phase}-LEARNINGS.md`

**可選整合 — `capture_thought`：** `capture_thought` 是**一種約定，而非捆綁工具**。GSD 不附帶一個，也不要求一個。工作流檢查當前會話中是否有任何 MCP 伺服器暴露名為 `capture_thought` 的工具，如果有，則為每個提取的學習呼叫一次，簽名如下。如果不存在此類工具，則該步驟靜默跳過，`LEARNINGS.md` 仍然是主要輸出。

預期的工具簽名：
```javascript
capture_thought({
  category: "decision" | "lesson" | "pattern" | "surprise",
  phase: <phase_number>,
  content: <learning_text>,
  source: <artifact_name>
})
```

執行記憶體/知識庫 MCP 伺服器（例如 ExoCortex 風格伺服器、`claude-mem` 或 `mem0` 風格伺服器）的使用者可以實現此工具名稱，以便學習成果自動路由到其知識庫，附帶 `project`、`phase` 和 `source` 後設資料。其他使用者可以在不進行任何額外設定的情況下使用 `/gsd-extract-learnings` — `LEARNINGS.md` 構件就是該功能。

---

### 114. 上下文視窗感知提示精簡

**目的：** 對於上下文視窗低於 200K tokens 的模型，將靜態提示開銷減少約 40%。將擴充套件示例和反模式列表從智慧體定義中提取到按需通過 `@` required_reading 載入的參考檔案中。

**需求：**
- REQ-THIN-01：當 `CONTEXT_WINDOW < 200000` 時，執行器和規劃器智慧體提示省略內聯示例
- REQ-THIN-02：提取的內容儲存在 `references/executor-examples.md` 和 `references/planner-antipatterns.md`
- REQ-THIN-03：標準（200K-500K）和富集（500K+）層級不受影響
- REQ-THIN-04：核心規則和決策邏輯保留內聯；只提取冗長的示例

**參考檔案：** `executor-examples.md`、`planner-antipatterns.md`

---

### 115. 可配置的 CLAUDE.md 路徑

**目的：** 允許專案將其 CLAUDE.md 儲存在非根位置。`claude_md_path` 配置鍵控制 `/gsd-profile-user` 和相關命令寫入生成的 CLAUDE.md 檔案的位置。

**需求：**
- REQ-CMDPATH-01：`claude_md_path` 預設為 `./CLAUDE.md`
- REQ-CMDPATH-02：畫像生成命令從配置讀取路徑並寫入指定位置
- REQ-CMDPATH-03：相對路徑從專案根路徑解析

**配置：** `claude_md_path`

---

### 116. TDD 流水線模式

**目的：** 將 TDD（紅-綠-重構）作為一等階段執行模式選項啟用。啟用後，規劃器積極地為符合條件的任務選擇 `type: tdd`，執行器強制執行 RED/GREEN/REFACTOR 門控序列，並在 RED 之前出現意外的 GREEN 時快速失敗。

**需求：**
- REQ-TDD-01：`workflow.tdd_mode` 配置鍵（布林值，預設 `false`）
- REQ-TDD-02：啟用後，規劃器對所有符合條件的任務（業務邏輯、API、驗證、演算法、狀態機）應用 `references/tdd.md` 中的 TDD 啟發式方法
- REQ-TDD-03：執行器對 `type: tdd` 計劃強制執行門控序列 — RED 提交（`test(...)`）必須在 GREEN 提交（`feat(...)`）之前
- REQ-TDD-04：在 RED 階段測試意外通過時執行器快速失敗（功能已存在或測試有誤）
- REQ-TDD-05：階段末協作審查檢查點驗證所有 TDD 計劃的門控合規性（建議性，非阻塞）
- REQ-TDD-06：門控違規在 SUMMARY.md 的 `## TDD Gate Compliance` 節區中呈現

**配置：** `workflow.tdd_mode`
**參考檔案：** `tdd.md`、`checkpoints.md`

---

## v1.37.0 功能

### 117. Spike 命令

**命令：** `/gsd-spike [idea] [--quick]`

**目的：** 在提交實現方案之前執行 2–5 個專注的可行性實驗。每個實驗使用 Given/When/Then 框架，生成可執行程式碼，並返回 VALIDATED / INVALIDATED / PARTIAL 判決。配套的 `/gsd-spike --wrap-up` 將發現結果打包為專案本地技能。

**需求：**
- REQ-SPIKE-01：在編寫任何程式碼之前，每個實驗必須生成 Given/When/Then 假設
- REQ-SPIKE-02：每個實驗必須包含可執行的程式碼或最小化復現
- REQ-SPIKE-03：每個實驗必須返回以下之一：帶證據的 VALIDATED、INVALIDATED 或 PARTIAL 判決
- REQ-SPIKE-04：結果必須儲存在 `.planning/spikes/NNN-experiment-name/` 中，附帶 README 和 MANIFEST.md
- REQ-SPIKE-05：`--quick` 標誌跳過攝入對話，使用引數文本作為實驗方向
- REQ-SPIKE-06：`/gsd-spike --wrap-up` 必須將發現結果打包到 `.claude/skills/spike-findings-[project]/`

**產出物：**

| 構件 | 描述 |
|----------|-------------|
| `.planning/spikes/NNN-name/README.md` | 假設、實驗程式碼、判決和證據 |
| `.planning/spikes/MANIFEST.md` | 所有 spike 的帶判決索引 |
| `.claude/skills/spike-findings-[project]/` | 打包的發現結果（通過 `/gsd-spike --wrap-up`） |

---

### 118. Sketch 命令

**命令：** `/gsd-sketch [idea] [--quick] [--text]`

**目的：** 在提交實現之前通過一次性 HTML 模型探索設計方向。每個設計問題生成 2–3 個互動式變體，無需構建步驟即可直接在瀏覽器中檢視。配套的 `/gsd-sketch --wrap-up` 將獲勝決策打包為專案本地技能。

**需求：**
- REQ-SKETCH-01：每個 sketch 必須回答一個具體的視覺設計問題
- REQ-SKETCH-02：每個 sketch 必須在帶標籤導航的單個 `index.html` 中包含 2–3 個有意義的不同變體
- REQ-SKETCH-03：所有互動元素（懸停、點選、過渡）必須可正常執行
- REQ-SKETCH-04：Sketch 必須使用真實感內容，而非 lorem ipsum
- REQ-SKETCH-05：共享的 `themes/default.css` 必須提供根據商定美學調整的 CSS 變數
- REQ-SKETCH-06：`--quick` 標誌跳過情緒採集；`--text` 標誌用編號列表替換 `AskUserQuestion`，適用於非 Claude 執行時
- REQ-SKETCH-07：獲勝變體必須在 README 前置後設資料和 HTML 標籤中用 ★ 標記
- REQ-SKETCH-08：`/gsd-sketch --wrap-up` 必須將獲勝決策打包到 `.claude/skills/sketch-findings-[project]/`

**產出物：**
| 構件 | 描述 |
|----------|-------------|
| `.planning/sketches/NNN-name/index.html` | 2–3 個互動式 HTML 變體 |
| `.planning/sketches/NNN-name/README.md` | 設計問題、變體、獲勝者、關注點 |
| `.planning/sketches/themes/default.css` | 共享 CSS 主題變數 |
| `.planning/sketches/MANIFEST.md` | 所有 sketch 的帶獲勝者索引 |
| `.claude/skills/sketch-findings-[project]/` | 打包的決策（通過 `/gsd-sketch --wrap-up`） |

---

### 119. 智慧體大小預算強制

**目的：** 在 CI 中通過分級行數限制使智慧體提示檔案保持精簡。超大智慧體在投入生產膨脹上下文視窗之前被捕獲。

**需求：**
- REQ-BUDGET-01：`agents/gsd-*.md` 檔案分為三個層級：XL（≤ 1 600 行）、Large（≤ 1 000 行）、Default（≤ 500 行）
- REQ-BUDGET-02：層級分配在檔案的 YAML 前置後設資料中宣告（`size: xl | large | default`）
- REQ-BUDGET-03：`tests/agent-size-budget.test.cjs` 強制執行限制，違規時 CI 失敗
- REQ-BUDGET-04：沒有 `size` 前置後設資料鍵的檔案預設為 Default（500 行）限制

**測試檔案：** `tests/agent-size-budget.test.cjs`

---

### 120. 共享樣板提取

**目的：** 通過將兩個常見樣板塊提取到按需載入的共享參考檔案中，減少智慧體間的重複。使智慧體檔案保持在大小預算內，並使樣板更新成為單檔案更改。

**需求：**
- REQ-BOILER-01：強制初始讀取指令提取到 `references/mandatory-initial-read.md`
- REQ-BOILER-02：專案技能發現指令提取到 `references/project-skills-discovery.md`
- REQ-BOILER-03：之前內聯這些塊的智慧體現在必須通過 `@` required_reading 引用它們

**參考檔案：** `references/mandatory-initial-read.md`、`references/project-skills-discovery.md`

---

### 121. 知識圖譜整合

**目的：** 在 `.planning/graphs/` 中構建、查詢和檢查專案的輕量級知識圖譜。按專案選項啟用。作為 `/gsd-graphify` 使用者介面命令和 `gsd-tools.cjs graphify …` 程式化動詞族公開。通過圖譜檢視補充 `/gsd-map-codebase --query`（快照導向），覆蓋命令、智慧體、工作流和階段的節點和邊。

**需求：**
- REQ-GRAPH-01：通過 `.planning/config.json` 中的 `graphify.enabled: true` 選項啟用。停用時，`/gsd-graphify` 列印啟用提示並停止，不寫入任何內容。
- REQ-GRAPH-02：斜槓命令 `/gsd-graphify` 公開子命令 `build`、`query <term>`、`status`、`diff`。程式化 CLI `node gsd-tools.cjs graphify …` 額外公開 `snapshot`，也在 `graphify build` 的最後一步自動呼叫。
- REQ-GRAPH-03：Build 在可配置的 `graphify.build_timeout`（秒）內執行；超過超時時乾淨中止，不留下部分圖譜。
- REQ-GRAPH-04：`graphify.cjs` 在 `graph.edges` 不存在時回退到 `graph.links`，以便舊圖譜構件繼續渲染。
- REQ-GRAPH-05：Graphify 通過 `gsd-tools.cjs graphify ...` 命令處理器呼叫。

**配置：** `graphify.enabled`、`graphify.build_timeout`
**參考檔案：** `commands/gsd/graphify.md`、`bin/lib/graphify.cjs`

---

## v1.40.0 功能

### 122. 技能介面整合

**目的：** 通過將 31 個微技能摺疊到 4 個新的分組父技能和 6 個現有父技能（作為標誌吸收子操作）中來降低急切技能列表開銷。零功能損失 — 每個刪除的微技能的行為通過整合父技能上的標誌保留。整合後，`commands/gsd/*.md` 包含 59 個子技能（加上 6 個名稱空間元技能，見 #123）。

**需求：**
- REQ-CONSOLIDATE-01：四個新的分組技能替換微技能叢集：
  - `/gsd-capture` — 摺疊 add-todo（預設）、note（`--note`）、add-backlog（`--backlog`）、plant-seed（`--seed`）、check-todos（`--list`）
  - `/gsd-phase` — 摺疊 add-phase（預設）、insert-phase（`--insert`）、remove-phase（`--remove`）、edit-phase（`--edit`）
  - `/gsd-config` — 摺疊 settings-advanced（`--advanced`）、settings-integrations（`--integrations`）、set-profile（`--profile`）
  - `/gsd-workspace` — 摺疊 new-workspace（`--new`）、list-workspaces（`--list`）、remove-workspace（`--remove`）
- REQ-CONSOLIDATE-02：六個現有父技能將 wrap-up / 子操作作為標誌吸收：`/gsd-update --sync`、`/gsd-update --reapply`、`/gsd-sketch --wrap-up`、`/gsd-spike --wrap-up`、`/gsd-map-codebase --fast`、`/gsd-map-codebase --query`、`/gsd-code-review --fix`、`/gsd-progress --do`、`/gsd-progress --next`。
- REQ-CONSOLIDATE-03：刪除的微技能斜槓形式（裸 `gsd-add-todo`、`gsd-add-backlog`、`gsd-plant-seed`、`gsd-check-todos`、`gsd-add-phase`、`gsd-insert-phase`、`gsd-remove-phase`、`gsd-edit-phase`、`gsd-new-workspace`、`gsd-list-workspaces`、`gsd-remove-workspace`、`gsd-settings-advanced`、`gsd-settings-integrations`、`gsd-set-profile`、`gsd-sketch-wrap-up`、`gsd-spike-wrap-up`、`gsd-reapply-patches`、`gsd-code-review-fix`、…）必須解析為"未知命令" — 無影子存根。
- REQ-CONSOLIDATE-04：`autonomous.md` 呼叫 `/gsd-code-review --fix`（之前呼叫已刪除的 `gsd-code-review-fix`）。

**參考 issue：** [#2790](https://github.com/open-gsd/gsd-core/issues/2790)

---

### 123. 名稱空間元技能（兩階段路由）

**目的：** 用兩階段層次路由層替換扁平的急切技能列表。模型看到 6 個名稱空間路由器而不是 86 個條目，選擇名稱空間，然後路由到子技能。描述使用管道分隔的關鍵字標籤（≤ 60 個字元）以獲得路由密度。

**命令：**
- `/gsd-workflow` — 階段流水線路由器（討論/規劃/執行/驗證/階段/進度）
- `/gsd-project` — 專案生命週期（里程碑、審計、摘要）
- `/gsd-quality` — 品質門控（程式碼審查、除錯、審計、安全、評估、UI）
- `/gsd-context` — 程式碼庫智慧（對映、graphify、文件、學習）
- `/gsd-manage` — 配置/工作區/工作流/執行緒/更新/釋出/收件箱
- `/gsd-ideate` — 探索與捕獲（探索、sketch、spike、規範、捕獲）

**Token 成本：**

| | 條目 | 大約 tokens |
|---|---|---|
| v1.40 之前完整安裝 | 86 | ~2,150 |
| 名稱空間元技能 | 6 | ~120 |

**需求：**
- REQ-NS-01：六個 `commands/gsd/ns-*.md` 名稱空間路由器帶管道分隔的關鍵字標籤描述（≤ 60 個字元）。
- REQ-NS-02：現有子技能保持不變，仍可直接呼叫 — 名稱空間技能是附加的，不是替換直接斜槓形式的。
- REQ-NS-03：每個名稱空間路由器的正文包含一個路由表，將使用者意圖對映到 #2790 後整合介面上正確的具體子技能。

**參考 issue：** [#2792](https://github.com/open-gsd/gsd-core/issues/2792)

---

### 124. 上下文視窗利用率守護

**命令：** `/gsd-health --context`

**目的：** 上下文視窗飽和的品質守護。兩個閾值：60% 利用率警告（"考慮使用 `/gsd-thread`"），70% 為臨界（"推理品質可能下降"；根據最近的上下文注意力研究，與斷裂點匹配）。

**需求：**
- REQ-CTX-GUARD-01：`/gsd-health --context` 列印帶當前利用率、閾值層級（`ok` / `warn` / `critical`）和補救建議的結構化狀態行。
- REQ-CTX-GUARD-02：相同的分類以 `gsd-tools.cjs validate context --tokens-used <int> --context-window <int>` 公開 — 狀態行和鉤子呼叫者的結構化封裝（#125）。兩個標誌都是必需的；處理器返回與 REQ-CTX-GUARD-03 中純分類器相同的 `{ percent, state }` 封裝。
- REQ-CTX-GUARD-03：分類器（`bin/lib/context-utilization.cjs`）是純函式：輸入 `(tokensUsed, contextWindow)`，輸出 `{ percent, state }`。易於單元測試，易於從任何呼叫者重用。

**參考 issue：** [#2792](https://github.com/open-gsd/gsd-core/issues/2792)

---

### 125. 階段生命週期狀態行讀取側

**目的：** 在狀態行上呈現階段編排狀態。`parseStateMd()` 讀取四個新的 STATE.md 前置後設資料欄位，`formatGsdState()` 渲染進行中、空閒和進度場景。寫入側連線將在後續 RC 中進行。

**需求：**
- REQ-LIFECYCLE-01：`parseStateMd()` 讀取四個可選欄位：
  - `active_phase` — 編排器執行時的階段號
  - `next_action` — 空閒時的推薦下一命令
  - `next_phases` — 下一個階段號的 YAML 流陣列
  - `progress` — 巢狀的 `total_phases` / `completed_phases` / `percent` 塊
- REQ-LIFECYCLE-02：`formatGsdState()` 按優先順序檢查生命週期欄位並輸出第一個匹配的場景（階段啟用 → 空閒下一推薦 → 里程碑完成 → 預設回退）。
- REQ-LIFECYCLE-03：所有四個欄位預設為 undefined；現有 STATE.md 檔案的渲染與位元組相同。

**參考 issue：** [#2833](https://github.com/open-gsd/gsd-core/issues/2833) — 完整欄位參考和渲染規則見 [`docs/STATE-MD-LIFECYCLE.md`](reference/state-md.md)。

---

## v1.41.0 功能

### 126. 按階段型別選擇模型

**目的：** 在階段級別（規劃、研究、執行、驗證）表達模型調優，無需學習完整的智慧體分類。位於每智慧體 `model_overrides`（精確、冗長）和全域性 `model_profile` 層級（粗粒度、統一）之間。

**配置鍵：** `.planning/config.json` 中的 `models`

**階段型別槽位：**

| 槽位 | 分配的智慧體 |
|------|-----------------|
| `planning` | `gsd-planner`、`gsd-roadmapper`、`gsd-pattern-mapper` |
| `discuss` | （為未來子智慧體保留） |
| `research` | `gsd-phase-researcher`、`gsd-project-researcher`、`gsd-research-synthesizer`、`gsd-codebase-mapper`、`gsd-ui-researcher` |
| `execution` | `gsd-executor`、`gsd-debugger`、`gsd-doc-writer` |
| `verification` | `gsd-verifier`、`gsd-plan-checker`、`gsd-integration-checker`、`gsd-nyquist-auditor`、`gsd-ui-checker`、`gsd-ui-auditor`、`gsd-doc-verifier` |
| `completion` | （為未來子智慧體保留） |

**接受的值：** `"opus"` / `"sonnet"` / `"haiku"` / `"inherit"`

**解析優先順序（從高到低）：**

```text
1. model_overrides[<agent>]
2. dynamic_routing.tier_models[<tier>]   （啟用時）
3. models[<phase_type>]                  （此功能）
4. model_profile
5. 執行時預設值
```

**需求：**
- REQ-PHASE-MODELS-01：`config-schema.cjs` 和 `config-schema.ts` 接受六個命名的 `models.*` 槽位；`config-set` 拒絕未知的階段型別。
- REQ-PHASE-MODELS-02：沒有 `models` 塊的配置與 v1.41 之前的行為完全相同。
- REQ-PHASE-MODELS-03：`discuss` 和 `completion` 被 schema 接受以實現向前相容性；今天設定它們是無操作，直到子智慧體對映到每個。

**參考 issue：** [#3023](https://github.com/open-gsd/gsd-core/pull/3030)

---

### 127. 帶失敗層級升級的動態路由

**目的：** 預設使用低成本層級；當編排器檢測到軟失敗（驗證不確定、plan-check FLAG 等）時自動升級到更強大的模型。

**配置鍵：** `.planning/config.json` 中的 `dynamic_routing`

**行為：**
- `enabled: false`（預設）— 功能關閉；所有智慧體使用優先順序鏈不變。
- `enabled: true` — 解析器為第一次派生選擇 `tier_models[default_tier]`，在編排器檢測到軟失敗時升級一級，受 `max_escalations` 限制。

**組合：** `model_overrides` 始終優先；`dynamic_routing.tier_models[<tier>]` 解析高於 `models.<phase_type>` 和 `model_profile`。

**需求：**
- REQ-DYNROUTE-01：`dynamic_routing.enabled` 作為主開關；為 `false` 或塊不存在時，零行為變化。
- REQ-DYNROUTE-02：`core.cjs` 中的新解析器 `resolveModelForTier(cwd, agent, attempt)` 是編排器整合的單個呼叫點。
- REQ-DYNROUTE-03：`max_escalations` 限制升級鏈，防止失控成本。

**參考 issue：** [#3024](https://github.com/open-gsd/gsd-core/pull/3031)

---

### 128. 更新橫幅選項

**目的：** 向已拒絕或繞過 GSD 狀態行的使用者呈現更新可用性，無需狀態行。

**行為：**
- 安裝時，如果安裝器檢測到沒有 GSD 狀態行，它提供一個選項 `SessionStart` 鉤子。
- 鉤子讀取現有的 `~/.cache/gsd/gsd-update-check.json` 快取 — 與狀態行使用的相同快取 — 僅在有可用更新時列印橫幅。
- 無更新時保持靜默。
- 失敗診斷每 24 小時限流一次。
- 通過 `npx @opengsd/gsd-core --uninstall` 乾淨移除。

**需求：**
- REQ-BANNER-01：橫幅不在沒有明確選項的情況下安裝。
- REQ-BANNER-02：無額外網路請求 — 重用現有的後臺更新檢查快取。
- REQ-BANNER-03：解除安裝路徑刪除橫幅鉤子。

**參考 issue：** [#2795](https://github.com/open-gsd/gsd-core/pull/2795)

---

### 129. Issue 驅動編排指南

**目的：** 記錄從 GitHub / Linear / Jira issue 驅動完整 GSD 工作流的方法，將跟蹤器中心概念對映到現有 GSD 原語。

**文件：** [`docs/issue-driven-orchestration.md`](issue-driven-orchestration.md)

**覆蓋的工作流：**
1. 為每個 issue 建立隔離的工作區（`/gsd-workspace --new`）
2. 執行管理儀表板以瞭解情況（`/gsd-manager`）
3. 自主執行（`/gsd-autonomous`）
4. 驗證和審查（`/gsd-verify-work`、`/gsd-review`）
5. 釋出並關閉 issue（`/gsd-ship`）

無新命令或守護程序 — 純粹是將現有原語對映到跟蹤器驅動工作流的文件構件。

**參考 issue：** [#2840](https://github.com/open-gsd/gsd-core/pull/2840)

---

### 130. Graphify 基於提交的過期檢測

**目的：** 呈現架構圖是從當前提交還是舊提交構建的，補充現有的基於 mtime 的過期訊號。

**命令：** `/gsd-graphify status`

**返回的新欄位（graphify v0.7+ 圖譜）：**

| 欄位 | 型別 | 描述 |
|-------|------|-------------|
| `built_at_commit` | string | 構建圖譜的提交 SHA |
| `current_commit` | string | 當前 `git HEAD` |
| `commits_behind` | number | 圖譜落後 HEAD 多少個提交 |
| `commit_stale` | boolean \| null | `true`=過期，`false`=最新，`null`=不可用（v0.7 之前，非 git） |

**渲染輸出（當訊號可用時）：**
```
Source commit: abc1234 (3 commits behind HEAD)
```

**安全性：** `built_at_commit` 在到達 `git` 之前被驗證為 4–40 個十六進位制字元 — 惡意的 `graph.json` 無法向 argv 注入破折號選項。

**回退：** v0.7 之前的圖譜和非 git 檢出返回 `commit_stale: null`；呼叫者回退到現有的基於 mtime 的 `stale` 標誌。現有使用者無行為變化。

**參考 issue：** [#3170](https://github.com/open-gsd/gsd-core/issues/3170)

---

## v1.42.1 功能

### 132. 包合法性門控

**目的：** 在被幻覺產生、可疑或 slopsquatting 的包名到達 shell 安裝命令之前將其阻止。

**行為：**
- 階段研究為推薦的包編寫 `## Package Legitimacy Audit` 表格。
- 僅通過搜尋驗證的包被視為 `[ASSUMED]`，而不是可信的。
- `[SLOP]` 包從推薦中刪除。
- 需要 `[ASSUMED]` 或可疑包的計劃新增人工驗證檢查點。
- 執行器安裝失敗會暫停進行人工驗證，而不是自動嘗試類似命名的包。

**需求：**
- REQ-PKG-GATE-01：研究必須記錄包登錄檔、年齡、下載/來源訊號、slopcheck 判決和處置。
- REQ-PKG-GATE-02：規劃器必須在執行前門控未驗證或可疑的包安裝。
- REQ-PKG-GATE-03：執行器在包管理器安裝失敗後不得自動替換包名。

**參考：** [v1.42.1 釋出說明](../RELEASE-v1.42.1.md)

---

### 133. 技能介面預算

**目的：** 讓使用者在上下文預算重要時減少已安裝的技能和智慧體介面面積。

**安裝配置檔案：**
| 配置檔案 | 目的 |
|---------|---------|
| `core` | 最小主迴圈介面 |
| `standard` | 核心加常用階段管理命令 |
| `full` | 完整介面；預設 |

**執行時控制：** `/gsd:surface` 列出配置檔案狀態，無需重新安裝即可啟用、停用或重置技能叢集。

**需求：**
- REQ-SURFACE-01：安裝器必須解析 `--profile=<name>` 並將活躍配置檔案持久化在 `.gsd-profile` 中。
- REQ-SURFACE-02：`--minimal` 和 `--core-only` 必須保持為 `--profile=core` 的別名。
- REQ-SURFACE-03：執行時介面狀態必須在安裝配置檔案標記之外持久化。

**參考：** [ADR-0011](../adr/0011-skill-surface-budget-module.md)

---

### 134. 安裝遷移

**目的：** 在安裝和更新期間使執行時配置清理變得明確、可審計且具有回滾意識。

**能力：**
- 首次基線遷移記錄管理的檔案。
- 舊版過期檔案清理在刪除或重寫之前使用所有權證據。
- 使用者擁有的構件被保留。
- 模糊的 GSD 風格檔案通過清晰的報告阻止，而不是被靜默覆蓋。
- 遷移計劃支援演習報告和回滾保護。

**需求：**
- REQ-INSTALL-MIGRATION-01：遷移記錄必須包含後設資料、安裝範圍和所有權證據。
- REQ-INSTALL-MIGRATION-02：所有權模糊時，破壞性操作必須封閉失敗。
- REQ-INSTALL-MIGRATION-03：安裝失敗時，如果存在回滾資料，必須恢復預安裝狀態。

**參考：** [安裝遷移](../installer-migrations.md)

---

### 135. 自定義 Ship PR 正文節區

**命令：** `/gsd-ship`

**配置鍵：** `ship.pr_body_sections`

**目的：** 在不編輯 GSD 工作流檔案的情況下，將專案特定的 PRD 風格節區新增到生成的 PR 正文中。

**行為：** 配置的節區追加在必需的 `Summary`、`Changes`、`Requirements Addressed`、`Verification` 和 `Key Decisions` 節區之後。它們可以從構件標題複製、渲染模板或回退到靜態文本。

**需求：**
- REQ-SHIP-SECTIONS-01：自定義節區不得替換、刪除或重新排序必需的 PR 節區。
- REQ-SHIP-SECTIONS-02：配置驗證必須拒絕未知的模板標記。
- REQ-SHIP-SECTIONS-03：停用的節區必須保留在配置中而不出現在 PR 輸出中。

**參考：** [自定義 PR 正文節區](../ship-pr-body-sections.md)

---

### 136. 評審預設審查者

**命令：** `/gsd-review`

**配置鍵：** `review.default_reviewers`

**目的：** 讓團隊為無標誌 `/gsd-review` 執行選擇預設的審查者子集。

**優先順序：**
```text
explicit reviewer flags -> --all -> review.default_reviewers -> all detected reviewers
```

**需求：**
- REQ-REVIEW-DEFAULTS-01：缺少 `review.default_reviewers` 必須保留之前的全部檢測行為。
- REQ-REVIEW-DEFAULTS-02：空陣列必須被拒絕；刪除該鍵以恢復全部檢測行為。
- REQ-REVIEW-DEFAULTS-03：已知但不可用的審查者必須在診斷中跳過，而不是硬失敗執行。

**參考：** [配置參考](CONFIGURATION.md#reviewer-defaults-for-gsd-review)

---

### 137. Fallow 結構性審查預處理

**命令：** `/gsd-code-review`

**配置鍵：** `code_quality.fallow.*`

**目的：** 在智慧體審查之前新增可選的結構性分析遍歷。

**行為：** 啟用後，GSD 解析 `fallow` 二進位制檔案，執行有界審計，寫入 `FALLOW.json`，並將結構性發現嵌入 `REVIEW.md`。

**需求：**
- REQ-FALLOW-01：Fallow 必須是選項，預設停用。
- REQ-FALLOW-02：缺少或失敗的 fallow 執行必須產生清晰的診斷。
- REQ-FALLOW-03：大於嵌入預算的發現必須在警告的情況下跳過，保留原始 JSON 構件。

**參考：** [配置參考](CONFIGURATION.md#code-quality-settings)

---

### 138. 階段末人工驗證模式

**配置鍵：** `workflow.human_verify_mode`

**目的：** 在保留人工驗證要求的同時減少飛行中的人工檢查點中斷。

**行為：** 預設的 `"end-of-phase"` 模式將人工檢查嵌入 `<verify><human-check>` 塊用於階段審查。`"mid-flight"` 恢復阻塞的 `checkpoint:human-verify` 任務。

**需求：**
- REQ-HUMAN-VERIFY-01：`checkpoint:decision` 和 `checkpoint:human-action` 無論模式如何都必須保持阻塞。
- REQ-HUMAN-VERIFY-02：人工需要的驗證必須保持待處理，直到階段末審查解決。
- REQ-HUMAN-VERIFY-03：沒有該鍵的配置必須使用 `"end-of-phase"`。

**參考：** [檢查點參考](../../get-shit-done/references/checkpoints.md)

---

### 139. 配額與速率限制失敗分類

**命令：** `/gsd-execute-phase`

**目的：** 將提供商配額和速率限制失敗視為等待並恢復的條件，而不是正常的執行器失敗。

**行為：** 智慧體輸出被分類為諸如 `429`、`rate limit`、`usage limit`、`RESOURCE_EXHAUSTED` 和 `usage_limit_reached` 等訊號。匹配的失敗呈現等待重置的恢復路徑。

**需求：**
- REQ-QUOTA-01：配額失敗不得將立即重試作為主要恢復選項。
- REQ-QUOTA-02：分類必須涵蓋 Claude、Copilot、Codex、Gemini 和通用提供商哨兵。
- REQ-QUOTA-03：非配額失敗必須繼續通過正常的執行失敗路徑。

**參考：** [提供商速率限制訊號](../research/provider-rate-limit-signals.md)

---

### 140. 狀態列上下文位置

**配置鍵：** `statusline.context_position`

**目的：** 在窄終端中保持上下文計量器可見。

**選項：**
| 值 | 行為 |
|-------|----------|
| `"end"` | 預設；在行尾附近渲染上下文計量器 |
| `"front"` | 在模型名稱之後立即渲染上下文計量器 |

**需求：**
- REQ-STATUSLINE-POS-01：無效值必須被配置驗證拒絕。
- REQ-STATUSLINE-POS-02：缺少配置必須保留現有的末尾位置渲染。

**參考：** [配置參考](CONFIGURATION.md#statusline-settings)

---

### 141. 里程碑標籤建立開關

**命令：** `/gsd-complete-milestone`

**配置鍵：** `git.create_tag`

**目的：** 讓具有外部發布自動化的專案在不建立本地 git 標籤的情況下完成里程碑。

**行為：** `git.create_tag: false` 跳過里程碑標籤建立。工作流仍然更新里程碑構件和狀態。

**需求：**
- REQ-MILESTONE-TAG-01：缺少配置必須保留自動標籤建立。
- REQ-MILESTONE-TAG-02：現有標籤衝突必須清晰地失敗，而不是覆蓋標籤。
- REQ-MILESTONE-TAG-03：停用標籤建立不得跳過里程碑歸檔。

**參考：** [配置參考](CONFIGURATION.md#git-branching)

---

### 142. 結構化 JSON 錯誤模式

**CLI：** `gsd-tools --json-errors`

**目的：** 為自動化呼叫者提供穩定的機器可讀錯誤封裝。

**行為：** 在 `--json-errors` 下失敗的命令返回帶錯誤型別、訊息、命令上下文和退出對映的結構化 `ok: false` 有效負載，而不是僅有散文的 stderr。

**需求：**
- REQ-JSON-ERRORS-01：未知命令、驗證錯誤、超時、原生失敗、回退失敗和內部錯誤必須對映到規範的錯誤型別。
- REQ-JSON-ERRORS-02：CLI 退出程式碼對映對於自動化呼叫者必須保持穩定。
- REQ-JSON-ERRORS-03：缺少 `--json-errors` 時，人類可讀的輸出必須保持為預設值。

---

## 相關文件

- [命令](COMMANDS.md)
- [配置](CONFIGURATION.md)
- [文件索引](README.md)

**參考：** [JSON 錯誤模式](../json-errors.md)
