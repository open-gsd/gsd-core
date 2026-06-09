# GSD CLI 工具參考

> `gsd-tools` CLI（`get-shit-done/bin/gsd-tools.cjs`）參考文件。斜槓命令與使用者流程請參見[命令參考](COMMANDS.md)。返回[文件索引](README.md)。

---

## 概述

`gsd-tools.cjs` 集中處理配置解析、模型解析、階段查詢、Git 提交、摘要驗證、狀態管理以及模板操作，供 GSD 命令、工作流和代理使用。


|                    |                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **釋出路徑**   | `get-shit-done/bin/gsd-tools.cjs`                                                                                                                                                                      |
| **實現**       | `get-shit-done/bin/lib/` 下的 20 個領域模組（以該目錄為準）                                                                                                                                              |
| **狀態**       | 編排、工作流和自動化的主要執行時命令介面。 |


**用法（CJS）：**

```bash
node gsd-tools.cjs <command> [args] [--raw] [--cwd <path>]
```

**全域性標誌（CJS）：**


| 標誌           | 說明                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `--raw`        | 機器可讀輸出（JSON 或純文本，無格式）                  |
| `--cwd <path>` | 覆蓋工作目錄（用於沙箱子代理）                         |
| `--ws <name>`  | `.planning/workstreams/<name>` 路徑的工作流上下文 |


---

## 狀態命令

管理 `.planning/STATE.md`——專案的活動記憶。

```bash
# 以 JSON 格式載入完整專案配置和狀態
node gsd-tools.cjs state load

# 以 JSON 格式輸出 STATE.md frontmatter
node gsd-tools.cjs state json

# 更新單個欄位
node gsd-tools.cjs state update <field> <value>

# 獲取 STATE.md 內容或特定章節
node gsd-tools.cjs state get [section]

# 批次更新多個欄位
node gsd-tools.cjs state patch --field1 val1 --field2 val2

# 遞增計劃計數器
node gsd-tools.cjs state advance-plan

# 記錄執行指標
node gsd-tools.cjs state record-metric --phase N --plan M --duration Xmin [--tasks N] [--files N]

# 重新計算進度條
node gsd-tools.cjs state update-progress

# 新增決策
node gsd-tools.cjs state add-decision --summary "..." [--phase N] [--rationale "..."]
# 或從檔案讀取：
node gsd-tools.cjs state add-decision --summary-file path [--rationale-file path]

# 新增/解決阻塞項
node gsd-tools.cjs state add-blocker --text "..."
node gsd-tools.cjs state resolve-blocker --text "..."

# 記錄會話連續性
node gsd-tools.cjs state record-session --stopped-at "..." [--resume-file path]

# 階段開始——為新階段更新 STATE.md 的狀態/最後活動
node gsd-tools.cjs state begin-phase --phase N --name SLUG --plans COUNT

# 代理可發現的阻塞訊號（由 discuss-phase / UI 流程使用）
node gsd-tools.cjs state signal-waiting --type TYPE --question "..." --options "A|B" --phase P
node gsd-tools.cjs state signal-resume
```

### 狀態快照

對完整 STATE.md 進行結構化解析：

```bash
node gsd-tools.cjs state-snapshot
```

返回 JSON，包含：當前位置、階段、計劃、狀態、決策、阻塞項、指標、最後活動。

---

## 階段命令

管理階段——目錄、編號和路線圖同步。

```bash
# 按編號查詢階段目錄
node gsd-tools.cjs find-phase <phase>

# 計算插入用的下一個小數階段編號
node gsd-tools.cjs phase next-decimal <phase>

# 向路線圖追加新階段並建立目錄
node gsd-tools.cjs phase add <description>

# 在現有階段後插入小數階段
node gsd-tools.cjs phase insert <after> <description>

# 移除階段，對後續階段重新編號
node gsd-tools.cjs phase remove <phase> [--force]

# 標記階段完成，更新狀態和路線圖
node gsd-tools.cjs phase complete <phase>

# 按波次和狀態索引計劃
node gsd-tools.cjs phase-plan-index <phase>

# 列出階段並過濾
node gsd-tools.cjs phases list [--type planned|executed|all] [--phase N] [--include-archived]
```

---

## 路線圖命令

解析和更新 `ROADMAP.md`。

```bash
# 從 ROADMAP.md 提取階段章節
node gsd-tools.cjs roadmap get-phase <phase>

# 帶磁碟狀態的完整路線圖解析
node gsd-tools.cjs roadmap analyze

# 從磁碟更新進度表行
node gsd-tools.cjs roadmap update-plan-progress <N>
```

---

## 配置命令

讀寫 `.planning/config.json`。

