# STATE.md 架構參考

`STATE.md` 是 GSD Core 的動態專案記憶檔案——一個記錄專案當前狀態、最近發生的事情以及下一步操作的單一 Markdown 文件。本頁面記錄其結構。參見[文件索引](../README.md)。

---

## 概述

由 GSD Core 管理的每個專案在 `.planning/STATE.md` 處儲存一個 `STATE.md`。該檔案在每次工作流開始時被讀取，並在每次重要操作後被寫入。該檔案包含：

- **YAML 前置資料** — 機器可讀欄位，由狀態行鉤子（`parseStateMd`）和 `gsd-tools state` 命令使用。
- **Markdown 正文** — 人類可讀的章節，涵蓋當前位置、累積的上下文、會話連續性以及效能指標。

該檔案有意保持較小（目標：不超過 100 行）。它是專案狀態的摘要，而非存檔。

---

## YAML 前置資料

前置資料出現在檔案最開頭的 `---` 分隔符之間。除 `gsd_state_version` 和 `status` 外，所有欄位均為可選；當相關資料尚不可用時，欄位可以缺失。

### 註釋示例

```yaml
---
gsd_state_version: '1.0'
milestone: v2.0
milestone_name: Code Quality
status: executing

# Phase-lifecycle fields — all optional (added in v1.40.0, issue #2833)
active_phase: "4.5"
next_action: execute-phase
next_phases: ["4.5"]

progress:
  total_phases: 17
  completed_phases: 10
  total_plans: 84
  completed_plans: 47
  percent: 59

# Additional fields written by syncStateFrontmatter
current_phase: "4"
current_phase_name: Observability
current_plan: "3"
last_updated: "2026-06-01T12:34:56.789Z"
last_activity: "2026-06-01"
stopped_at: "Phase 4 P3 execution complete"
paused_at: null
---
```

### 欄位參考

