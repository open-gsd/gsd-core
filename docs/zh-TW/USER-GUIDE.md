# GSD 使用者指南

GSD Core 的敘述性輔助指南——從這裡開始瞭解系統全貌，然後按連結進入各專項文件。

> **GSD Core 的文件按照 [Diataxis](https://diataxis.fr) 框架組織。**
> 按目標瀏覽：[教程](README.md#tutorials) · [操作指南](README.md#how-to-guides) · [參考手冊](README.md#reference) · [說明](README.md#explanation) · [文件索引](README.md)

---

## 目錄

- [斜槓命令形式](#slash-command-forms-hyphen-vs-colon)
- [名稱空間路由入門](#namespace-routing-primer-gsdnamespace-v140)
- [專案生命週期概覽](#project-lifecycle-overview)
- [工作流程圖](#workflow-diagrams)
- [UI 設計契約](#ui-design-contract)
- [探針與草圖](#spiking--sketching)
- [待辦事項與執行緒](#backlog--threads)
- [工作流與工作區](#workstreams--workspaces)
- [安全](#security)
- [使用示例](#usage-examples)
- [故障排查](#troubleshooting)
- [快速恢復參考](#recovery-quick-reference)
- [專案檔案結構](#project-file-structure)
- [相關資源](#related)

如需從 GitHub / Linear / Jira issue 直接驅動 GSD，請參閱
[issue-driven-orchestration](issue-driven-orchestration.md) 指南——該指南將跟蹤器 issue
對映到工作區 → 討論 → 計劃 → 執行 → 驗證 → 審查 → 釋出的迴圈，使用現有的 GSD 基礎功能實現。

---

## 斜槓命令形式（連字元 vs 冒號）

GSD 向所有支援的執行時提供**同一套技能**，但有兩種斜槓拼寫方式：

- **連字元形式** — `/gsd-command-name` — 供 Claude Code、Copilot、OpenCode、Kilo、Cursor、Windsurf、Augment、Antigravity 和 Trae 使用。
- **冒號形式** — `/gsd:command-name` — **僅供 Gemini CLI 使用**。Gemini 將每個外掛的命令置於外掛 ID 的名稱空間下，因此安裝時會在 `--gemini` 安裝過程中將所有正文引用和命令檔案改寫為冒號形式。

無需手動選擇——安裝器會為您所針對的每個執行時寫入正確形式。在 Gemini 終端上閱讀演示時，將每個斜槓命令中 `gsd` 後的連字元替換為冒號即可。

## 名稱空間路由入門（`gsd:<namespace>`，v1.40）

v1.40 提供了六個**名稱空間元技能**，作為分層路由的第一階段入口——它們將貪婪技能列舉的 token 成本保持在較低水平（6 個路由器約 120 個 token，而扁平列舉 86 個技能約需 2,150 個 token），同時每個具體子技能仍可直接呼叫。每個名稱空間路由器的正文包含一張路由表，將您的意圖對映到正確的具體子技能。

| 名稱空間 | 路由器 | 路由目標 |
|-----------|--------|-----------|
| 階段流水線 | `/gsd-workflow` | discuss / plan / execute / verify / phase / progress |
| 專案生命週期 | `/gsd-project` | milestones, audits, summary |
| 品質關卡 | `/gsd-quality` | code review, debug, audit, security, eval, ui |
| 程式碼庫情報 | `/gsd-context` | map, graphify, docs, learnings |
| 管理 | `/gsd-manage` | config, workspace, workstreams, thread, update, ship, inbox |
| 探索與捕獲 | `/gsd-ideate` | explore, sketch, spike, spec, capture |

您幾乎不需要親自輸入名稱空間路由器。它們的價值在於為模型提供發現正確子技能的路由層——其存在使系統提示只需列出 6 條而非 86 條。如果您已經知道具體命令（例如 `/gsd-plan-phase`），可直接呼叫。

---

## 專案生命週期概覽

GSD 核心迴圈為：**discuss → plan → execute → verify → ship**，每個階段重複一次。包括示例輸出、建立哪些檔案以及所有生效標誌的完整逐步演練，請參閱專項教程。

參見 [您的第一個專案](tutorials/your-first-project.md)。

在開始新里程碑之前對現有程式碼庫進行引導，請參見 [引導現有程式碼庫](tutorials/onboarding-an-existing-codebase.md)。

**相關標誌速覽：**

| 標誌 | 命令 | 使用場景 |
| ---- | ------- | ----------- |
| `--auto` | `/gsd-new-project` | 跳過互動式問題，從 PRD 檔案匯入 |
| `--research` | `/gsd-quick` | 為臨時任務新增研究 Agent |
| `--validate` | `/gsd-quick` | 新增計劃檢查和執行後驗證 |
| `--chain` | `/gsd-discuss-phase` | 自動鏈式執行 discuss → plan → execute 而不中斷 |
| `--skip-research` | `/gsd-plan-phase` | 在領域已熟悉時跳過研究 Agent |
| `--draft` | `/gsd-ship` | 建立草稿 PR 而非待審查 PR |

完整命令參考（含所有標誌）請參閱 [`docs/COMMANDS.md`](COMMANDS.md)。配置選項（模型配置檔案、工作流 Agent、git 分支策略）請參閱 [`docs/CONFIGURATION.md`](CONFIGURATION.md)。

---

## 工作流程圖

### 完整專案生命週期

```text
  ┌──────────────────────────────────────────────────┐
  │                   NEW PROJECT                    │
  │  /gsd-new-project                                │
  │  Questions -> Research -> Requirements -> Roadmap│
  └─────────────────────────┬────────────────────────┘
                            │
             ┌──────────────▼─────────────┐
             │      FOR EACH PHASE:       │
             │                            │
             │  ┌────────────────────┐    │
             │  │ /gsd-discuss-phase │    │  <- Lock in preferences
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ui-phase      │    │  <- Design contract (frontend)
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-plan-phase    │    │  <- Research + Plan + Verify
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-execute-phase │    │  <- Parallel execution
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-verify-work   │    │  <- Manual UAT
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ship          │    │  <- Create PR (optional)
             │  └──────────┬─────────┘    │
             │             │              │
             │     Next Phase?────────────┘
             │             │ No
             └─────────────┼──────────────┘
                            │
            ┌───────────────▼──────────────┐
            │  /gsd-audit-milestone        │
            │  /gsd-complete-milestone     │
            └───────────────┬──────────────┘
                            │
                   Another milestone?
                       │          │
                      Yes         No -> Done!
                       │
               ┌───────▼──────────────┐
               │  /gsd-new-milestone  │
               └──────────────────────┘
```

### 計劃 Agent 協調

```text
  /gsd-plan-phase N
         │
         ├── Phase Researcher (x4 parallel)
         │     ├── Stack researcher
         │     ├── Features researcher
         │     ├── Architecture researcher
         │     └── Pitfalls researcher
         │           │
         │     ┌──────▼──────┐
         │     │ RESEARCH.md │
         │     └──────┬──────┘
         │            │
         │     ┌──────▼──────┐
         │     │   Planner   │  <- Reads PROJECT.md, REQUIREMENTS.md,
         │     │             │     CONTEXT.md, RESEARCH.md
         │     └──────┬──────┘
         │            │
         │     ┌──────▼───────────┐     ┌────────┐
         │     │   Plan Checker   │────>│ PASS?  │
         │     └──────────────────┘     └───┬────┘
         │                                  │
         │                             Yes  │  No
         │                              │   │   │
         │                              │   └───┘  (loop, up to 3x)
         │                              │
         │                        ┌─────▼──────┐
         │                        │ PLAN files │
         │                        └────────────┘
         └── Done
```

### 驗證架構（奈奎斯特層）

在計劃階段研究期間，GSD 會在編寫任何程式碼之前將自動化測試覆蓋率對映到每個階段的需求上。研究者會檢測您現有的測試基礎設施，將每個需求對映到特定的測試命令，並識別在實施開始前必須建立的測試腳手架（Wave 0 任務）。計劃檢查器將此作為第 8 個驗證維度執行：缺少自動化驗證命令的任務計劃將不會被批准。

**輸出：** `{phase}-VALIDATION.md` — 階段的反饋契約。

**停用：** 在 `/gsd-settings` 中將 `workflow.nyquist_validation: false` 設定為 false，適用於測試基礎設施不是重點的快速原型階段。

### 追溯驗證（`/gsd-validate-phase`）

對於在奈奎斯特驗證出現之前執行的階段，或僅有傳統測試套件的現有程式碼庫，可追溯審計並填補覆蓋缺口：

```text
  /gsd-validate-phase N
         |
         +-- Detect state (VALIDATION.md exists? SUMMARY.md exists?)
         |
         +-- Discover: scan implementation, map requirements to tests
         |
         +-- Analyze gaps: which requirements lack automated verification?
         |
         +-- Present gap plan for approval
         |
         +-- Spawn auditor: generate tests, run, debug (max 3 attempts)
         |
         +-- Update VALIDATION.md
               |
               +-- COMPLIANT -> all requirements have automated checks
               +-- PARTIAL -> some gaps escalated to manual-only
```

審計器永不修改實現程式碼——僅修改測試檔案和 VALIDATION.md。如果測試揭示了實現中的錯誤，將以升級問題的形式標記供您處理。

### 假設討論模式

預設情況下，`/gsd-discuss-phase` 會就您的實現偏好提出開放性問題。假設模式將此倒轉：GSD 首先讀取您的程式碼庫，提出關於如何構建該階段的結構化假設，然後僅就修正內容提問。

**啟用：** 通過 `/gsd-settings` 將 `workflow.discuss_mode` 設定為 `'assumptions'`。

完整的討論模式參考請參閱 [docs/workflow-discuss-mode.md](workflow-discuss-mode.md)。

### 決策覆蓋關卡

討論階段將實現決策以編號項（`- **D-01:** …`）的形式捕獲到 CONTEXT.md 的 `<decisions>` 塊中。兩個關卡確保這些決策能延續到計劃和交付程式碼中。

**計劃階段轉換關卡（阻塞）。** 計劃完成後，GSD 會拒絕將階段標記為已計劃，直到每個可跟蹤決策出現在至少一個計劃的 `must_haves`、`truths` 或正文中。

**驗證階段驗證關卡（非阻塞）。** 在驗證期間，GSD 會在計劃、SUMMARY.md、修改檔案和最近提交訊息中搜索每個可跟蹤決策。遺漏項以警告章節的形式記錄到 VERIFICATION.md；驗證狀態不變。

**將決策排除在外。** 將其移至 `<decisions>` 內的 `### Claude's Discretion` 標題下，或新增標籤：`- **D-08 [informational]:** …`、`- **D-09 [folded]:** …`、`- **D-10 [deferred]:** …`。

**停用關卡。** 在 `.planning/config.json` 中設定 `workflow.context_coverage_gate: false`（或通過 `/gsd-settings`）。預設值為 `true`。

### 執行波次協調

```text
  /gsd-execute-phase N
         │
         ├── Analyze plan dependencies
         │
         ├── Wave 1 (independent plans):
         │     ├── Executor A (fresh 200K context) -> commit
         │     └── Executor B (fresh 200K context) -> commit
         │
         ├── Wave 2 (depends on Wave 1):
         │     └── Executor C (fresh 200K context) -> commit
         │
         └── Verifier
               ├── Check codebase against phase goals
               ├── Test quality audit (disabled tests, circular patterns, assertion strength)
               │
               ├── PASS -> VERIFICATION.md (success)
               └── FAIL -> Issues logged for /gsd-verify-work
```

---

## UI 設計契約

AI 生成的前端在視覺上不一致，原因不在於 Claude Code 在 UI 方面能力不足，而在於執行前沒有建立設計契約。`/gsd-ui-phase` 在計劃前鎖定設計契約；`/gsd-ui-review` 在執行後審計結果。

完整工作流、配置、shadcn 初始化以及登錄檔安全關卡，請參閱 [設計 UI 階段](how-to/design-a-ui-phase.md)。

**快速參考：**

| 命令              | 描述                                              |
| -------------------- | -------------------------------------------------------- |
| `/gsd-ui-phase [N]`  | 為前端階段生成 UI-SPEC.md 設計契約 |
| `/gsd-ui-review [N]` | 對已實現 UI 進行追溯性六維視覺審計      |

| 設定                   | 預設值 | 描述                                                 |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `workflow.ui_phase`       | `true`  | 為前端階段生成 UI 設計契約            |
| `workflow.ui_safety_gate` | `true`  | 計劃階段提示為前端階段執行 /gsd-ui-phase |

---

## 探針與草圖

使用 `/gsd-spike` 在計劃前驗證技術可行性，使用 `/gsd-sketch` 在設計前探索視覺方向。兩者均將產物儲存在 `.planning/` 中，並通過其配套的收尾工具與專案技能系統整合。

完整工作流和流程圖請參閱 [探針與草圖](how-to/spike-and-sketch.md)。

**典型流程：**

```bash
/gsd-spike "SSE vs WebSocket"     # Validate the approach
/gsd-spike --wrap-up              # Package learnings

/gsd-sketch "real-time feed UI"   # Explore the design
/gsd-sketch --wrap-up             # Package decisions

/gsd-discuss-phase N              # Lock in preferences (now informed by spike + sketch)
/gsd-plan-phase N                 # Plan with confidence
```

---

## 待辦事項與執行緒

### 待辦事項停車場

尚未準備好進入主動計劃的想法使用 999.x 編號進入待辦事項，保持在活躍階段序列之外。

```bash
/gsd-capture --backlog "GraphQL API layer"     # Creates 999.1-graphql-api-layer/
/gsd-capture --backlog "Mobile responsive"     # Creates 999.2-mobile-responsive/
```

待辦事項獲得完整的階段目錄，因此您可以使用 `/gsd-discuss-phase 999.1` 進一步探索某個想法，或在準備好時使用 `/gsd-plan-phase 999.1`。

**審查和提升**使用 `/gsd-review-backlog`——它顯示所有待辦事項，並讓您選擇提升（移至活躍序列）、保留（留在待辦事項中）或移除（刪除）。

### 種子

種子是帶有觸發條件的前瞻性想法。與待辦事項不同，種子會在正確的里程碑到來時自動浮現。

```bash
/gsd-capture --seed "Add real-time collab when WebSocket infra is in place"
```

`/gsd-new-milestone` 會掃描所有種子並呈現匹配項。**儲存位置：** `.planning/seeds/SEED-NNN-slug.md`

### 持久上下文執行緒

執行緒是輕量級的跨會話知識儲存，用於跨多個會話但不屬於任何特定階段的工作。

```bash
/gsd-thread                              # List all threads
/gsd-thread fix-deploy-key-auth          # Resume existing thread
/gsd-thread "Investigate TCP timeout"    # Create new thread
```

執行緒成熟後可提升為階段（`/gsd-phase`）或待辦事項（`/gsd-capture --backlog`）。**儲存位置：** `.planning/threads/{slug}.md`

---

## 工作流與工作區

工作流（Workstreams）和工作區（Workspaces）都提供隔離，但級別不同。

**Workstreams** 共享同一程式碼庫和 git 歷史，但隔離規劃產物——更輕量，適合併發處理多個里程碑區域。參見 [使用 Workstreams 並行工作](how-to/work-in-parallel-with-workstreams.md)。

**Workspaces** 建立各自擁有 `.planning/` 的獨立倉庫工作樹——更重，用於特性分支或多倉庫隔離。參見 [使用 Workspaces 隔離工作](how-to/isolate-work-with-workspaces.md)。

| 命令                            | 用途                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `/gsd-workstreams create <name>`   | 建立具有隔離計劃狀態的新工作流 |
| `/gsd-workstreams switch <name>`   | 將活躍上下文切換到不同的工作流      |
| `/gsd-workstreams list`            | 顯示所有工作流及當前活躍的工作流             |
| `/gsd-workstreams complete <name>` | 將工作流標記為完成並歸檔其狀態      |

```bash
# Workspace example — feature branch isolation
/gsd-workspace --new --name feature-b --repos .
cd ~/gsd-workspaces/feature-b
/gsd-new-project

/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

## 安全

### 縱深防禦（v1.27）

GSD 生成的 Markdown 檔案會成為 LLM 系統提示。這意味著流入規劃產物的任何使用者控制文本都是潛在的間接提示注入向量。v1.27 引入了集中式安全加固：

**路徑遍歷防護：** 所有使用者提供的檔案路徑（`--text-file`、`--prd`）均經過驗證，確保解析在專案目錄內。macOS 的 `/var` → `/private/var` 符號連結解析已處理。

**提示注入檢測：** `security.cjs` 模組在使用者提供的文本進入規劃產物之前掃描已知的注入模式。

**執行時鉤子：**

- `gsd-prompt-guard.js` — 掃描寫入 `.planning/` 的 Write/Edit 呼叫中的注入模式（始終活躍，僅建議）
- `gsd-workflow-guard.js` — 對 GSD 工作流上下文之外的檔案編輯發出警告（通過 `hooks.workflow_guard` 選擇性啟用）

**CI 掃描器：** `prompt-injection-scan.test.cjs` 掃描所有 agent、工作流和命令檔案中的嵌入式注入向量。

---

### 包合法性關卡（v1.42.1）

AI 編碼工具會幻覺出包名。攻擊者會在 npm、PyPI 和 crates.io 上預先註冊這些名稱，並附帶惡意的安裝後腳本——這種技術稱為 *slopsquatting*。v1.42.1 增加了三層關卡，在到達您的 shell 之前阻止這一問題。

**在 RESEARCH.md 中** — 每個推薦外部包的階段都包含一個 `## Package Legitimacy Audit` 表：

```markdown
## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| express | npm | 13 yrs | 100M+/wk | github.com/expressjs/express | [OK] | Approved |
| some-new-util | npm | 3 days | 47 | none | [SLOP] | REMOVED |
| api-bridge | npm | 6 mo | 1.2k/wk | github.com/user/api-bridge | [SUS] | Flagged |
```

`[SLOP]` 包將從 RESEARCH.md 中完全刪除，永遠不會到達規劃器。

**在 PLAN.md 中** — `[SUS]` 或 `[ASSUMED]` 包會在安裝前觸發 `checkpoint:human-verify` 任務。

**執行期間** — 如果安裝失敗，執行器會顯示檢查點並停止，而不是靜默嘗試替代方案。

**Slopcheck 判定：**

| 判定 | 含義 | GSD 操作 |
|---------|---------|------------|
| `[OK]` | 通過所有合法性檢查 | 繼續——不新增檢查點 |
| `[SUS]` | 存在可疑訊號 | 標記；規劃器新增 `checkpoint:human-verify` |
| `[SLOP]` | 高置信度幻覺 | 從 RESEARCH.md 中刪除；永遠不會到達規劃器 |

手動安裝 slopcheck：

```bash
pip install slopcheck
# verify: slopcheck install express --json
```

---

## 程式碼審查工作流

執行階段後，在 UAT 前進行結構化程式碼審查。完整工作流請參閱 [設定跨 AI 審查](how-to/set-up-cross-ai-review.md)。

```bash
/gsd-code-review 3               # Review all changed files in phase 3
/gsd-code-review 3 --depth=deep  # Deep cross-file review
/gsd-code-review 3 --fix         # Fix Critical + Warning findings atomically
/gsd-code-review 3 --fix --auto  # Fix and re-review until clean (max 3 iterations)
/gsd-audit-fix                   # Audit + classify + fix (medium+ severity, max 5)
```

審查步驟插入在執行之後、UAT 之前：

```text
/gsd-execute-phase N  ->  /gsd-code-review N  ->  /gsd-code-review N --fix  ->  /gsd-verify-work N
```

---

## 命令與配置參考

- **命令參考：** 參見 [`docs/COMMANDS.md`](COMMANDS.md)，包含每個穩定命令的標誌、子命令和示例。
- **配置參考：** 參見 [`docs/CONFIGURATION.md`](CONFIGURATION.md)，包含完整的 `config.json` 模式、模型配置檔案表、git 分支策略和安全設定。
- **討論模式：** 參見 [`docs/workflow-discuss-mode.md`](workflow-discuss-mode.md)，瞭解訪談模式與假設模式。

---

## 使用示例

### 新建專案（完整週期）

```bash
claude --dangerously-skip-permissions
/gsd-new-project            # Answer questions, configure, approve roadmap
/clear
/gsd-discuss-phase 1        # Lock in your preferences
/gsd-ui-phase 1             # Design contract (frontend phases)
/gsd-plan-phase 1           # Research + plan + verify
/gsd-execute-phase 1        # Parallel execution
/gsd-verify-work 1          # Manual UAT
/gsd-ship 1                 # Create PR from verified work
/gsd-ui-review 1            # Visual audit (frontend phases)
/clear
/gsd-progress --next                   # Auto-detect and run next step
...
/gsd-audit-milestone        # Check everything shipped
/gsd-complete-milestone     # Archive, tag, done
/gsd-pause-work --report         # Generate session summary
```

### 從現有文件新建專案

```bash
/gsd-new-project --auto @prd.md   # Auto-runs research/requirements/roadmap from your doc
/clear
/gsd-discuss-phase 1               # Normal flow from here
```

### 現有程式碼庫

```bash
/gsd-map-codebase           # Analyse what exists (parallel agents)
/gsd-new-project            # Questions focus on what you're ADDING
# (normal phase workflow from here)
```

**執行後漂移檢測（#2003）。** 每次 `/gsd-execute-phase` 之後，GSD 會檢查該階段是否引入了足夠的結構變化，使 `.planning/codebase/STRUCTURE.md` 過時。通過以下方式調整行為：

```bash
/gsd-settings workflow.drift_action auto-remap       # remap automatically
/gsd-settings workflow.drift_threshold 5             # tune sensitivity
```

### 計劃漂移守衛

**預設開啟。** 計劃漂移守衛（`plan_review.source_grounding: true`）在計劃審查期間執行，驗證計劃中引用的每個符號——裝飾器、類、函式、CLI 標誌——在審查時實際存在於原始碼樹中。這可以在任何執行 Agent 執行前捕獲幻覺的名稱。

**捕獲內容：**

- PLAN.md 步驟中引用的函式在原始碼中不存在
- 自計劃編寫以來被重新命名或刪除的類或裝飾器名稱
- 計劃中記錄的 CLI 標誌未在引數解析器中定義
- 實現步驟中引用的模組路徑未解析到任何檔案

**needs-acknowledgement 行為。** 當守衛發現缺失的符號時，它會在計劃審查輸出中發出 needs-acknowledgement 通知，而不是硬性阻塞。您可以確認並繼續（該符號可能是有意新增的），或請求修改計劃。守衛不會自動拒絕計劃——它為人工決策提供訊號。

**無需 intel 即可工作。** 預設情況下，守衛使用 `grep`/`ripgrep` 搜尋原始檔——無需預先索引。如果您已使用 `intel.enabled: true` 執行 `/gsd:map-codebase`，請將 `plan_review.source_grounding_authority: intel` 設定為使用更快的預構建 `api-map.json` 索引。

```bash
# Enable/disable (default: on)
/gsd-settings plan_review.source_grounding true
/gsd-settings plan_review.source_grounding false

# Switch resolver authority
/gsd-settings plan_review.source_grounding_authority grep   # live grep (default)
/gsd-settings plan_review.source_grounding_authority intel  # pre-indexed api-map.json
```

在專案設定時切換（`/gsd:new-project` 在工作流偏好設定期間詢問）或隨時通過 `/gsd:settings`（計劃部分 → 漂移守衛）切換。

### 快速修復 Bug

```bash
/gsd-quick
> "Fix the login button not responding on mobile Safari"
```

### 休息後恢復工作

```bash
/gsd-progress               # See where you left off and what's next
# or
/gsd-resume-work            # Full context restoration from last session
```

### 準備釋出

```bash
/gsd-audit-milestone        # Check requirements coverage, detect stubs
/gsd-complete-milestone     # Archive, tag, done
```

### 速度與品質預設

| 場景    | 模式          | 粒度 | 配置檔案    | 研究 | 計劃檢查 | 驗證器 |
| ----------- | ------------- | ----------- | ---------- | -------- | ---------- | -------- |
| 原型開發 | `yolo`        | `coarse`    | `budget`   | 關閉      | 關閉        | 關閉      |
| 常規開發  | `interactive` | `standard`  | `balanced` | 開啟       | 開啟        | 開啟       |
| 生產環境  | `interactive` | `fine`      | `quality`  | 開啟       | 開啟        | 開啟       |

**在自主模式下跳過討論階段：** 以 `yolo` 模式執行時，通過 `/gsd-settings` 設定 `workflow.skip_discuss: true`。

### 里程碑中期範圍變更

```bash
/gsd-phase                  # Append a new phase to the roadmap (default mode)
/gsd-phase --insert 3       # Insert urgent work between phases 3 and 4
/gsd-phase --remove 7       # Descope phase 7 and renumber
/gsd-phase --edit 4         # Edit any field of phase 4 in place
```

---

## 故障排查

完整的故障排查指南請參閱 [恢復與故障排查](how-to/recover-and-troubleshoot.md)。以下是最常見問題的摘要。

### 程式化 CLI（`gsd-tools query` 與 `gsd-tools.cjs`）

對於自動化，優先使用帶有已註冊子命令的 **`gsd-tools query`**（參見 [CLI-TOOLS.md — SDK 和程式化訪問](CLI-TOOLS.md#sdk-and-programmatic-access) 及 QUERY-HANDLERS.md）。舊版 `node $HOME/.claude/get-shit-done/bin/gsd-tools.cjs` CLI 仍受支援。

### STATE.md 不同步

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state validate          # Detect drift
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync --verify     # Preview changes
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync              # Reconstruct STATE.md
```

### 命令在"Spawning..."後似乎凍結

GSD 子 Agent 在單獨的上下文視窗中執行——其工作在進行中對父會話不可見。請勿中斷會話。等待結果；研究和計劃 Agent 通常需要 1–5 分鐘。

### 長會話期間上下文退化

在主要命令之間清除上下文視窗：在 Claude Code 中使用 `/clear`。GSD 圍繞全新上下文設計——每個子 Agent 獲得一個乾淨的 200K 視窗。清除後使用 `/gsd-resume-work` 或 `/gsd-progress` 恢復狀態。

### 計劃似乎不正確或不一致

在計劃前執行 `/gsd-discuss-phase [N]`。大多數計劃品質問題來源於 Claude 在 `CONTEXT.md` 本可避免的情況下做出假設。

### 執行失敗或產生存根

檢查計劃是否過於雄心勃勃。計劃最多應有 2–3 個任務。以更小的範圍重新計劃。

### 不知道當前位置

執行 `/gsd-progress`。它讀取所有狀態檔案，精確告訴您當前所在位置和下一步操作。

### 模型成本過高

切換到預算配置檔案：`/gsd-config --profile budget`。如果領域已熟悉，通過 `/gsd-settings` 停用研究和計劃檢查 Agent。

### 按階段調整模型成本（`models`）——v1.40 新增

在 `.planning/config.json` 中新增 `models` 塊：

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
  }
}
```

需要針對單個 Agent 的例外情況？在旁邊新增 `model_overrides`——它優先於 `models`：

```json
{
  "models": { "research": "sonnet" },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

完整的對映表和解析優先順序規則，請參閱 [按階段型別分配模型](CONFIGURATION.md#per-phase-type-models-models--added-in-v140)。

### 使用 `dynamic_routing` 預設降低成本——v1.40 新增

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

完整的 Agent → 層級對映，請參閱 [動態路由](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140)。

### 精簡 MCP 伺服器以降低每次互動成本

在調整 `model_profile` 或 `models.<phase_type>` 之前，請審計您的執行時啟用了哪些 **MCP 伺服器**。每個啟用的 MCP 伺服器都會將其工具模式注入每次互動——重量級伺服器每次可能消耗超過 20k 個 token。

這是**執行時設定**，不是 GSD 設定。切換項位於 `.claude/settings.json`：

```json
{
  "enabledMcpjsonServers": ["context7"],
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

長階段前的快速審計：

- 此階段沒有 UI 工作時，是否有任何瀏覽器 / playwright 工具被啟用？
- 不需要時，是否有任何平臺特定工具被啟用？
- 是否有來自其他專案的專案專屬 MCP 仍在此處啟用？

每個被停用的伺服器都會從後續每次互動中移除其模式。精簡 MCP **與** `model_profile` 調整形成疊加效果——兩個槓桿是累加的，MCP 節省效果立即體現在編排器生成的每個子 Agent 上。

完整審計、執行時參考及與 `model_profile` 的組合說明，請參閱捆綁的 `context-budget.md` 參考中的 [MCP 工具模式成本](../../get-shit-done/references/context-budget.md#mcp-tool-schema-cost-harness-concern)。

### 使用非 Claude 執行時（Codex、OpenCode、Gemini CLI、Kilo）

> **Codex CLI 最低支援版本：`0.130.0`**（issue [#3562](https://github.com/open-gsd/gsd-core/issues/3562)）。

如果您為非 Claude 執行時安裝了 GSD，安裝器已配置好模型解析。無需手動設定——`resolve_model_ids: "omit"` 會自動設定，告知 GSD 跳過 Anthropic 模型 ID 解析，讓執行時選擇其預設模型。

在非 Claude 執行時上分配不同模型：

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3"
  }
}
```

#### 通過一次配置更改從 Claude 切換到 Codex（#2517）

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

參見 [執行時感知配置檔案](CONFIGURATION.md#runtime-aware-profiles-2517)。

### 手動安裝 / 無 Node.js 設定

如果無法執行 GSD 安裝器，則無法直接使用 `agents/` 中的原始檔——它們採用 Claude Code 的原生 frontmatter 格式。對於 OpenCode，需要進行兩項轉換：

| 欄位 | GSD 源格式 | OpenCode 有效格式 | 操作 |
|---|---|---|---|
| `tools:` | `Read, Bash, Grep`（逗號字串） | 不是 frontmatter 欄位 | 完全刪除 `tools:` 行 |
| `color:` | 純 CSS 顏色名稱 | 十六進位制或 OpenCode 語義名稱 | 轉換為十六進位制或刪除 |

**替代方案：** 在任何有 Node.js 的機器上執行安裝器：

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

### 為 Cline 安裝

```bash
npx @opengsd/gsd-core --cline --global   # applies to all projects
npx @opengsd/gsd-core --cline --local    # this project only
```

### 為 CodeBuddy 安裝

```bash
npx @opengsd/gsd-core --codebuddy --global
```

### 為 Qwen Code 安裝

```bash
npx @opengsd/gsd-core --qwen --global
```

### 為預釋出版本安裝

在執行安裝器前，將執行時的 `*_CONFIG_DIR` 環境變數設定為預釋出目錄：

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

**支援執行時的環境變數參考：**

| 執行時 | 穩定預設值 | 覆蓋環境變數 |
|---|---|---|
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Gemini CLI | `~/.gemini` | `GEMINI_CONFIG_DIR` |
| OpenCode | `XDG_CONFIG_HOME/opencode` | `OPENCODE_CONFIG_DIR` |
| Codex | （按 Codex CLI） | `--config-dir` 標誌 |
| Copilot | `~/.copilot` | `COPILOT_CONFIG_DIR` |
| Cursor | `~/.cursor` | `CURSOR_CONFIG_DIR` |
| Windsurf | `~/.codeium/windsurf` | `WINDSURF_CONFIG_DIR` |
| Antigravity | 自動檢測 | `ANTIGRAVITY_CONFIG_DIR` |
| Augment | `~/.augment` | `AUGMENT_CONFIG_DIR` |
| Trae | `~/.trae` | `TRAE_CONFIG_DIR` |
| Qwen Code | `~/.qwen` | `QWEN_CONFIG_DIR` |
| Kilo | `~/.config/kilo` | `KILO_CONFIG_DIR` |
| CodeBuddy | `~/.codebuddy` | `CODEBUDDY_CONFIG_DIR` |
| Cline | `~/.cline` | `CLINE_CONFIG_DIR` |

### 將 Claude Code 與非 Anthropic 提供商結合使用

切換到 `inherit` 配置檔案：`/gsd-config --profile inherit`。這使所有 Agent 使用您當前的會話模型。

### 處理敏感/私有專案

在 `/gsd-new-project` 期間或通過 `/gsd-settings` 設定 `commit_docs: false`。將 `.planning/` 新增到您的 `.gitignore`。

### GSD 更新覆蓋了我的本地更改

自 v1.17 起，安裝器會將本地修改的檔案備份到 `gsd-local-patches/`。執行 `/gsd-update --reapply` 將您的更改合併回來。

### 無法通過 npm 更新

參見 [docs/manual-update.md](../manual-update.md) 中的逐步手動更新程式。

### 工作流診斷（`/gsd-forensics`）

當工作流以不明顯的方式失敗時，執行 `/gsd-forensics` 生成涵蓋 git 歷史異常、產物完整性和狀態不一致的診斷報告。輸出寫入 `.planning/forensics/`。

### 執行器子 Agent 在 Bash 命令上遇到"Permission denied"

將所需模式新增到 `~/.claude/settings.json`。所有技術棧所需的核心模式：

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git worktree:*)",
"Bash(git rebase:*)",
"Bash(git reset:*)",
"Bash(git checkout:*)",
"Bash(git switch:*)",
"Bash(git restore:*)",
"Bash(git stash:*)",
"Bash(git rm:*)",
"Bash(git mv:*)",
"Bash(git fetch:*)",
"Bash(git cherry-pick:*)",
"Bash(git apply:*)",
"Bash(gh:*)"
```

**專案級許可權：** 將相同的 `permissions.allow` 塊新增到專案根目錄的 `.claude/settings.local.json`，而不是 `~/.claude/settings.json`。

### 並行執行導致構建鎖定錯誤

GSD 自 v1.26 起自動處理此問題。如果您使用的是舊版本，請在專案的 `CLAUDE.md` 中新增：

```markdown
## Git Commit Rules for Agents
All subagent/executor commits MUST use `--no-verify`.
```

完全停用並行執行：`/gsd-settings` → 將 `parallelization.enabled` 設定為 `false`。

---

## 快速恢復參考

| 問題                              | 解決方案                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| 丟失上下文 / 新會話           | `/gsd-resume-work` 或 `/gsd-progress`                                    |
| 階段出錯                     | `git revert` 階段提交，然後重新計劃                             |
| 需要更改範圍                 | `/gsd-phase`（預設）、`/gsd-phase --insert` 或 `/gsd-phase --remove`  |
| 出現問題                      | `/gsd-debug "description"`（新增 `--diagnose` 進行分析而不修復） |
| STATE.md 不同步                 | `state validate` 然後 `state sync`                                       |
| 工作流狀態似乎損壞       | `/gsd-forensics`                                                         |
| 快速定向修復                   | `/gsd-quick`                                                             |
| 計劃與您的願景不符       | `/gsd-discuss-phase [N]` 然後重新計劃                                    |
| 成本持續上漲                   | `/gsd-config --profile budget` 並通過 `/gsd-settings` 關閉 Agent  |
| 更新破壞了本地更改           | `/gsd-update --reapply`                                                  |
| 需要為利益相關者生成會話摘要 | `/gsd-pause-work --report`                                               |
| 不知道下一步是什麼         | `/gsd-progress --next`                                                   |
| 並行執行構建錯誤      | 更新 GSD 或設定 `parallelization.enabled: false`                       |

---

## 專案檔案結構

```text
.planning/
  PROJECT.md              # Project vision and context (always loaded)
  REQUIREMENTS.md         # Scoped v1/v2 requirements with IDs
  ROADMAP.md              # Phase breakdown with status tracking
  STATE.md                # Decisions, blockers, session memory
  config.json             # Workflow configuration
  MILESTONES.md           # Completed milestone archive
  HANDOFF.json            # Structured session handoff (from /gsd-pause-work)
  research/               # Domain research from /gsd-new-project
  reports/                # Session reports (from /gsd-pause-work --report)
  todos/
    pending/              # Captured ideas awaiting work
    done/                 # Completed todos
  debug/                  # Active debug sessions
    resolved/             # Archived debug sessions
  spikes/                 # Feasibility experiments (from /gsd-spike)
    NNN-name/             # Experiment code + README with verdict
    MANIFEST.md           # Index of all spikes
  sketches/               # HTML mockups (from /gsd-sketch)
    NNN-name/             # index.html (2-3 variants) + README
    themes/
      default.css         # Shared CSS variables for all sketches
    MANIFEST.md           # Index of all sketches with winners
  codebase/               # Brownfield codebase mapping (from /gsd-map-codebase)
  phases/
    XX-phase-name/
      XX-YY-PLAN.md       # Atomic execution plans
      XX-YY-SUMMARY.md    # Execution outcomes and decisions
      CONTEXT.md          # Your implementation preferences
      RESEARCH.md         # Ecosystem research findings
      VERIFICATION.md     # Post-execution verification results
      XX-UI-SPEC.md       # UI design contract (from /gsd-ui-phase)
      XX-UI-REVIEW.md     # Visual audit scores (from /gsd-ui-review)
  ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
```

---

## 相關資源

- [文件索引](README.md)
- [命令](COMMANDS.md)
- [配置](CONFIGURATION.md)
- [階段迴圈](explanation/the-phase-loop.md)