```bash
# 以預設值初始化 config.json
node gsd-tools.cjs config-ensure-section

# 設定配置值（點號表示法）
node gsd-tools.cjs config-set <key> <value>

# 獲取配置值
node gsd-tools.cjs config-get <key>

# 設定模型配置檔案
node gsd-tools.cjs config-set-model-profile <profile>
```

---

## 模型解析

```bash
# 根據當前配置檔案獲取代理使用的模型
node gsd-tools.cjs resolve-model <agent-name>
# 原始輸出返回所選模型 ID/層級。
# JSON 輸出還包括配置檔案，以及當活躍執行時支援時的
# reasoning_effort。
```

代理名稱：`gsd-planner`、`gsd-executor`、`gsd-phase-researcher`、`gsd-project-researcher`、`gsd-research-synthesizer`、`gsd-verifier`、`gsd-plan-checker`、`gsd-integration-checker`、`gsd-roadmapper`、`gsd-debugger`、`gsd-codebase-mapper`、`gsd-nyquist-auditor`

---

## 驗證命令

驗證計劃、階段、引用和提交。

```bash
# 驗證 SUMMARY.md 檔案
node gsd-tools.cjs verify-summary <path> [--check-count N]

# 檢查 PLAN.md 結構和任務
node gsd-tools.cjs verify plan-structure <file>

# 檢查所有計劃是否有摘要
node gsd-tools.cjs verify phase-completeness <phase>

# 檢查 @-引用和路徑是否可解析
node gsd-tools.cjs verify references <file>

# 批次驗證提交雜湊
node gsd-tools.cjs verify commits <hash1> [hash2] ...

# 檢查 must_haves.artifacts
node gsd-tools.cjs verify artifacts <plan-file>

# 檢查 must_haves.key_links
node gsd-tools.cjs verify key-links <plan-file>
```

---

## 校驗命令

檢查專案完整性。

```bash
# 檢查階段編號、磁碟/路線圖同步
node gsd-tools.cjs validate consistency

# 檢查 .planning/ 完整性，可選修復
node gsd-tools.cjs validate health [--repair]

# 探測上下文視窗利用率（用於狀態行/鉤子呼叫方）（v1.40.0）
node gsd-tools.cjs validate context

# 以型別化 JSON 介面輸出上下文利用率（#455）
node gsd-tools.cjs validate context --json
```

`validate context` 輸出包含 `utilization`、`status`（在 60% / 70% 閾值處分別為 `ok` / `warn` / `critical`）以及 `suggestion` 字串的結構化信封。相同資料支撐 `/gsd-health --context`。
傳入 `--json` 可直接接收型別化中間表示（適用於指令碼和測試斷言）。

---

## 模板命令

模板選擇與填充。

```bash
# 根據粒度選擇摘要模板
node gsd-tools.cjs template select <type>

# 用變數填充模板
node gsd-tools.cjs template fill <type> --phase N [--plan M] [--name "..."] [--type execute|tdd] [--wave N] [--fields '{json}']
```

`fill` 的模板型別：`summary`、`plan`、`verification`

---

## Frontmatter 命令

對任意 Markdown 檔案執行 YAML frontmatter 的增刪改查。

```bash
# 以 JSON 格式提取 frontmatter
node gsd-tools.cjs frontmatter get <file> [--field key]

# 更新單個欄位
node gsd-tools.cjs frontmatter set <file> --field key --value jsonVal

# 將 JSON 合併到 frontmatter
node gsd-tools.cjs frontmatter merge <file> --data '{json}'

# 驗證必填欄位
node gsd-tools.cjs frontmatter validate <file> --schema plan|summary|verification
```

---

## 腳手架命令

建立預結構化檔案和目錄。

```bash
# 建立 CONTEXT.md 模板
node gsd-tools.cjs scaffold context --phase N

# 建立 UAT.md 模板
node gsd-tools.cjs scaffold uat --phase N

# 建立 VERIFICATION.md 模板
node gsd-tools.cjs scaffold verification --phase N

# 建立階段目錄
node gsd-tools.cjs scaffold phase-dir --phase N --name "phase name"
```

---

## Init 命令（複合上下文載入）

通過單次呼叫載入特定工作流所需的所有上下文。返回包含專案資訊、配置、狀態和工作流專屬資料的 JSON。

```bash
node gsd-tools.cjs init execute-phase <phase>
node gsd-tools.cjs init plan-phase <phase>
node gsd-tools.cjs init new-project
node gsd-tools.cjs init new-milestone
node gsd-tools.cjs init quick <description>
node gsd-tools.cjs init resume
node gsd-tools.cjs init verify-work <phase>
node gsd-tools.cjs init phase-op <phase>
node gsd-tools.cjs init todos [area]
node gsd-tools.cjs init milestone-op
node gsd-tools.cjs init map-codebase
node gsd-tools.cjs init progress

# 工作流範圍的 init（`--ws` 標誌）
node gsd-tools.cjs init execute-phase <phase> --ws <name>
node gsd-tools.cjs init plan-phase <phase> --ws <name>
```