| 欄位 | 型別 | 填充時機 | 用途 |
|---|---|---|---|
| `gsd_state_version` | 字串（`'1.0'`） | 始終 | 架構版本；在第一次 `state.*` 呼叫時由 `syncStateFrontmatter` 寫入。 |
| `milestone` | 字串（如 `v2.0`） | 配置了里程碑時 | 當前里程碑版本，從專案配置中讀取。 |
| `milestone_name` | 字串 | 配置了里程碑時 | 里程碑的人類可讀標籤（如 `Code Quality`）。 |
| `status` | 字串 | 始終 | 當前生命週期階段。由 `normalizeStateStatus()` 規範化——參見[狀態值](#狀態值)。 |
| `active_phase` | 字串（如 `"4.5"`） | 編排器命令正在處理該階段時 | 當前正在處理的階段編號。階段之間時設為 `null`。 |
| `next_action` | 字串 | 空閒且有推薦命令時 | 下一步要執行的斜線命令：`discuss-phase`、`plan-phase`、`execute-phase` 或 `verify-phase`。當編排器正在執行或無可用推薦時設為 `null`。 |
| `next_phases` | YAML 流陣列（如 `["4.5"]`） | 與 `next_action` 配合使用 | `next_action` 適用的階段 ID（通常 1–2 項）。與 `next_action` 相同條件下設為 `null`。 |
| `progress.total_phases` | 整數 | 階段資料可用時 | 當前里程碑中的階段總數，從 ROADMAP.md 和階段目錄派生。 |
| `progress.completed_phases` | 整數 | 階段資料可用時 | 磁碟上所有計劃摘要均已存在的階段數量（即每個計劃均已完成）。 |
| `progress.total_plans` | 整數 | 計劃檔案存在時 | 當前里程碑中所有階段的計劃檔案總數。 |
| `progress.completed_plans` | 整數 | 摘要檔案存在時 | 已完成的計劃摘要總數（每個已執行計劃一個 SUMMARY.md）。 |
| `progress.percent` | 整數 0–100 | 進度資料可用時 | 里程碑在**階段維度**的進度（`min(completed_plans/total_plans, completed_phases/total_phases)`）。狀態行進度條僅在該欄位存在時渲染——缺失時進度條不顯示。 |
| `current_phase` | 字串 | 階段正在執行時 | 從正文 `Current Phase:` 欄位提取的階段編號。 |
| `current_phase_name` | 字串 | 階段有名稱時 | 從正文 `Current Phase Name:` 欄位提取的階段名稱。 |
| `current_plan` | 字串 | 計劃進行中時 | 從正文 `Current Plan:` 欄位提取的計劃編號。 |
| `last_updated` | ISO-8601 時間戳 | 始終（寫入時） | 最後一次 `syncStateFrontmatter` 呼叫的時間戳；由 `realClock.nowIso()` 寫入。 |
| `last_activity` | 字串 | 正文中設定時 | 最後活動日期，從正文 `Last Activity:` 欄位提取。 |
| `stopped_at` | 字串 | 記錄了停止點時 | 最後完成操作的描述；限定在 `## Session` 正文章節內，以避免匹配存檔文本。 |
| `paused_at` | 字串 | 專案已暫停時 | 暫停點的自由描述；未暫停時缺失或為 `null`。 |

### 狀態值

`get-shit-done/bin/lib/state-document.cjs` 中的 `normalizeStateStatus()` 將原始正文文本對映到以下規範值：

| 規範值 | 匹配文本（不區分大小寫） |
|---|---|
| `discussing` | 包含 `discussing` |
| `planning` | 包含 `planning` 或 `ready to plan` |
| `executing` | 包含 `executing`、`in progress` 或 `ready to execute` |
| `verifying` | 包含 `verif` |
| `completed` | 包含 `complete` 或 `done` |
| `paused` | 包含 `paused` 或 `stopped`，或 `paused_at` 有值 |
| `unknown` | 以上均不符合 |

當編排器命令正在執行時，慣例（issue #2833）是直接將生命週期階段寫入 `status`：

| 命令 | 執行期間的 `status` |
|---|---|
| `/gsd-discuss-phase` | `discussing` |
| `/gsd-plan-phase` | `planning` |
| `/gsd-execute-phase` | `executing` |
| `/gsd-verify-work` | `verifying` |

---

## 狀態行渲染場景

`hooks/gsd-statusline.js` 中的 `formatGsdState()` 讀取已解析的前置資料並輸出**第一個匹配的場景**。如果沒有新的生命週期欄位適用，渲染將回退到與 v1.38.x 完全一致的原始格式。

| 場景 | 觸發條件 | 顯示示例 |
|---|---|---|
| **1. 階段活躍** | `active_phase` 已填充 | `v2.0 [██░░░░░░░░] 20% · Phase 4.5 executing` |
| **2. 空閒，有下一步推薦** | `active_phase` 為 null 且 `next_action` 和 `next_phases` 均已填充 | `v2.0 [██░░░░░░░░] 20% · next execute-phase 4.5` |
| **3. 里程碑完成** | `percent` 為 `100` 或 `completed_phases == total_phases` | `v2.0 [██████████] 100% · milestone complete` |
| **4. 預設回退** | 以上均不匹配 | `v1.9 Code Quality · executing · ph 1/5`（現有格式） |

**場景優先順序：** 當 `active_phase` 和 `next_action` 均已填充時，場景 1 優先——編排器正在執行，顯示"下一步推薦"會造成誤導。此優先順序由 `formatGsdState()` 中的檢查順序強制執行，並由 `tests/enh-2833-phase-lifecycle-statusline.test.cjs` 中的 `"scene priority"` 測試套件覆蓋。

進度條（`[██░░░░░░░░] 20%`）僅在前置資料中存在 `progress.percent` 時才追加到里程碑段；缺失則不顯示進度條。

---

## 前置資料解析約束

狀態行鉤子使用基於正規表示式的解析（無完整 YAML 庫），因此以下約束適用。這些約束在 `tests/enh-2833-phase-lifecycle-statusline.test.cjs` 中經過測試。

1. **前置資料必須從檔案的第一個字元開始。** 任何內容——包括註釋——出現在開頭 `---` 之前都會使匹配失效。開頭的 `---` 行必須恰好如此，不能有尾隨空格。

2. **不支援巢狀塊內的註釋。** `progress:` 塊解析器要求下一行為 `[ \t]+\w+:`。在 `progress:` 和其第一個鍵之間插入 `# comment` 會破壞匹配，進度條將消失。任何說明文件應放在 `STATE.md` 正文中，而不是放在前置資料塊內。

3. **`next_phases` 首選格式為單行流式。** 解析器首先嚐試 `next_phases: ["4.5", "4.6"]`。塊序列（`- 4.5\n- 4.6`）也可解析，但對狀態行渲染的可靠性較低。優先使用單行流式格式的 `next_phases` 以保持基於正規表示式的解析器的可預測性。如果需要記錄大量候選階段以供文件說明，請將其儲存在 `STATE.md` 正文中。

如果未來的變更將正規表示式解析器替換為完整的 YAML 庫，則這些約束可以放寬，並相應更新測試。

---

## Markdown 正文章節

正文（結束 `---` 之後的所有內容）遵循 `get-shit-done/templates/state.md` 中的模板。標準章節為：

### 專案參考

指向 `.planning/PROJECT.md`。包含：
- **核心價值** — 來自 `PROJECT.md` 核心價值章節的一句話說明。
- **當前焦點** — 哪個階段處於活躍狀態。

### 當前位置

專案當前所處的狀態：

| 欄位 | 格式 |
|---|---|
| `Phase:` | `X of Y (Phase name)` |
| `Plan:` | `A of B in current phase` |
| `Status:` | 自由文本，如 `Ready to execute`、`Executing Phase 4`、`Phase complete — ready for verification` |
| `Last activity:` | 處理器寫入時為 ISO 日期（`YYYY-MM-DD`）；執行器編寫時為敘述性文本 |
| `Progress:` | 視覺化進度條，如 `[████░░░░░░] 40%` |

當現有值為已知模板預設值時，該章節中的 `Status:` 和 `Last activity:` 欄位由 GSD 處理器更新（Knuth 不變式：執行器編寫的值被保留）。已知處理器預設值的完整列表位於 `get-shit-done/bin/lib/state-document.cjs` 中的 `KNOWN_TEMPLATE_DEFAULTS`。

### 效能指標

執行速度跟蹤：
- 已完成計劃總數，每個計劃的平均耗時。
- 每階段明細表（`Phase | Plans | Total | Avg/Plan`）。
- 近期趨勢：改善中 / 穩定 / 下降中。

每次計劃完成後更新。

### 累積的上下文

**決策** — 影響當前工作的近期決策摘要（完整日誌在 `PROJECT.md` 中）。通過 `gsd-tools state add-decision` 新增。

**待處理的待辦事項** — 數量及對 `.planning/todos/pending/` 的引用。通過 `/gsd-capture` 捕獲。

**阻礙/關切** — 影響未來工作的問題，以發起階段為字首。通過 `gsd-tools state add-blocker` 新增；通過 `gsd-tools state resolve-blocker` 解決。

### 會話連續性

實現即時會話恢復：
- `Last session:` — 上次會話的 ISO-8601 時間戳。
- `Stopped at:` — 最後完成操作的描述。
- `Resume file:` — 指向 `.continue-here*.md` 檔案的路徑（若存在），否則為 `None`。

---

## 向後相容性

階段生命週期欄位（`active_phase`、`next_action`、`next_phases` 以及用於進度條的 `progress.percent`）是**按專案可選新增**的：

- 未填充任何生命週期欄位的 `STATE.md` 渲染結果與 v1.38.x 及更早版本**逐位元組完全相同**。
- 新增任何生命週期欄位是可選的——當欄位缺失時，渲染器會優雅降級。
- 即使 `progress` 塊存在，進度條也是可選的：只有 `progress.percent` 觸發進度條；單獨的 `total_phases` 和 `completed_phases` 不會觸發。

`tests/enh-2833-phase-lifecycle-statusline.test.cjs` 中的 `formatGsdState #2833 backward compatibility` 測試套件鎖定了此保證；任何破壞舊版 `STATE.md` 渲染的變更都將導致該套件失敗。

---

## 相關內容

- [規劃產物](planning-artifacts.md)
- [配置](../CONFIGURATION.md)
- [階段迴圈](../explanation/the-phase-loop.md)
- [文件索引](../README.md)
