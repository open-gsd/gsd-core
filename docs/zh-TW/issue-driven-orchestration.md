# 使用 GSD 進行議題驅動的編排

**狀態：** 穩定工作流指南
**受眾：** 在 GitHub Issues、Linear、Jira 或類似議題跟蹤系統中管理工作的開發者，希望通過 GSD 現有原語驅動 AI 輔助實現。

## 本指南的內容

本指南提供一套方案，將 GSD 已有的命令組合成一個"議題跟蹤 → 工作區 → 計劃/執行 → 驗證/稽核 → PR"的迴圈。這僅是文件說明。無新命令、無守護程序、無跟蹤系統整合 —— 下文引用的每一條命令在 GSD 中均已存在。

本方案的結構受到 OpenAI 開源 [Symphony 編排參考](https://openai.com/index/open-source-codex-orchestration-symphony/)（[程式碼庫](https://github.com/openai/symphony)）的啟發。GSD 不內嵌或封裝 Symphony。Symphony 中的編排*概念*可以清晰地對映到 GSD 已有的原語上；本指南只是將這種對映明確闡述出來，讓你無需編寫粘合程式碼或繞過 GSD 的安全門控即可採用該模式。

## 為何存在本指南

GSD 具備議題驅動 AI 開發的基礎構建塊 ——
`/gsd-workspace --new`、`/gsd-manager`、`/gsd-autonomous`、`/gsd-verify-work`、
`/gsd-review`、`/gsd-ship`，以及 `STATE.md` 和階段產物套件
—— 但缺少一份說明如何從單個跟蹤議題驅動它們、無需編寫自定義編排指令碼的指南。沒有這份指南，常見的失效模式是：

- 使用不足：開發者手動執行 discuss/plan/execute，即使工作模式完全適合，也從未使用
  `/gsd-manager` 或 `/gsd-autonomous`。
- 繞過指令碼：開發者在跟蹤系統與 `claude` 呼叫之間編寫臨時 shell 迴圈，繞過 `STATE.md`、階段清單和驗證門控。

本指南使規範迴圈變得易於發現。

## 概念對映

每行將 Symphony 風格的編排概念對映到 GSD 中對應的原語。在閱讀 Symphony 文件、部落格文章或第三方編排資料時，可將此表用作轉換參考。

| Symphony 概念 | GSD 原語 |
|---|---|
| `WORKFLOW.md`（頂層意圖） | `ROADMAP.md`（專案意圖）、`STATE.md`（即時狀態）、階段 `CONTEXT.md`（每階段範圍）、階段 `PLAN.md`（可執行步驟） |
| 每個任務一個獨立的代理工作區 | `/gsd-workspace --new --strategy worktree` |
| 代理排程與併發 | `/gsd-manager`（互動式儀表板）、`/gsd-autonomous`（無人值守） |
| 每階段的計劃與討論步驟 | `/gsd-discuss-phase` → `/gsd-plan-phase` → `/gsd-execute-phase` |
| 工作證明 / 測試證據 | `/gsd-verify-work`（UAT.md 在 `/clear` 後持久儲存） |
| 對抗性稽核 | `/gsd-review`（由獨立 AI CLI 對計劃進行交叉對等稽核） |
| 人工合併門控 | `/gsd-ship`（建立 PR，可選程式碼審查，準備合併） |
| 後續工作捕獲 | `/gsd-capture`、`/gsd-capture --seed`、`/gsd-new-milestone`，或手動開啟的跟蹤議題 |
| 併發控制 | Manager / 後臺代理語義（無持續輪詢器） |

對映是單向的：GSD 持有安全門控（驗證、人工稽核、後續工作建立的明確確認）。Symphony 的"持續編排"框架被有意地未採用 —— 參見[非目標](#非目標)。

## 端到端流程

規範的"議題 → PR"迴圈，設計為可從單個跟蹤議題端到端執行。執行前請替換括號中的佔位符。

1. **選擇跟蹤議題。** 從你的跟蹤系統（GitHub、Linear 等）中選擇一個範圍足夠明確可供自主實現的議題 —— 邊界清晰、驗收標準可觀察、沒有阻礙執行的上游依賴。
2. **對映到 GSD 階段。** 如果該議題對應 `ROADMAP.md` 中已有的階段，選擇它。若無，執行 `/gsd-new-milestone`（用於一批相關議題的新里程碑），或通過 `/gsd-phase` / `/gsd-phase --insert` 開啟一個階段。將跟蹤議題 URL 寫入該階段的 `CONTEXT.md`，確保可追溯性在壓縮後依然保留。
3. **建立獨立工作區。** 執行 `/gsd-workspace --new --strategy worktree <slug>`，以建立一個帶有獨立 `.planning/` 目錄的 git 工作樹。工作樹是安全邊界：任何探索、部分提交或中止的計劃都保留在 `main` 之外。
4. **通過 GSD 執行 discuss → plan → execute。** 在工作區內部執行 `/gsd-discuss-phase` 澄清歧義，執行 `/gsd-plan-phase` 生成 `PLAN.md`，再通過 `/gsd-manager`（互動式儀表板）或 `/gsd-execute-phase` / `/gsd-autonomous`（無人值守）來實現。避免從 GSD 外部直接驅動原始 `claude` 呼叫 —— 這會繞過 `STATE.md` 更新和階段清單。
5. **要求工作證明。** 執行 `/gsd-verify-work`，引導使用者根據階段的驗收標準進行 UAT。測試、截圖、日誌捕獲和配置差異均記錄在 `UAT.md` 中，該檔案在 `/clear` 後持久儲存，並在驗證發現遺漏範圍時通過 `/gsd-plan-phase --gaps` 補充缺口。
6. **通過稽核和釋出門控。** 執行 `/gsd-review`，從獨立 AI CLI 獲取對計劃的對抗性對等稽核（逐模型發現盲點），然後執行 `/gsd-ship`，從規劃產物中組裝豐富的 PR 正文並開啟 PR。兩個門控都需要人工決策，之後才能推送到遠端。
7. **明確捕獲後續工作。** 使用 `/gsd-capture` 記錄內聯備註，使用 `/gsd-capture --seed` 記錄值得未來階段處理的想法，或使用 `/gsd-new-milestone` 記錄一組有關聯的後續工作。從發現的後續工作建立跟蹤議題需要明確的使用者確認 —— GSD 不會自動向遠端跟蹤系統釋出內容。

PR 合併後，迴圈關閉。PR 正文中的自動關閉關鍵詞（`Closes #NNN` / `Fixes #NNN`）會在合併時關閉跟蹤議題。

## 安全邊界

該迴圈之所以安全，是因為四項不變數在構建上得到保證：

- **獨立工作樹。** 每個議題在 `/gsd-workspace --new` 工作樹中執行，因此部分工作、中止的計劃和探索性提交永遠不會觸及 `main`。`gsd-local-patches/` 是恢復入口，當工作樹的手動編輯需要跨更新帶回時可使用。
- **明確的人工稽核。** `/gsd-review` 和 `/gsd-ship` 均會停下來等待人工批准。沒有自動合併，也沒有從執行路徑自動建立 PR 的路徑。如果你想為特定程式碼庫移除人工門控，那是你的分支保護 / 合併佇列策略決定，而非 GSD 代為選擇的。
- **不自動公開發布。** GSD 從不在沒有明確使用者發起命令的情況下開啟、評論或關閉跟蹤議題。後續工作捕獲預設寫入本地產物（備註、種子、里程碑）；推回跟蹤系統是單獨的手動步驟。
- **釋出前先驗證。** `/gsd-verify-work` 的 UAT.md 必須記錄證據，才能執行 `/gsd-ship`。推薦的規範是將 `verification_failed` 視為阻塞項，即使實現看起來正確 —— 失敗通常意味著遺漏了驗收標準，而非測試不穩定。

如果這些不變數中的任何一項被繞過（例如直接對工作樹執行 `claude`、跳過 `/gsd-verify-work`，或在沒有使用者確認的情況下通過跟蹤 API 指令碼化建立議題），本指南的保證將不再適用。

## 非目標

本指南刻意**不**提出以下任何內容。在此列出，以防止未來貢獻者在程式碼審查中重新討論：

- **不內嵌或複製 Symphony 程式碼。** GSD 複用自身原語。上述對映是概念性的；本程式碼庫中不包含任何 Symphony 衍生原始碼。
- **無長期執行的守護程序。** GSD 不輪詢 GitHub 或 Linear。Manager 和自主工作流通過後臺代理語義處理併發，而非通過守護程序。
- **無強制跟蹤系統依賴。** 該迴圈無需任何跟蹤系統整合即可執行。"跟蹤議題"步驟是一種*人工輸入* —— URL 寫入 `CONTEXT.md`。GSD 不關心你使用哪個跟蹤系統，或者你是否使用跟蹤系統。
- **不繞過驗證、稽核或人工決策門控。** 即使在執行 `/gsd-autonomous` 時，驗證和稽核門控依然觸發。"autonomous（自主）"標籤指的是階段間的推進，而非跳過人工批准。
- **不擴充套件預設技能 / 命令面。** 本指南引用的每一條命令均已存在。本指南是文件面，而非功能面。

## 可能的未來後續

如果維護者在使用該迴圈的過程中積累了足夠的經驗，一個獨立的 approved-enhancement 可在未來新增*最小化*的跟蹤橋接：

- 將一個 GitHub 或 Linear 議題匯入 GSD 工作區 / 階段。
- 將 `UAT.md` 證據作為評論匯出到源議題。
- 從 `/gsd-capture --seed` 輸出生成後續跟蹤議題。

上述每一項都將是獨立的增強提案，因為每項都增加了整合面和持續維護負擔。它們超出了本指南的範圍。

## 相關資源

- [階段迴圈](explanation/the-phase-loop.md) — 說明 discuss → plan → execute → verify → ship 如何作為重複迴圈組合在一起。
- [工作區操作指南](how-to/work-in-parallel-with-workstreams.md) — 建立和管理並行工作樹的逐步指南。
- [文件索引](README.md) — GSD Core 文件的完整目錄。
- [docs/USER-GUIDE.md](./USER-GUIDE.md) — 上述各命令以任務為導向的操作指南。
- [docs/COMMANDS.md](COMMANDS.md) — `/gsd-*` 命令的完整參考。
- [docs/FEATURES.md](FEATURES.md) — 功能級能力矩陣（工作區、manager、autonomous、verify、review、ship）。
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 階段產物生命週期與 `STATE.md` 機制。