**大載荷處理：** 當輸出超過約 50KB 時，CLI 會將內容寫入臨時檔案並返回 `@file:/tmp/gsd-init-XXXXX.json`。工作流檢查 `@file:` 字首並從磁碟讀取：

```bash
INIT=$(node gsd-tools.cjs init execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

---

## 里程碑命令

```bash
# 歸檔里程碑
node gsd-tools.cjs milestone complete <version> [--name <name>] [--archive-phases]

# 將需求標記為完成
node gsd-tools.cjs requirements mark-complete <ids>
# 接受格式：REQ-01,REQ-02 或 REQ-01 REQ-02 或 [REQ-01, REQ-02]
```

---

## 代理技能

輸出指定代理型別的技能塊。

```bash
# 輸出原始 XML 技能塊（預設——適合 shell 展開）
node gsd-tools.cjs agent-skills <agent-type>

# 輸出型別化 JSON 介面（#455）——{ agent_type, block, skills_count }
node gsd-tools.cjs agent-skills <agent-type> --json
```

`--json` 標誌返回適合結構化消費和測試斷言的型別化中間表示物件，而預設（無標誌）保留工作流 shell 展開所依賴的原始 XML 輸出。

---

## 技能清單

預計算並快取技能發現結果，以加快命令載入速度。

```bash
# 生成技能清單（寫入 .claude/skill-manifest.json）
node gsd-tools.cjs skill-manifest

# 生成並指定自定義輸出路徑
node gsd-tools.cjs skill-manifest --output <path>
```

返回所有可用 GSD 技能的 JSON 對映，包含其後設資料（名稱、描述、檔案路徑、引數提示）。由安裝程式和會話啟動鉤子使用，以避免重複的檔案系統掃描。

---

## 工具命令

```bash
# 將文本轉換為 URL 安全的 slug
node gsd-tools.cjs generate-slug "Some Text Here"
# → some-text-here

# 獲取時間戳
node gsd-tools.cjs current-timestamp [full|date|filename]

# 統計並列出待辦事項
node gsd-tools.cjs list-todos [area]

# 檢查檔案/目錄是否存在
node gsd-tools.cjs verify-path-exists <path>

# 聚合所有 SUMMARY.md 資料
node gsd-tools.cjs history-digest

# 從 SUMMARY.md 提取結構化資料
node gsd-tools.cjs summary-extract <path> [--fields field1,field2]

# 專案統計
node gsd-tools.cjs stats [json|table]

# 進度渲染（人類可讀）
node gsd-tools.cjs progress [json|table|bar]

# 以型別化 JSON 介面輸出進度（#455）
node gsd-tools.cjs progress --json

# 完成待辦事項
node gsd-tools.cjs todo complete <filename>

# UAT 審計——掃描所有階段的未解決事項
node gsd-tools.cjs audit-uat

# 跨製品審計佇列——掃描 `.planning/` 中未解決的審計事項
node gsd-tools.cjs audit-open [--json]

# 將 GSD-2 專案反向遷移到當前結構（支撐 `/gsd-import --from-gsd2`）
node gsd-tools.cjs from-gsd2 [--path <dir>] [--force] [--dry-run]

# 帶配置檢查的 Git 提交
node gsd-tools.cjs commit <message> [--files f1 f2] [--amend] [--no-verify] [--respect-staged]
```

> `--no-verify`：跳過預提交鉤子。由並行執行器代理在基於波次的執行過程中使用，以避免構建鎖爭用（例如 Rust 專案中的 cargo lock 衝突）。編排器在每個波次完成後執行一次鉤子。順序執行時不要使用 `--no-verify`——讓鉤子正常執行。
> `--files <paths>` **暫存行為**：預設情況下，`--files` 在提交前對每個命名檔案執行 `git add -- <path>`。這會覆蓋通過 `git add -p` 設定的任何按塊暫存。傳入 `--respect-staged` 可跳過 `git add` 步驟，僅提交已在索引中且在請求路徑規格內的內容。如果該範圍內沒有已暫存的內容，命令將返回 `{ committed: false, reason: 'nothing staged' }` 而不報錯。兩種模式下提交都會附加 `-- <paths>` 路徑規格，因此 `--files` 範圍之外已暫存的檔案永遠不會被包含（#3061 不變數）。

# 網頁搜尋（需要 Brave API 金鑰）
node gsd-tools.cjs websearch <query> [--limit N] [--freshness day|week|month]
```

---

## Graphify

