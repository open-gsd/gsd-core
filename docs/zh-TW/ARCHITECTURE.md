# GSD Core 架構

> 面向貢獻者和高階使用者的系統架構說明。如需面向使用者的文件，請參閱[功能參考](FEATURES.md)或[使用者指南](USER-GUIDE.md)。

---

## 目錄

- [系統概述](#系統概述)
- [設計原則](#設計原則)
- [元件架構](#元件架構)
- [Agent 模型](#agent-模型)
- [資料流](#資料流)
- [檔案系統佈局](#檔案系統佈局)
- [安裝程式架構](#安裝程式架構)
- [Hook 系統](#hook-系統)
- [CLI 工具層](#cli-工具層)
- [執行時抽象](#執行時抽象)

---

## 系統概述

GSD Core 是一個**元提示框架**，位於使用者與 AI 編碼 Agent（Claude Code、Gemini CLI、OpenCode、Kilo、Codex、Copilot、Antigravity、Trae、Cline、Augment Code）之間。它提供：

1. **上下文工程** — 結構化產物，為每個任務向 AI 提供所需的全部資訊（參見[上下文工程](explanation/context-engineering.md)）
2. **多 Agent 編排** — 輕量級編排器，以全新上下文視窗派生專用 Agent（參見[多 Agent 編排](explanation/multi-agent-orchestration.md)）
3. **規範驅動開發** — 需求 → 研究 → 計劃 → 執行 → 驗證的完整流水線
4. **狀態管理** — 跨會話和上下文重置的持久化專案記憶

```
┌──────────────────────────────────────────────────────┐
│                      USER                            │
│            /gsd-command [args]                        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              COMMAND LAYER                            │
│   commands/gsd/*.md — Prompt-based command files      │
│   (Claude Code custom commands / Codex skills)        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              WORKFLOW LAYER                           │
│   get-shit-done/workflows/*.md — Orchestration logic  │
│   (Reads references, spawns agents, manages state)    │
└──────┬──────────────┬─────────────────┬──────────────┘
       │              │                 │
┌──────▼──────┐ ┌─────▼─────┐ ┌────────▼───────┐
│  AGENT      │ │  AGENT    │ │  AGENT         │
│  (fresh     │ │  (fresh   │ │  (fresh        │
│   context)  │ │   context)│ │   context)     │
└──────┬──────┘ └─────┬─────┘ └────────┬───────┘
       │              │                 │
┌──────▼──────────────▼─────────────────▼──────────────┐
│              CLI TOOLS LAYER                          │
│   gsd-tools.cjs command families + domain modules      │
│   command-routing-hub + observability seams            │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│              FILE SYSTEM (.planning/)                 │
│   PROJECT.md | REQUIREMENTS.md | ROADMAP.md          │
│   STATE.md | config.json | phases/ | research/       │
└──────────────────────────────────────────────────────┘
```

---

## 設計原則

### 1. 每個 Agent 擁有全新上下文

編排器派生的每個 Agent 都有一個乾淨的上下文視窗（最多 200K token）。這消除了上下文腐化——即 AI 在其上下文視窗中積累大量對話後導致的品質下降問題。

### 2. 輕量級編排器

工作流檔案（`get-shit-done/workflows/*.md`）不承擔繁重工作。它們：

- 通過 `gsd-tools.cjs init <workflow>` 載入上下文
- 以聚焦的提示詞派生專用 Agent
- 收集結果並路由到下一步
- 在步驟之間更新狀態

### 3. 基於檔案的狀態

所有狀態以人類可讀的 Markdown 和 JSON 格式儲存在 `.planning/` 中。無需資料庫、伺服器或外部依賴。這意味著：

- 狀態在上下文重置（`/clear`）後仍然保留
- 狀態可由人類和 Agent 共同檢查
- 狀態可提交到 git 以供團隊檢視

### 4. 預設即啟用

工作流功能標誌遵循**預設即啟用**模式。若 `config.json` 中缺少某個鍵，則預設為 `true`。使用者需顯式停用功能；無需手動啟用預設值。

### 5. 深度防禦

多層保護防止常見故障模式：

- 計劃在執行前經過驗證（plan-checker agent）
- 執行為每個任務生成原子提交
- 執行後驗證會檢查是否符合階段目標
- UAT 提供人工驗證作為最終關卡

---

## 元件架構

### 命令（`commands/gsd/*.md`）

面向使用者的入口點。每個檔案包含 YAML 前置後設資料（name、description、allowed-tools）以及引導工作流的提示詞主體。命令按如下方式安裝：

- **Claude Code：** 自定義斜線命令（連字元形式，`/gsd-command-name`）
- **OpenCode / Kilo：** 斜線命令（連字元形式，`/gsd-command-name`）
- **Codex：** 技能（`$gsd-command-name`）
- **Copilot：** 斜線命令（連字元形式，`/gsd-command-name`）
- **Gemini CLI：** 在 `gsd:` 名稱空間下的斜線命令（冒號形式，`/gsd:command-name`）——Gemini 將所有自定義命令置於其外掛 id 的名稱空間下，因此安裝路徑會將正文中的每個引用改寫為冒號形式
- **Antigravity：** 技能

**命令總數：** 請參閱 [`docs/INVENTORY.md`](INVENTORY.md#commands) 獲取權威數量及完整列表。

#### 兩階段層級路由（v1.40，[#2792](https://github.com/open-gsd/gsd-core/issues/2792)）

為控制急於列舉技能的 token 開銷，v1.40 引入了六個名稱空間**元技能**（`gsd-workflow`、`gsd-project`、`gsd-quality`、`gsd-context`、`gsd-manage`、`gsd-ideate`——源自 `commands/gsd/ns-*.md`，但可呼叫的 `name:` 為此處顯示的簡短形式），位於具體子技能之上。模型看到的是 6 個名稱空間路由器（約 120 個 token），而非扁平的 86 個技能列表（約 2,150 個 token），選擇名稱空間後通過嵌入在名稱空間路由器主體中的路由表路由到具體子技能。名稱空間技能是**可疊加的**——每個具體命令仍可直接呼叫。

路由器描述使用管道分隔的關鍵詞標籤（≤ 60 個字元），符合工具注意力研究的結論：關鍵詞密集的標籤在路由效果上優於散文，且 token 開銷僅約 40%。

#### MCP token 預算互動

急於列舉技能是每輪兩種反覆出現的 token 開銷之一。另一種是 `.claude/settings.json` 中每個已啟用 MCP 伺服器注入的 MCP 工具 schema。重型 MCP 伺服器（browser/playwright、Mac-tools、Windows-tools）每輪各自可消耗 20k+ token——通常遠超 `model_profile` 調優所節省的量。該開關位於 Claude Code 框架中（`.claude/settings.json` 中的 `enabledMcpjsonServers` / `disabledMcpjsonServers`），**不屬於** GSD 的關注範圍。兩階段路由層（#2792）和嚴格的 MCP 啟用管理是每輪最大的成本槓桿。請參閱 [`docs/USER-GUIDE.md`](USER-GUIDE.md) 和 `references/context-budget.md` 瞭解審計清單。

### 工作流（`get-shit-done/workflows/*.md`）

命令所引用的編排邏輯，包含逐步流程：

- 通過 `gsd-tools.cjs init` 處理程序載入上下文
- 帶有模型解析的 Agent 派生指令
- 關卡/檢查點定義
- 狀態更新模式
- 錯誤處理與恢復

**工作流總數：** 請參閱 [`docs/INVENTORY.md`](INVENTORY.md#workflows) 獲取權威數量及完整列表。

#### 工作流的漸進式披露

工作流檔案在每次呼叫對應的 `/gsd-*` 命令時會被完整載入到 Claude 的上下文中。為控制該成本，`tests/workflow-size-budget.test.cjs` 強制執行的工作流大小預算與 #2361 中的 Agent 預算保持一致：

| 層級      | 每檔案行數限制 |
|-----------|--------------------|
| `XL`      | 1700 — 頂級編排器（`execute-phase`、`plan-phase`、`new-project`） |
| `LARGE`   | 1500 — 多步驟規劃器和大型功能工作流 |
| `DEFAULT` | 1000 — 聚焦於單一目的的工作流（目標層級） |

根據 issue #2551，`workflows/discuss-phase.md` 須嚴格遵守 <500 行上限。當工作流超出其層級時，應將各模式的主體提取到 `workflows/<workflow>/modes/<mode>.md`，將模板提取到 `workflows/<workflow>/templates/`，將共享知識提取到 `get-shit-done/references/`。父檔案成為輕量級排程器，僅讀取當前呼叫所需的模式和模板檔案。

`workflows/discuss-phase/` 是該模式的典型示例——父檔案負責排程，`modes/` 存放各標誌的行為（`power.md`、`all.md`、`auto.md`、`chain.md`、`text.md`、`batch.md`、`analyze.md`、`default.md`、`advisor.md`），`templates/` 存放 CONTEXT.md、DISCUSSION-LOG.md 以及僅在寫入對應輸出檔案時才讀取的 checkpoint.json schema。

### Agent（`agents/*.md`）

帶有前置後設資料的專用 Agent 定義，指定：

- `name` — Agent 識別符號
- `description` — 角色與用途
- `tools` — 允許的工具訪問（Read、Write、Edit、Bash、Grep、Glob、WebSearch 等）
- `color` — 用於視覺區分的終端輸出顏色

**Agent 總數：** 33

### 參考文件（`get-shit-done/references/*.md`）

工作流和 Agent 通過 `@-reference` 引用的共享知識文件（請參閱 [`docs/INVENTORY.md`](INVENTORY.md#references-41-shipped) 獲取權威數量及完整列表）：

**核心參考：**

- `checkpoints.md` — 檢查點型別定義和互動模式
- `gates.md` — 4 種規範關卡型別（確認、品質、安全、轉換），與 plan-checker 和 verifier 連線
- `model-profiles.md` — 各 Agent 的模型層級分配
- `model-profile-resolution.md` — 模型解析演算法文件
- `verification-patterns.md` — 不同產物型別的驗證方式
- `verification-overrides.md` — 每種產物的驗證覆蓋規則
- `planning-config.md` — 完整配置 schema 和行為說明
- `git-integration.md` — Git 提交、分支及歷史記錄模式
- `git-planning-commit.md` — 規劃目錄提交約定
- `questioning.md` — 專案初始化的夢想提取理念
- `tdd.md` — 測試驅動開發整合模式
- `ui-brand.md` — 視覺輸出格式化模式
- `common-bug-patterns.md` — 程式碼審查和驗證的常見錯誤模式

**工作流參考：**

- `agent-contracts.md` — 編排器與 Agent 之間的正式介面
- `context-budget.md` — 上下文視窗預算分配規則
- `continuation-format.md` — 會話續接/恢復格式
- `domain-probes.md` — discuss-phase 的領域特定探測問題
- `gate-prompts.md` — 關卡/檢查點提示詞模板
- `revision-loop.md` — 計劃修訂迭代模式
- `universal-anti-patterns.md` — 需檢測和避免的常見反模式
- `artifact-types.md` — 規劃產物型別定義
- `phase-argument-parsing.md` — 階段引數解析約定
- `decimal-phase-calculation.md` — 十進位制子階段編號規則
- `workstream-flag.md` — 工作流活動指標約定
- `user-profiling.md` — 使用者行為分析方法
- `thinking-partner.md` — 在決策點條件性啟用思考夥伴

**思考模型參考：**

將思考類模型（o3、o4-mini、Gemini 2.5 Pro）整合到 GSD 工作流的參考文件：

- `thinking-models-debug.md` — 除錯工作流的思考模型模式
- `thinking-models-execution.md` — 執行 Agent 的思考模型模式
- `thinking-models-planning.md` — 規劃 Agent 的思考模型模式
- `thinking-models-research.md` — 研究 Agent 的思考模型模式
- `thinking-models-verification.md` — 驗證 Agent 的思考模型模式

**模組化規劃器分解：**

規劃器 Agent（`agents/gsd-planner.md`）已從單一整體檔案分解為一個核心 Agent 加參考模組，以遵守部分執行時強加的 50K 字元限制：

- `planner-gap-closure.md` — 缺口修復模式行為（讀取 VERIFICATION.md，針對性重規劃）
- `planner-reviews.md` — 跨 AI 審查整合（從 `/gsd-review` 讀取 REVIEWS.md）
- `planner-revision.md` — 用於迭代細化的計劃修訂模式

### 模板（`get-shit-done/templates/`）

所有規劃產物的 Markdown 模板。由 `gsd-tools.cjs template fill` / `phase.scaffold`（以及頂級 `scaffold`）使用，以建立預結構化檔案：
- `project.md`、`requirements.md`、`roadmap.md`、`state.md` — 核心專案檔案
- `phase-prompt.md` — 階段執行提示詞模板
- `summary.md`（及 `summary-minimal.md`、`summary-standard.md`、`summary-complex.md`）— 粒度感知摘要模板
- `DEBUG.md` — 除錯會話跟蹤模板
- `UI-SPEC.md`、`UAT.md`、`VALIDATION.md` — 專用驗證模板
- `discussion-log.md` — 討論審計追蹤模板
- `codebase/` — 棕地對映模板（技術棧、架構、約定、關注點、結構、測試、整合）
- `research-project/` — 研究輸出模板（SUMMARY、STACK、FEATURES、ARCHITECTURE、PITFALLS）

### Hook（`hooks/`）

與宿主 AI Agent 整合的執行時 hook：

| Hook | 事件 | 用途 |
|------|-------|---------|
| `gsd-statusline.js` | `statusLine` | 顯示模型、任務、目錄及上下文使用量進度條 |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | 在剩餘上下文為 35%/25% 時向 Agent 注入上下文警告 |
| `gsd-check-update.js` | `SessionStart` | 觸發後臺更新檢查的前臺觸發器 |
| `gsd-check-update-worker.js` | （輔助程式） | 由 `gsd-check-update.js` 派生的後臺工作程序；不直接註冊事件 |
| `gsd-prompt-guard.js` | `PreToolUse` | 掃描 `.planning/` 寫入內容中的提示詞注入模式（建議性） |
| `gsd-read-injection-scanner.js` | `PostToolUse` | 掃描 Read 工具輸出中不受信任內容裡的注入指令 |
| `gsd-workflow-guard.js` | `PreToolUse` | 檢測 GSD 工作流上下文之外的檔案編輯（建議性，通過 `hooks.workflow_guard` 選擇啟用） |
| `gsd-read-guard.js` | `PreToolUse` | 建議性防護，防止對本會話中尚未讀取的檔案執行 Edit/Write |
| `gsd-session-state.sh` | `PostToolUse` | 基於 shell 的執行時的會話狀態跟蹤 |
| `gsd-validate-commit.sh` | `PostToolUse` | 用於規範提交格式執行的提交驗證 |
| `gsd-phase-boundary.sh` | `PostToolUse` | 工作流轉換的階段邊界檢測 |

請參閱 [`docs/INVENTORY.md`](INVENTORY.md#hooks-11-shipped) 獲取權威的 11 個 hook 列表。

### 命令路由中樞（`get-shit-done/bin/lib/command-routing-hub.cjs`）

CJS 命令族路由器通過 `CommandRoutingHub` 進行排程。中樞擁有不丟擲異常的純結果契約（`hub.dispatch()` 捕獲內部異常並返回 `{ ok: false, kind, ...typedPayload }`）以及封閉的執行時錯誤分類（`UnknownCommand`、`InvalidArgs`、`HandlerRefusal`、`HandlerFailure`）。路由器介面卡保持為輕量級 CLI 轉換器——它們構建中樞、呼叫 `dispatch`，然後將結果對映到 `output()`/`error()` 呼叫。執行時為單路徑（無雙執行時模式選擇）。參見 `docs/adr/0174-retire-gsd-sdk-package-boundary.md`。

### CLI 工具（`get-shit-done/bin/`）

Node.js CLI 工具（`gsd-tools.cjs`），其領域模組分佈在 `get-shit-done/bin/lib/` 中（請參閱 [`docs/INVENTORY.md`](INVENTORY.md#cli-modules-33-shipped) 獲取權威列表）：


| 模組                   | 職責                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `core.cjs`             | 錯誤處理、輸出格式化、共享工具；規劃輔助程式的相容性重匯出 |
| `planning-workspace.cjs` | 規劃接縫（`planningDir`、`planningPaths`、活動工作流路由、`.planning/.lock`）      |
| `state.cjs`            | STATE.md 解析、更新、進度跟蹤、指標                                                                    |
| `phase.cjs`            | 階段目錄操作、十進位制編號、計劃索引                                                                        |
| `roadmap.cjs`          | ROADMAP.md 解析、階段提取、計劃進度                                                                     |
| `config.cjs`           | config.json 讀寫、節初始化                                                                            |
| `verify.cjs`           | 計劃結構、階段完整性、引用、提交驗證                                                                      |
| `template.cjs`         | 帶變數替換的模板選擇與填充                                                                              |
| `frontmatter.cjs`      | YAML 前置後設資料 CRUD 操作                                                                             |
| `init.cjs`             | 各工作流型別的複合上下文載入                                                                            |
| `milestone.cjs`        | 里程碑歸檔、需求標記                                                                                   |
| `commands.cjs`         | 雜項命令（slug、時間戳、待辦事項、腳手架、統計）                                                           |
| `model-profiles.cjs`   | 模型配置檔案解析表                                                                                    |
| `security.cjs`         | 路徑遍歷防護、提示詞注入檢測、安全 JSON 解析、shell 引數驗證                                                |
| `uat.cjs`              | UAT 檔案解析、驗證債務跟蹤、審計 UAT 支援                                                               |
| `docs.cjs`             | 文件更新工作流初始化、Markdown 掃描、Monorepo 檢測                                                       |
| `workstream.cjs`       | 工作流 CRUD、遷移、會話範圍活動指標                                                                      |
| `schema-detect.cjs`    | ORM 模式（Prisma、Drizzle 等）的 schema 漂移檢測                                                        |
| `profile-pipeline.cjs` | 使用者行為分析資料管道、會話檔案掃描                                                                       |
| `profile-output.cjs`   | 配置檔案渲染、USER-PROFILE.md 和 dev-preferences.md 生成                                               |


---

## Agent 模型

### 編排器 → Agent 模式

```
Orchestrator (workflow .md)
    │
    ├── Load context: gsd-tools.cjs init <workflow> <phase>
    │   Returns JSON with: project info, config, state, phase details
    │
    ├── Resolve model: gsd-tools.cjs resolve-model <agent-name>
    │   Returns: opus | sonnet | haiku | inherit
    │
    ├── Spawn Agent (Task/SubAgent call)
    │   ├── Agent prompt (agents/*.md)
    │   ├── Context payload (init JSON)
    │   ├── Model assignment
    │   └── Tool permissions
    │
    ├── Collect result
    │
    └── Update state: gsd-tools.cjs state update / state patch / state advance-plan
```

### 主要 Agent 派生類別

21 個主要 Agent 的概念派生模式分類。完整的 31 個 Agent 權威列表（包括 10 個高階/專用 Agent，如 `gsd-pattern-mapper`、`gsd-code-reviewer`、`gsd-code-fixer`、`gsd-ai-researcher`、`gsd-domain-researcher`、`gsd-eval-planner`、`gsd-eval-auditor`、`gsd-framework-selector`、`gsd-debug-session-manager`、`gsd-intel-updater`），請參閱 [`docs/INVENTORY.md`](INVENTORY.md#agents-31-shipped)。


| 類別             | Agent                                                                                   | 並行性                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **研究者**       | gsd-project-researcher, gsd-phase-researcher, gsd-ui-researcher, gsd-advisor-researcher | 4 路並行（技術棧、功能、架構、陷阱）；advisor 在 discuss-phase 期間派生 |
| **綜合者**       | gsd-research-synthesizer                                                                | 序列（研究者完成後）                                                                       |
| **規劃者**       | gsd-planner, gsd-roadmapper                                                             | 序列                                                                                      |
| **檢查者**       | gsd-plan-checker, gsd-integration-checker, gsd-ui-checker, gsd-nyquist-auditor          | 序列（驗證迴圈，最多 3 次迭代）                                                             |
| **執行者**       | gsd-executor                                                                            | 波次內並行，波次間序列                                                                     |
| **驗證者**       | gsd-verifier                                                                            | 序列（所有執行者完成後）                                                                    |
| **對映者**       | gsd-codebase-mapper                                                                     | 4 路並行（技術、架構、品質、關注點）                                                         |
| **除錯者**       | gsd-debugger                                                                            | 序列（互動式）                                                                             |
| **審計者**       | gsd-ui-auditor, gsd-security-auditor                                                    | 序列                                                                                      |
| **文件寫作者**   | gsd-doc-writer, gsd-doc-verifier                                                        | 序列（寫作者後接驗證者）                                                                    |
| **分析者**       | gsd-user-profiler                                                                       | 序列                                                                                      |
| **假設分析者**   | gsd-assumptions-analyzer                                                                | 序列（discuss-phase 期間）                                                                 |


### 波次執行模型

在 `execute-phase` 期間，計劃按依賴關係分組為波次：

```
Wave Analysis:
  Plan 01 (no deps)      ─┐
  Plan 02 (no deps)      ─┤── Wave 1 (parallel)
  Plan 03 (depends: 01)  ─┤── Wave 2 (waits for Wave 1)
  Plan 04 (depends: 02)  ─┘
  Plan 05 (depends: 03,04) ── Wave 3 (waits for Wave 2)
```

每個執行者獲得：

- 全新的 200K 上下文視窗（支援的模型最高可達 1M）
- 待執行的具體 PLAN.md
- 專案上下文（PROJECT.md、STATE.md）
- 階段上下文（CONTEXT.md、RESEARCH.md（如可用））

### 自適應上下文增強（1M 模型）

當上下文視窗為 500K+ token 時（1M 級模型，如 Opus 4.6、Sonnet 4.6），子 Agent 提示詞會自動增強額外上下文，這些內容在標準 200K 視窗中無法容納：

- **執行者 Agent** 接收前一波次的 SUMMARY.md 檔案和階段 CONTEXT.md/RESEARCH.md，從而實現階段內跨計劃感知
- **驗證者 Agent** 接收所有 PLAN.md、SUMMARY.md、CONTEXT.md 檔案及 REQUIREMENTS.md，實現歷史感知驗證

編排器從配置中讀取 `context_window`（`gsd-tools.cjs config-get context_window`），當該值 >= 500,000 時，條件性地包含更豐富的上下文。對於標準 200K 視窗，提示詞使用截斷版本並以快取友好的順序排列，以最大化上下文效率。

#### 並行提交安全性

當多個執行者在同一波次內執行時，兩種機制防止衝突：

1. `--no-verify` 提交 — 並行 Agent 跳過預提交 hook（可能導致構建鎖爭用，例如 Rust 專案中的 cargo lock 衝突）。編排器在每個波次完成後執行一次 `git hook run pre-commit`。
2. **STATE.md 檔案鎖** — 所有 `writeStateMd()` 呼叫使用基於鎖檔案的互斥（`STATE.md.lock`，採用 `O_EXCL` 原子建立）。這防止了讀-改-寫競態條件，即兩個 Agent 同時讀取 STATE.md、修改不同欄位，而後寫者覆蓋前者更改的問題。包含陳舊鎖檢測（10 秒超時）和帶抖動的自旋等待。

---

## 資料流

### 新專案流程

```
User input (idea description)
    │
    ▼
Questions (questioning.md philosophy)
    │
    ▼
4x Project Researchers (parallel)
    ├── Stack → STACK.md
    ├── Features → FEATURES.md
    ├── Architecture → ARCHITECTURE.md
    └── Pitfalls → PITFALLS.md
    │
    ▼
Research Synthesizer → SUMMARY.md
    │
    ▼
Requirements extraction → REQUIREMENTS.md
    │
    ▼
Roadmapper → ROADMAP.md
    │
    ▼
User approval → STATE.md initialized
```

### 階段執行流程

```
discuss-phase → CONTEXT.md (user preferences)
    │
    ▼
ui-phase → UI-SPEC.md (design contract, optional)
    │
    ▼
plan-phase
    ├── Research gate (blocks if RESEARCH.md has unresolved open questions)
    ├── Phase Researcher → RESEARCH.md
    │       └── Package Legitimacy Gate: slopcheck on every package; [SLOP] removed,
    │           [SUS]/[ASSUMED] flagged; Audit table written to RESEARCH.md
    ├── Planner (with reachability check) → PLAN.md files
    │       └── checkpoint:human-verify injected before [ASSUMED]/[SUS] installs;
    │           T-{phase}-SC STRIDE row added for install-bearing plans
    ├── Plan Checker → Verify loop (max 3x)
    ├── Requirements coverage gate (REQ-IDs → plans)
    └── Decision coverage gate (CONTEXT.md `<decisions>` → plans, BLOCKING — #2492)
    │
    ▼
state planned-phase → STATE.md (Planned/Ready to execute)
    │
    ▼
execute-phase (context reduction: truncated prompts, cache-friendly ordering)
    ├── Wave analysis (dependency grouping)
    ├── Executor per plan → code + atomic commits
    ├── SUMMARY.md per plan
    └── Verifier → VERIFICATION.md
        └── Decision coverage gate (CONTEXT.md decisions → shipped artifacts, NON-BLOCKING — #2492)
    │
    ▼
verify-work → UAT.md (user acceptance testing)
    │
    ▼
ui-review → UI-REVIEW.md (visual audit, optional)
```

### 上下文傳播

每個工作流階段生成的產物會傳入後續階段：

```
PROJECT.md ────────────────────────────────────────────► All agents
REQUIREMENTS.md ───────────────────────────────────────► Planner, Verifier, Auditor
ROADMAP.md ────────────────────────────────────────────► Orchestrators
STATE.md ──────────────────────────────────────────────► All agents (decisions, blockers)
CONTEXT.md (per phase) ────────────────────────────────► Researcher, Planner, Executor
RESEARCH.md (per phase) ───────────────────────────────► Planner, Plan Checker
PLAN.md (per plan) ────────────────────────────────────► Executor, Plan Checker
SUMMARY.md (per plan) ─────────────────────────────────► Verifier, State tracking
UI-SPEC.md (per phase) ────────────────────────────────► Executor, UI Auditor
```

---

## 檔案系統佈局

### 安裝檔案

```
~/.claude/                          # Claude Code (global install)
├── skills/gsd-*/SKILL.md           # Global skills (authoritative roster: docs/INVENTORY.md)
├── commands/gsd/*.md               # Local Claude installs use slash commands instead of global skills
├── get-shit-done/
│   ├── bin/gsd-tools.cjs           # CLI utility
│   ├── bin/lib/*.cjs               # Domain modules (authoritative roster: docs/INVENTORY.md)
│   ├── workflows/*.md              # Workflow definitions (authoritative roster: docs/INVENTORY.md)
│   ├── references/*.md             # Shared reference docs (authoritative roster: docs/INVENTORY.md)
│   └── templates/                  # Planning artifact templates
├── agents/*.md                     # Agent definitions (authoritative roster: docs/INVENTORY.md)
├── hooks/*.js                      # Node.js hooks (statusline, guards, monitors, update check)
├── hooks/*.sh                      # Shell hooks (session state, commit validation, phase boundary)
├── settings.json                   # Hook registrations
└── VERSION                         # Installed version number
```

其他執行時的等效路徑：

- **OpenCode：** `~/.config/opencode/` 全域性或 `./.opencode/` 本地
- **Kilo：** `~/.config/kilo/` 全域性或 `./.kilo/` 本地
- **Gemini CLI：** `~/.gemini/` 全域性或 `./.gemini/` 本地
- **Codex：** `~/.codex/` 全域性或 `./.codex/` 本地
- **Copilot：** `~/.copilot/` 全域性或 `./.github/` 本地
- **Antigravity：** 自動檢測全域性根目錄（`~/.gemini/antigravity/`、`~/.gemini/antigravity-ide/` 或 `~/.gemini/antigravity-cli/`）或 `./.agent/` 本地
- **Cursor：** `~/.cursor/` 全域性或 `./.cursor/` 本地
- **Windsurf：** `~/.codeium/windsurf/` 全域性或 `./.windsurf/` 本地
- **Augment Code：** `~/.augment/` 全域性或 `./.augment/` 本地
- **Trae：** `~/.trae/` 全域性或 `./.trae/` 本地
- **Qwen Code：** `~/.qwen/` 全域性或 `./.qwen/` 本地
- **Hermes Agent：** `~/.hermes/` 全域性或 `./.hermes/` 本地
- **CodeBuddy：** `~/.codebuddy/` 全域性或 `./.codebuddy/` 本地
- **Cline：** `~/.cline/` 全域性或專案根目錄 `.clinerules` 本地

### 專案檔案（`.planning/`）

```
.planning/
├── PROJECT.md              # Project vision, constraints, decisions, evolution rules
├── REQUIREMENTS.md         # Scoped requirements (v1/v2/out-of-scope)
├── ROADMAP.md              # Phase breakdown with status tracking
├── STATE.md                # Living memory: position, decisions, blockers, metrics
├── config.json             # Workflow configuration
├── MILESTONES.md           # Completed milestone archive
├── research/               # Domain research from /gsd-new-project
│   ├── SUMMARY.md
│   ├── STACK.md
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   └── PITFALLS.md
├── codebase/               # Brownfield mapping (from /gsd-map-codebase)
│   ├── STACK.md            # YAML frontmatter carries `last_mapped_commit`
│   ├── ARCHITECTURE.md     # for the post-execute drift gate (#2003)
│   ├── CONVENTIONS.md
│   ├── CONCERNS.md
│   ├── STRUCTURE.md
│   ├── TESTING.md
│   └── INTEGRATIONS.md
├── phases/
│   └── XX-phase-name/
│       ├── XX-CONTEXT.md       # User preferences (from discuss-phase)
│       ├── XX-RESEARCH.md      # Ecosystem research (from plan-phase)
│       ├── XX-YY-PLAN.md       # Execution plans
│       ├── XX-YY-SUMMARY.md    # Execution outcomes
│       ├── XX-VERIFICATION.md  # Post-execution verification
│       ├── XX-VALIDATION.md    # Nyquist test coverage mapping
│       ├── XX-UI-SPEC.md       # UI design contract (from ui-phase)
│       ├── XX-UI-REVIEW.md     # Visual audit scores (from ui-review)
│       └── XX-UAT.md           # User acceptance test results
├── quick/                  # Quick task tracking
│   └── YYMMDD-xxx-slug/
│       ├── PLAN.md
│       └── SUMMARY.md
├── todos/
│   ├── pending/            # Captured ideas
│   └── done/               # Completed todos
├── threads/               # Persistent context threads (from /gsd-thread)
├── seeds/                 # Forward-looking ideas (from /gsd-capture --seed)
├── debug/                  # Active debug sessions
│   ├── *.md                # Active sessions
│   ├── resolved/           # Archived sessions
│   └── knowledge-base.md   # Persistent debug learnings
├── ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
└── continue-here.md        # Context handoff (from pause-work)
```

### 執行後代碼庫漂移關卡（#2003）

在 `/gsd-execute-phase` 最後一個波次提交後，工作流執行一個非阻塞性的 `codebase_drift_gate` 步驟（位於 `schema_drift_gate` 和 `verify_phase_goal` 之間）。它將 diff `last_mapped_commit..HEAD` 與 `.planning/codebase/STRUCTURE.md` 進行對比，並統計四類結構性元素：

1. 對映路徑之外的新目錄
2. `(packages|apps)/<name>/src/index.*` 處的新桶形匯出
3. 新遷移檔案
4. `routes/` 或 `api/` 下的新路由模組

若數量達到 `workflow.drift_threshold`（預設為 3），關卡將**警告**（預設）並顯示建議的 `/gsd-map-codebase --paths …` 命令，或**自動重新對映**（`workflow.drift_action = auto-remap`），方法是派生 `gsd-codebase-mapper` 並將其範圍限定為受影響的路徑。檢測或重新對映過程中的任何錯誤都會被記錄，階段繼續執行——漂移檢測不會導致驗證失敗。

`last_mapped_commit` 儲存在每個 `.planning/codebase/*.md` 檔案頂部的 YAML 前置後設資料中；`bin/lib/drift.cjs` 提供 `readMappedCommit` 和 `writeMappedCommit` 往返輔助函式。

---

## 安裝程式架構

安裝程式（`bin/install.js`，約 10,700 行）處理以下事項：

1. **執行時檢測** — 互動式提示或 CLI 標誌（`--claude`、`--opencode`、`--gemini`、`--kilo`、`--codex`、`--copilot`、`--antigravity`、`--cursor`、`--windsurf`、`--augment`、`--trae`、`--qwen`、`--hermes`、`--codebuddy`、`--cline`、`--all`）
2. **位置選擇** — 全域性（`--global`）或本地（`--local`）
3. **檔案部署** — 複製命令、技能、工作流、參考文件、模板、Agent 和 hook
4. **執行時適配** — 按執行時轉換檔案內容：
  - Claude Code：原樣使用
  - OpenCode：將命令/Agent 轉換為 OpenCode 相容的扁平命令 + 子 Agent 格式
  - Kilo：複用 OpenCode 轉換流水線，使用 Kilo 配置路徑
  - Codex：從命令生成 TOML 配置 + 技能
  - Copilot：對映工具名稱（Read→read、Bash→execute 等）
  - Gemini：調整 hook 事件名稱（`AfterTool` 而非 `PostToolUse`）
  - Antigravity：以技能為主，使用 Google 模型等效項
  - Cursor：以技能為主，帶 Cursor 規則引用
  - Windsurf：以技能為主，帶 Windsurf 規則引用
  - Trae：以技能為主安裝到 `~/.trae` / `./.trae`，不含 `settings.json` 或 hook 整合
  - Qwen Code：以技能為主，帶 Qwen 品牌路徑和提示詞重寫
  - Hermes Agent：在 `skills/gsd/` 下按類別分組的技能
  - CodeBuddy：以技能為主，帶 CodeBuddy 路徑和提示詞重寫
  - Cline：為基於規則的整合寫入 `.clinerules`
  - Augment Code：以技能為主，完整技能轉換和配置管理
5. **路徑規範化** — 將 `~/.claude/` 路徑替換為特定執行時路徑
6. **設定整合** — 在執行時的 `settings.json` 中註冊 hook
7. **補丁備份** — 自 v1.17 起，將本地修改的檔案備份到 `gsd-local-patches/`，供 `/gsd-update --reapply` 使用
8. **清單跟蹤** — 寫入 `gsd-file-manifest.json` 以支援乾淨解除安裝
9. **解除安裝模式** — `--uninstall` 移除所有 GSD 檔案、hook 和設定

安裝時的檔案移動、陳舊產物清理、配置重寫和使用者資料保留由安裝程式遷移模組管理。請參閱[安裝程式遷移](../installer-migrations.md)和 [ADR 0008](../adr/0008-installer-migration-module.md)。遷移模組還負責對舊版安裝進行帶關卡的首次基線掃描，在後續遷移移除或重寫任何內容之前，對已知的執行時安裝介面進行分類。

計劃漂移防護（`plan_review.source_grounding`）——在執行前驗證生成計劃中的符號引用是否與即時原始碼匹配——詳見 [ADR 22](../adr/22-plan-drift-guard.md)。

### 平臺處理

- **Windows：** 在子程序上設定 `windowsHide`，對受保護目錄進行 EPERM/EACCES 保護，路徑分隔符規範化
- **WSL：** 檢測在 WSL 上執行的 Windows Node.js 並警告路徑不匹配
- **Docker/CI：** 支援 `CLAUDE_CONFIG_DIR` 環境變數，用於自定義配置目錄位置

---

## Hook 系統

### 架構

```
Runtime Engine (Claude Code / Gemini CLI)
    │
    ├── statusLine event ──► gsd-statusline.js
    │   Reads: stdin (session JSON)
    │   Writes: stdout (formatted status), /tmp/claude-ctx-{session}.json (bridge)
    │
    ├── PostToolUse/AfterTool event ──► gsd-context-monitor.js
    │   Reads: stdin (tool event JSON), /tmp/claude-ctx-{session}.json (bridge)
    │   Writes: stdout (hookSpecificOutput with additionalContext warning)
    │
    └── SessionStart event ──► gsd-check-update.js
        Reads: VERSION file
        Writes: ~/.claude/cache/gsd-update-check.json (spawns background process)
```

### 上下文監控閾值


| 剩餘上下文 | 級別     | Agent 行為                                |
| --------- | -------- | ----------------------------------------- |
| > 35%     | 正常     | 不注入警告                                |
| ≤ 35%     | 警告     | "避免開始新的複雜工作"                     |
| ≤ 25%     | 嚴重     | "上下文即將耗盡，請告知使用者"               |


防抖：每次重複警告之間間隔 5 次工具使用。嚴重性升級（WARNING→CRITICAL）繞過防抖。

### 安全屬性

- 所有 hook 包裹在 try/catch 中，出錯時靜默退出
- stdin 超時防護（3 秒），防止管道問題導致掛起
- 忽略陳舊指標（超過 60 秒）
- 優雅處理缺失的橋接檔案（子 Agent、新會話）
- 上下文監控器為建議性——不發出覆蓋使用者偏好的命令式指令

### 軟體包合法性關卡（v1.42.1）

研究者 → 規劃者 → 執行者流水線包含一個針對 slopsquatting（AI 幻覺軟體包名稱被預先註冊並附帶惡意安裝後腳本）的供應鏈關卡。

**威脅模型：** GSD 將從"研究者命名一個軟體包"到"執行者執行 `npm install`"的完整路徑自動化。一個通過 `npm view`（僅證明已註冊，而非合法性）的幻覺名稱此前可能未被檢測到而流入。約 20% 的 AI 生成軟體包引用是幻覺；其中約 43% 的名稱在不同提示詞中反覆出現，使攻擊者的預先註冊在經濟上可行。

**關卡層次：**

| 層次 | 元件 | 操作 |
|-------|-----------|--------|
| 研究 | `gsd-phase-researcher` | 執行 `slopcheck install <pkgs> --json`；向 RESEARCH.md 寫入 `## Package Legitimacy Audit` 表格；在寫入 RESEARCH.md 之前剝離 `[SLOP]` 軟體包 |
| 規劃 | `gsd-planner` | 讀取審計表；在任何 `[ASSUMED]` 或 `[SUS]` 安裝任務之前插入 `checkpoint:human-verify`；向 `<threat_model>` 新增 `T-{phase}-SC` STRIDE 供應鏈行 |
| 執行 | `gsd-executor` | 規則 3 將軟體包安裝排除在自動修復範圍之外；失敗的安裝以檢查點形式呈現，而非靜默替換 |

**宣告溯源整合：** 通過 WebSearch 發現的軟體包名稱被標記為 `[ASSUMED]`（而非 `[VERIFIED]`），無論 `npm view` 結果如何。這通過在安裝邊界將溯源標籤強制執行為硬關卡，擴充套件了現有的 `[ASSUMED]` / `[VERIFIED]` / `[CITED]` 溯源系統——`[ASSUMED]` 始終在 PLAN.md 中生成 `checkpoint:human-verify`。

**生態系統覆蓋：** 研究者使用特定於登錄檔的驗證命令——`npm view`（Node）、`pip index versions`（Python）、`cargo search`（Rust）——而非單一通用檢查。這能捕獲跨生態系統幻覺（2025 年 USENIX 研究記錄的發生率約為 9%）。

**優雅降級：** 若 `slopcheck` 不可用，每個推薦軟體包都被標記為 `[ASSUMED]` 並通過檢查點設定關卡。研究和規劃繼續進行；系統不會因缺少工具依賴而硬性失敗。

**外部依賴：** `slopcheck`（MIT 協議，可通過 pip 安裝）。若被廢棄，`[ASSUMED]` 關卡回退機制維持人工檢查點覆蓋。

---

### 安全 Hook（v1.27）

有關 hook 和防護層如何融入更廣泛安全方法的概念概述，請參閱[安全模型](explanation/security-model.md)。

**提示詞防護**（`gsd-prompt-guard.js`）：

- 觸發於對 `.planning/` 檔案的 Write/Edit
- 掃描內容中的提示詞注入模式（角色覆蓋、指令繞過、系統標籤注入）
- 僅建議性——記錄檢測結果，不阻止操作
- 模式已內聯（`security.cjs` 的子集），以實現 hook 獨立性

**工作流防護**（`gsd-workflow-guard.js`）：

- 觸發於對非 `.planning/` 檔案的 Write/Edit
- 檢測 GSD 工作流上下文之外的編輯（無活動的 `/gsd-` 命令或任務子 Agent）
- 建議使用 `/gsd-quick` 或 `/gsd-fast` 進行狀態跟蹤的變更
- 通過 `hooks.workflow_guard: true` 選擇啟用（預設：false）

---

## 執行時抽象

GSD 通過統一的命令/工作流架構支援多種 AI 編碼執行時：

### 執行時安裝契約矩陣

此矩陣描述安裝程式當前實現的執行時介面。遷移特定的所有權和原始碼快照位於[安裝程式遷移](../installer-migrations.md#runtime-configuration-contract-registry)中。

| 執行時 | 全域性根目錄 | 本地根目錄 | 呼叫介面 | Agent 介面 | 配置與 hook |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude` | `./.claude` | 全域性 `skills/gsd-*/SKILL.md`；本地 `commands/gsd/*.md` | `agents/gsd-*.md` | `settings.json` hook 和 statusLine 條目 |
| OpenCode | `~/.config/opencode` | `./.opencode` | `command/gsd-*.md` | `agents/gsd-*.md` | `opencode.json` 或 `opencode.jsonc`；無 GSD hook |
| Kilo | `~/.config/kilo` | `./.kilo` | `command/gsd-*.md` | `agents/gsd-*.md` | `kilo.json` 或 `kilo.jsonc`；無 GSD hook |
| Gemini CLI | `~/.gemini` | `./.gemini` | `commands/gsd/*.toml` | `agents/gsd-*.md` | `settings.json` 功能標誌、hook 和 statusline |
| Codex | `~/.codex` | `./.codex` | `skills/gsd-*/SKILL.md` | `agents/` 源 markdown 加每個 Agent 的 TOML | `config.toml` `[agents.gsd-*]`、`[features].hooks`（規範；遺留別名 `codex_hooks` 在重新安裝時被識別並遷移到新版本，#3566）以及 hook 表 |
| GitHub Copilot | `~/.copilot` | `./.github` | `skills/gsd-*/SKILL.md` 和 `copilot-instructions.md` | `.agent.md` 檔案 | 無 GSD hook 或 statusline |
| Antigravity | 自動檢測：`~/.gemini/antigravity`、`~/.gemini/antigravity-ide` 或 `~/.gemini/antigravity-cli` | `./.agent` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | GSD 安裝時的 Gemini 風格 `settings.json` hook 條目 |
| Cursor | `~/.cursor` | `./.cursor` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下的規則引用；無 GSD hook |
| Windsurf | `~/.codeium/windsurf` | `./.windsurf` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下的規則引用；無 GSD hook |
| Augment Code | `~/.augment` | `./.augment` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | 無 GSD hook 或 statusline |
| Trae | `~/.trae` | `./.trae` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下的規則引用；無 GSD hook |
| Qwen Code | `~/.qwen` | `./.qwen` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | 通用 GSD 設定及在支援時的 hook 條目 |
| Hermes Agent | `~/.hermes` | `./.hermes` | `skills/gsd/DESCRIPTION.md` 加 `skills/gsd/gsd-*/SKILL.md` | `agents/gsd-*.md` | 通用 GSD 設定及在支援時的 hook 條目 |
| CodeBuddy | `~/.codebuddy` | `./.codebuddy` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | 通用 GSD 設定及在支援時的 hook 條目 |
| Cline | `~/.cline` | 專案根目錄 | `.clinerules` | 僅規則 | 無 GSD hook 或 statusline |

### 上游契約來源

執行時安裝預期在可用時對照主要文件進行檢查。當前原始碼快照為 2026-05-11：

- Claude Code：Anthropic 斜線命令、設定、hook 和子 Agent 文件。
- OpenCode 和 Kilo：OpenCode 配置文件和 Kilo 自定義子 Agent 文件。
- Gemini CLI 和 Qwen Code：命令/配置文件；Qwen 命令文件最後更新於 2026-05-06。
- Codex：OpenAI Codex 文件和 `config-schema.json`；安裝程式還支援 Codex 0.124.0 的 Agent 表格格式相容性。
- Copilot、Cursor、Cline、Augment、Hermes 和 CodeBuddy：自定義指令、規則、技能或配置的供應商文件。
- Antigravity、Windsurf 和 Trae：來源有限的行。安裝程式記錄了當前的相容性墊片，遷移前必須重新整理這些來源後再重寫其配置。

### 抽象點

1. **工具名稱對映** — 每個執行時有其自己的工具名稱（例如 Claude 的 `Bash` → Copilot 的 `execute`）
2. **Hook 事件名稱** — Claude 使用 `PostToolUse`，Gemini 使用 `AfterTool`
3. **Agent 前置後設資料** — 每個執行時有其自己的 Agent 定義格式
4. **路徑約定** — 每個執行時將配置儲存在不同的目錄中
5. **模型引用** — `inherit` 配置檔案讓 GSD 推遲到執行時的模型選擇

安裝程式在安裝時處理所有轉換。工作流和 Agent 以 Claude Code 的原生格式編寫，並在部署期間進行轉換。

---

## 相關文件

- [多 Agent 編排](explanation/multi-agent-orchestration.md)
- [安全模型](explanation/security-model.md)
- [CLI 工具](CLI-TOOLS.md)
- [文件索引](README.md)
