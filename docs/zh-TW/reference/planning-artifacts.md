# 規劃產物參考

`.planning/` 目錄是 GSD Core 專案的共享記憶。所有工作流都會讀取和寫入該目錄，並留下可審計的決策記錄。本頁列出每個檔案、其用途，以及哪些命令負責生成或消費它。參見[文件索引](../README.md)。

---

## 目錄結構

```
.planning/
├── PROJECT.md                          # 專案標識與核心價值
├── ROADMAP.md                          # 里程碑 + 階段列表及目標
├── REQUIREMENTS.md                     # 編號化驗收標準
├── STATE.md                            # 即時進度跟蹤器
├── config.json                         # 工作流與模型配置
├── MILESTONES.md                       # 里程碑歸檔（可選）
├── BACKLOG.md                          # 延期與未來工作（可選）
├── LEARNINGS.md                        # 跨階段積累的經驗（可選）
├── DECISIONS-INDEX.md                  # 歷史決策滾動摘要（可選）
├── METHODOLOGY.md                      # 可複用的解釋框架（可選）
├── HANDOFF.json                        # 機器可讀的暫停狀態（臨時檔案）
├── codebase/                           # 程式碼庫對映（可選）
│   ├── architecture.md
│   ├── stack.md
│   └── ...
├── intel/                              # 可查詢的符號索引（可選，intel.enabled）
│   └── API-SURFACE.md
└── phases/
    └── <NN>-<slug>/                    # 每個階段一個目錄
        ├── <NN>-CONTEXT.md             # 實現決策（discuss-phase）
        ├── <NN>-DISCUSSION-LOG.md      # 人類可讀的討論審計（discuss-phase）
        ├── <NN>-RESEARCH.md            # 技術研究結果（plan-phase）
        ├── <NN>-VALIDATION.md          # Nyquist 測試覆蓋策略（plan-phase）
        ├── <NN>-PATTERNS.md            # 程式碼庫類比對映（plan-phase，可選）
        ├── <NN>-<PP>-PLAN.md           # 可執行計劃（plan-phase，每個計劃一個）
        ├── <NN>-<PP>-SUMMARY.md        # 執行記錄（execute-phase，每個計劃一個）
        ├── <NN>-VERIFICATION.md        # 階段目標驗證報告（verify-phase）
        ├── <NN>-UAT.md                 # 持久化 UAT 會話狀態（execute-phase）
        └── .continue-here.md           # 暫停後的恢復說明（pause-work）
```

---

## 根級產物

### `PROJECT.md`

| | |
|---|---|
| **用途** | 規範的專案標識：專案內容、目標使用者、核心價值、需求、約束和關鍵決策。隨專案演進持續更新。 |
| **生成者** | `/gsd-new-project`（初始建立）；由 `/gsd-complete-milestone` 在決策驗證後更新。 |
| **消費者** | 所有規劃工作流；`gsd-phase-researcher`、`gsd-planner`（上下文）；`discuss-phase`（歷史決策）；`gsd-plan-checker`（專案約束）。 |

### `ROADMAP.md`

| | |
|---|---|
| **用途** | 里程碑與階段列表，含目標、需求 ID、成功標準以及每個階段的規範參考。是專案構建內容和順序的唯一可信來源。 |
| **生成者** | `/gsd-new-project`（初始建立）；由 `/gsd-phase --insert` 和 `/gsd-complete-milestone` 更新。 |
| **消費者** | `/gsd-discuss-phase`、`/gsd-plan-phase`、`/gsd-execute-phase`；所有需要階段資訊的編排命令；`gsd-planner`、`gsd-plan-checker`、`gsd-phase-researcher`。 |

### `REQUIREMENTS.md`

| | |
|---|---|
| **用途** | 編號化、可勾選的專案驗收標準。每條需求帶有 ID（如 `AUTH-01`），對映到路線圖階段。隨著階段執行，逐步標記需求為已完成。 |
| **生成者** | `/gsd-new-project`（初始建立）；需求由 `execute-phase` 標記為已完成。 |
| **消費者** | `gsd-planner`（計劃必須覆蓋所有階段需求 ID）；`gsd-plan-checker` 維度 1（需求覆蓋）；`discuss-phase`（歷史需求）。 |

### `STATE.md`

| | |
|---|---|
| **用途** | 即時進度跟蹤器——當前階段與計劃、進度指標、積累的決策、會話連續性說明。每次工作流執行時首先讀取，每次重要操作後更新。 |
| **生成者** | `/gsd-new-project`（初始建立）；由所有階段工作流、`/gsd-pause-work`、`/gsd-resume-work` 持續更新。 |
| **消費者** | 所有編排工作流；`/gsd-progress`；通過 `/gsd-quick` 執行的臨時任務；`gsd-planner` 和 `gsd-phase-researcher`（專案決策）。 |