在 `.planning/graphs/` 中構建、查詢和檢查專案知識圖譜。需要在 `config.json` 中設定 `graphify.enabled: true`（參見[配置參考](CONFIGURATION.md#graphify-settings)）。

```bash
# 構建或重建知識圖譜
node gsd-tools.cjs graphify build

# 在圖譜中搜索某個詞
node gsd-tools.cjs graphify query <term>

# 顯示圖譜新鮮度和統計資料
node gsd-tools.cjs graphify status

# 顯示自上次構建以來的變更
node gsd-tools.cjs graphify diff

# 寫入當前圖譜的命名快照
node gsd-tools.cjs graphify snapshot [name]
```

使用者入口：`/gsd-graphify`（參見[命令參考](COMMANDS.md#gsd-graphify)）。

---

## 模組架構

| 模組 | 檔案 | 匯出 |
|--------|------|---------|
| 核心 | `lib/core.cjs` | `error()`、`output()`、`parseArgs()`、共享工具、相容性重匯出 |
| 狀態 | `lib/state.cjs` | 所有 `state` 子命令、`state-snapshot` |
| 階段 | `lib/phase.cjs` | 階段增刪改查、`find-phase`、`phase-plan-index`、`phases list` |
| 規劃工作區 | `lib/planning-workspace.cjs` | 規劃接縫：`planningDir`、`planningPaths`、活躍工作流路由、`.planning/.lock` |
| 路線圖 | `lib/roadmap.cjs` | 路線圖解析、階段提取、進度更新 |
| 配置 | `lib/config.cjs` | 配置讀寫、章節初始化 |
| 驗證 | `lib/verify.cjs` | 所有驗證和校驗命令 |
| 模板 | `lib/template.cjs` | 模板選擇和變數填充 |
| Frontmatter | `lib/frontmatter.cjs` | YAML frontmatter 增刪改查 |
| Init | `lib/init.cjs` | 所有工作流的複合上下文載入 |
| 里程碑 | `lib/milestone.cjs` | 里程碑歸檔、需求標記 |
| 命令 | `lib/commands.cjs` | 雜項：slug、時間戳、待辦事項、腳手架、統計、網頁搜尋 |
| 模型配置檔案 | `lib/model-profiles.cjs` | 配置檔案解析表 |
| UAT | `lib/uat.cjs` | 跨階段 UAT/驗證審計 |
| 配置檔案輸出 | `lib/profile-output.cjs` | 開發者配置檔案格式化 |
| 配置檔案流水線 | `lib/profile-pipeline.cjs` | 會話分析流水線 |
| Graphify | `lib/graphify.cjs` | 知識圖譜構建/查詢/狀態/差異/快照（支撐 `/gsd-graphify`） |
| 學習記錄 | `lib/learnings.cjs` | 從階段/SUMMARY 製品中提取學習記錄（支撐 `/gsd-extract-learnings`） |
| 審計 | `lib/audit.cjs` | 階段/里程碑審計佇列處理器；`audit-open` 助手 |
| GSD2 匯入 | `lib/gsd2-import.cjs` | 從 GSD-2 專案反向遷移匯入（支撐 `/gsd-import --from-gsd2`） |
| Intel | `lib/intel.cjs` | 可查詢的程式碼庫智慧索引（支撐 `/gsd-map-codebase --query`） |

---

## 審閱器 CLI 路由

`review.models.<cli>` 將審閱器型別對映到程式碼審查工作流呼叫的 shell 命令。通過 [`/gsd-config --integrations`](COMMANDS.md#gsd-config) 或直接設定：

```bash
node gsd-tools.cjs config-set review.models.codex    "codex exec --model gpt-5"
node gsd-tools.cjs config-set review.models.gemini   "gemini -m gemini-2.5-pro"
node gsd-tools.cjs config-set review.models.opencode "opencode run --model claude-sonnet-4"
node gsd-tools.cjs config-set review.models.claude   ""   # 清除——回退到會話模型
```

Slug 將針對 `[a-zA-Z0-9_-]+` 進行驗證；空或包含路徑的 slug 將被拒絕。完整欄位參考請參見 [`docs/CONFIGURATION.md`](CONFIGURATION.md#code-review-cli-routing)。

## 金鑰處理

通過 `/gsd-settings` 配置的 API 金鑰（`brave_search`、`firecrawl`、`exa_search`）以明文形式寫入 `.planning/config.json`，但在所有 `config-set` / `config-get` 輸出、確認表格和互動式提示中均會被遮蔽（`****<last-4>`）。遮蔽實現請參見 `get-shit-done/bin/lib/secrets.cjs`。`config.json` 檔案本身是安全邊界——請通過檔案系統許可權保護它，並將其排除在 git 之外（`.planning/` 預設已被 gitignore）。

---

## 相關文件

- [命令](COMMANDS.md)
- [配置](CONFIGURATION.md)
- [架構](ARCHITECTURE.md)
- [文件索引](README.md)