完整欄位參考請參見 [STATE.md 模式](state-md.md)。

### `config.json`

| | |
|---|---|
| **用途** | 工作流配置：模型配置檔案、研究與計劃檢查器開關、Git 分支策略、Nyquist 驗證、並行化設定，以及每個代理的模型覆蓋。 |
| **生成者** | `/gsd-new-project`（初始建立）；`/gsd-settings`（互動式編輯）。 |
| **消費者** | 每個工作流和子代理——在初始化時通過 `gsd-tools query config-get` 讀取。 |

完整模式請參見 [CONFIGURATION](../CONFIGURATION.md)。

### `MILESTONES.md`（可選）

| | |
|---|---|
| **用途** | 已完成里程碑的歷史記錄。每個里程碑關閉時填充；提供已交付內容及時間的存檔快照。 |
| **生成者** | `/gsd-complete-milestone`。 |
| **消費者** | `/gsd-audit-milestone`；人工審查。 |

### `DECISIONS-INDEX.md`（可選）

| | |
|---|---|
| **用途** | 先前階段 CONTEXT.md 檔案中捕獲的決策的有界滾動摘要。存在時，`discuss-phase` 讀取此單一檔案，而不是逐一讀取最多三個先前的 CONTEXT.md 檔案，從而節省上下文預算。 |
| **生成者** | 當先前階段數量超過滾動讀取閾值時生成。 |
| **消費者** | `discuss-phase`（`load_prior_context` 步驟）。 |

### `HANDOFF.json`（臨時檔案）

| | |
|---|---|
| **用途** | 工作中斷時寫入的機器可讀暫停狀態。包含恢復點、進行中的上下文以及繼續說明。恰好消費一次——在恢復時。 |
| **生成者** | `/gsd-pause-work`。 |
| **消費者** | `/gsd-resume-work`。 |

---

## 每階段產物

所有每階段檔案均位於 `.planning/phases/<NN>-<slug>/` 下，其中 `NN` 是補零的階段編號，`slug` 是用連字元連線的階段名稱。

### `<NN>-CONTEXT.md`

| | |
|---|---|
| **用途** | 規劃開始前捕獲的實現決策。包含階段邊界（`<domain>`）、帶有 `D-NN` 識別符號的鎖定決策（`<decisions>`）、規範文件參考（`<canonical_refs>`）、現有程式碼洞察（`<code_context>`）、具體靈感（`<specifics>`）以及推遲的想法（`<deferred>`）。 |
| **生成者** | `/gsd-discuss-phase`（互動式討論或 PRD/ADR 快速路徑）。 |
| **消費者** | `gsd-phase-researcher`（待調查內容）；`gsd-planner`（鎖定決策）；`gsd-plan-checker` 維度 7（上下文合規性）。 |

完整欄位參考請參見 [CONTEXT.md 模式](context-md.md)。

### `<NN>-DISCUSSION-LOG.md`

| | |
|---|---|
| **用途** | discuss-phase 會話的人類可讀審計記錄：討論的領域、提出的選項、所做的選擇、推遲的想法以及留給 Claude 自行決定的事項。不被自動化工作流消費。 |
| **生成者** | `/gsd-discuss-phase`（`git_commit` 步驟）。 |
| **消費者** | 人工審查；回顧總結。 |

### `<NN>-RESEARCH.md`

| | |
|---|---|
| **用途** | 規劃前產生的技術研究結果。回答"為了很好地規劃此階段，我需要了解什麼？"——涵蓋領域分析、模式、風險、架構職責對映以及驗證架構部分（由 Nyquist 門控使用）。 |
| **生成者** | `/gsd-plan-phase` 通過 `gsd-phase-researcher` 代理。 |
| **消費者** | `gsd-planner`（規劃輸入）；`gsd-plan-checker` 維度 7c（層級合規性）、維度 8（Nyquist）、維度 11（研究解決）；`gsd-pattern-mapper`（檔案列表來源）。 |

### `<NN>-VALIDATION.md`

| | |
|---|---|
| **用途** | 源自 RESEARCH.md 中 `## Validation Architecture` 部分的 Nyquist 啟發式驗證策略。指定計劃必須遵守的自動化測試覆蓋要求。 |
| **生成者** | `/gsd-plan-phase`（步驟 5.5，當 `workflow.nyquist_validation` 已啟用且 RESEARCH.md 包含驗證架構部分時）。 |
| **消費者** | `gsd-plan-checker` 維度 8（檢查 8e 門控——Nyquist 檢查進行前必須存在）；`gsd-verifier`。 |

### `<NN>-PATTERNS.md`

| | |
|---|---|
| **用途** | 由 `gsd-pattern-mapper` 生成的程式碼庫類比對映。針對本階段每個待建立或修改的檔案，識別最近似的現有類比，對檔案的角色和資料流進行分類，並提取具體程式碼摘錄。引導規劃者採用一致的模式。 |
| **生成者** | `/gsd-plan-phase` 通過 `gsd-pattern-mapper` 代理（可選；如果 `workflow.pattern_mapper: false` 則跳過）。 |
| **消費者** | `gsd-planner`（模式指導）；`gsd-plan-checker` 維度 12（模式合規性）。 |

### `<NN>-<PP>-PLAN.md`

| | |
|---|---|
| **用途** | 階段內單個工作單元的可執行計劃。包含 YAML 前置內容（wave、dependencies、files、requirements、`must_haves`）、目標、上下文參考、帶有 `<read_first>`、`<action>`、`<verify>` 和 `<acceptance_criteria>` 欄位的 XML 結構化任務，以及驗證標準。 |
| **生成者** | `/gsd-plan-phase` 通過 `gsd-planner` 代理。每個計劃一個檔案——例如，`03-02-PLAN.md` 是第 3 階段第 2 個計劃。 |
| **消費者** | `/gsd-execute-phase`（執行器代理讀取計劃並執行任務）；`gsd-plan-checker`（執行前品質審查）；`gsd-verifier`（讀取 `must_haves` 進行執行後驗證）。 |

完整欄位參考請參見 [PLAN.md 模式](plan-md.md)。

### `<NN>-<PP>-SUMMARY.md`

| | |
|---|---|
| **用途** | 計劃完成後寫入的執行記錄。記錄已構建內容、與計劃的偏差、對驗收標準的自查，以及階段的依賴關係圖。 |
| **生成者** | `execute-phase` 執行器代理（在每個計劃執行結束時寫入）。 |
| **消費者** | `/gsd-progress`（階段狀態）；`gsd-planner`（當後續計劃對先前計劃輸出存在真實依賴時）；`milestone-summary`。 |

### `<NN>-VERIFICATION.md`

| | |
|---|---|
| **用途** | 階段目標驗證報告。在執行完成後，對照實際程式碼庫檢查所有計劃中的 `must_haves.truths`、`must_haves.artifacts` 和 `must_haves.key_links`。記錄 `status: passed | gaps_found | human_needed`。 |
| **生成者** | `/gsd-verify-work`（或 `/gsd-execute-phase` 內的驗證步驟）。 |
| **消費者** | `plan-phase` 已關閉階段門控（`status: passed` 的 VERIFICATION.md 將階段標記為 `Complete`，並在沒有 `--force` 的情況下阻止重新規劃）；`/gsd-progress`；人工審查。 |

### `<NN>-UAT.md`

| | |
|---|---|
| **用途** | 持久化的 UAT 會話跟蹤。在即時 UAT 會話中記錄每個測試用例、預期的可觀察行為、結果以及開發者響應。帶有 YAML 前置內容（`status`、`phase`、`source`、時間戳）。 |
| **生成者** | `/gsd-audit-uat`（互動式 UAT 會話）。 |
| **消費者** | `/gsd-audit-uat`（恢復先前的 UAT 會話）。 |

### `.continue-here.md`

| | |
|---|---|
| **用途** | 階段工作暫停時寫入的人類可讀恢復說明。包含供恢復代理使用的上下文：關鍵反模式、阻塞問題、必讀內容以及恢復的確切命令。 |
| **生成者** | `/gsd-pause-work`。 |
| **消費者** | 任何在階段上啟動的工作流——`discuss-phase` 和 `plan-phase` 在入口處均檢查此檔案，並要求代理在繼續之前證明其理解了所有 `blocking` 反模式。 |

---

## 命名約定

| 片段 | 格式 | 示例 |
|---|---|---|
| 階段目錄 | `<NN>-<slug>` | `03-post-feed` |
| 階段級檔案 | `<NN>-<ARTIFACT>.md` | `03-CONTEXT.md` |
| 計劃級檔案 | `<NN>-<PP>-<ARTIFACT>.md` | `03-02-PLAN.md` |
| `NN` | 補零的階段編號 | `03` 表示第 3 階段 |
| `PP` | 階段內補零的計劃編號 | `02` 表示第 2 個計劃 |

當 `config.json` 中設定了 `project_code` 時，階段目錄使用專案程式碼作為字首：對於專案程式碼 `CK`、第 3 階段，目錄為 `CK-03-post-feed`。

---

## 相關內容

- [STATE.md 模式](state-md.md)
- [CONTEXT.md 模式](context-md.md)
- [PLAN.md 模式](plan-md.md)
- [文件索引](../README.md)
