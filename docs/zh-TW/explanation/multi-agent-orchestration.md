# GSD Core 中的多智慧體編排

> **說明文件** — 本文件闡述 GSD Core *為何*圍繞多智慧體編排進行設計，以及*各元件如何協同工作*。這不是操作指南。有關配置，請參閱
> [配置模型配置檔案](../how-to/configure-model-profiles.md) 和
> [配置參考](../CONFIGURATION.md)。有關完整的智慧體清單，
> 請參閱 [清單](../INVENTORY.md)。

---

## 本設計解決的問題

AI 程式設計智慧體會逐漸退化。這並非因為模型變差，而是因為
*上下文視窗被填滿*。隨著對話的增長，早期的決策和程式碼
會被中間步驟的噪音擠出或稀釋。當智慧體在複雜任務中寫到第五個檔案時，
它可能已經忘記了第一條訊息中說明的約束條件。這種現象有時被稱為*上下文腐化*。

GSD Core 的多智慧體設計正是對這一問題的直接回應。與其讓一個
長期執行的智慧體承擔整個會話，不如讓一個輕量編排器派生出
短暫存在的專用智慧體，每個智慧體都擁有**全新的 200K token 上下文視窗**，
並且*只獲取完成其特定工作所需的工件*。編排器自身從不承擔繁重工作；
它載入上下文、派生合適的智慧體、收集結果，並在 `.planning/` 中更新共享狀態。

---

## 編排器 → 智慧體模式

`get-shit-done/workflows/` 中的每個工作流都遵循相同的結構：

```text
Orchestrator (workflow .md file)
    │
    ├── Load context
    │   gsd-tools.cjs init <workflow> <phase>
    │   → JSON: project info, config, state, phase details
    │
    ├── Resolve model
    │   gsd-tools.cjs resolve-model <agent-name>
    │   → opus | sonnet | haiku | inherit
    │
    ├── Spawn specialised agent (Task/SubAgent call)
    │   ├── Agent definition (agents/*.md)
    │   ├── Context payload (init JSON)
    │   ├── Model assignment
    │   └── Tool permissions
    │
    ├── Collect result
    │
    └── Update state
        gsd-tools.cjs state update / state patch / state advance-plan
```

編排器被刻意設計為輕量級。它不對領域進行推理，
不編寫程式碼，也不解讀結果——僅將結果路由到下一個步驟。
這種邊界使每一層的職責清晰，並防止編排器的上下文積累領域噪音。

### 智慧體清單

GSD Core 的智慧體按功能類別劃分，對應
研究 → 規劃 → 執行 → 驗證的流水線：

| 類別 | 智慧體 | 典型並行度 |
|---|---|---|
| 研究員 | `gsd-project-researcher`、`gsd-phase-researcher`、`gsd-ui-researcher`、`gsd-advisor-researcher` | 4 個並行（技術棧、功能、架構、潛在問題） |
| 綜合員 | `gsd-research-synthesizer` | 順序執行，在研究員完成後執行 |
| 規劃員 | `gsd-planner`、`gsd-roadmapper` | 順序執行 |
| 檢查員 | `gsd-plan-checker`、`gsd-integration-checker`、`gsd-ui-checker`、`gsd-nyquist-auditor` | 順序執行，最多 3 次修訂迭代 |
| 執行員 | `gsd-executor` | 波次內並行，波次間順序 |
| 驗證員 | `gsd-verifier` | 順序執行，在所有執行員完成後執行 |
| 對映員 | `gsd-codebase-mapper` | 4 個並行子探針 |
| 審計員 | `gsd-ui-auditor`、`gsd-security-auditor` | 順序執行 |

每個智慧體定義（位於 `agents/*.md`）聲明瞭其允許的工具訪問許可權、
用途以及終端輸出顏色。僅需讀取檔案並寫入單個輸出文件的智慧體
只獲得這些許可權——無 Bash 執行許可權，無法訪問更廣泛的狀態。
該約束是刻意為之的：如果智慧體行為異常，可將影響範圍控制在最小。

有關完整的 31 個智慧體清單，請參閱 [清單](../INVENTORY.md#agents-31-shipped)。

---

## 基於波次的並行執行

多智慧體設計最直觀的體現是 `/gsd-execute-phase`
如何處理一組可能相互依賴的計劃。

在派生任何執行員之前，編排器會執行**波次分析**：
讀取每個 `PLAN.md` 檔案中的依賴宣告，並將計劃分組成波次。
沒有宣告依賴的計劃構成第 1 波次並並行執行。
依賴第 1 波次的計劃構成第 2 波次，以此類推。

```text
Plan 01 (no deps)        ─┐
Plan 02 (no deps)        ─┤─── Wave 1  (parallel)
Plan 03 (depends: 01)    ─┤─── Wave 2  (waits for Wave 1)
Plan 04 (depends: 02)    ─┘
Plan 05 (depends: 03, 04) ─── Wave 3  (waits for Wave 2)
```

波次內的每個執行員：

- 接收一個全新的上下文視窗（200K token，或在支援的模型上最高 1M）
- 接收其負責的特定 `PLAN.md`
- 接收專案上下文（`PROJECT.md`、`STATE.md`）
- 接收階段上下文（`CONTEXT.md`、`RESEARCH.md`，如果可用）
- 完成時生成原子 git 提交
- 寫入描述構建內容的 `SUMMARY.md`

當一個波次內的所有執行員完成後，編排器對整個波次執行一次
pre-commit 鉤子。執行員使用 `--no-verify` 提交，以防止
多個智慧體並行提交時發生構建鎖定爭用（例如 Rust 專案中的 Cargo 鎖定衝突）。
因此，鉤子每個波次執行一次，而非每次提交執行一次。

### 並行提交安全性

兩種機制防止多個執行員同時執行時發生寫入衝突：

1. **`STATE.md` 的原子鎖** — 每次寫入 `STATE.md` 都使用
   帶有 `O_EXCL` 原子建立的鎖檔案（`STATE.md.lock`）。這防止了
   兩個智慧體各自讀取檔案、修改不同欄位、後寫入者覆蓋先寫入者
   更改的讀-改-寫競態條件。過期鎖（超過 10 秒）會被自動清除。

2. **每波次執行鉤子** — 每個執行員獨立執行 pre-commit 鉤子
   （這可能在共享構建工件上引發檔案級爭用），編排器在
   每個波次完成後執行一次 `git hook run pre-commit`。

---

## 針對大視窗模型的自適應上下文豐富

標準的 200K 上下文視窗足以讓執行員實現一個專注的計劃。
當配置的 `context_window` 達到 500K token 或更大時
（例如在 1M 級模式下使用 Opus 4.6 或 Sonnet 4.6），
編排器會自動使用標準視窗無法容納的額外上下文來豐富子智慧體提示：

- **執行員智慧體**接收前一波次的 `SUMMARY.md` 檔案和階段
  `CONTEXT.md`/`RESEARCH.md`，使其在階段內具備跨計劃感知能力
- **驗證員智慧體**接收所有 `PLAN.md`、`SUMMARY.md` 和 `CONTEXT.md`
  檔案以及 `REQUIREMENTS.md`，實現具有歷史感知能力的驗證

此豐富功能以 `config.json` 中的 `context_window` 值為條件。
在標準視窗配置下，提示使用截斷版本，並採用快取友好的排序
以最大化 token 效率。

---

## 為何採用此設計——與上下文工程的關聯

只有作為更廣泛的*上下文工程*方法的一部分，
編排器 → 智慧體模式才有意義：這一理念認為，
AI 智慧體上下文視窗中包含的內容與模型層級或提示品質同樣重要。
完整論述請參閱[上下文工程](context-engineering.md)。

多智慧體編排以兩種方式將上下文工程付諸實踐：

**上下文隔離。** 每個智慧體只接收它所需要的內容。研究員
獲取專案描述和領域問題；它不會獲取完整的規劃歷史。
驗證員獲取每個計劃和摘要；它不會獲取原始研究資料。
隔離使每個智慧體的上下文充滿訊號，而非被其他流水線階段的噪音稀釋。

**跨會話的上下文衛生。** 由於所有狀態都以人類可讀的 Markdown 和 JSON
儲存在 `.planning/` 中（而非任何智慧體的上下文視窗中），
GSD 工作流能夠在上下文重置（`/clear`）、標籤頁切換和
多日中斷後繼續執行。下一個智慧體始終從持久化的、經過驗證的
工件啟動，而非從漫長對話的重建記憶中啟動。

---

## 權衡

多智慧體編排並非沒有代價。

**協調開銷。** 每次智慧體派生都是一次往返：編排器
必須格式化提示、移交上下文、等待子智慧體完成
（通常需 1–5 分鐘），然後解析結果。對於簡單任務，
單個能力強大的智慧體在一個上下文中工作會更快完成。GSD 通過
將並行化作為預設方式來緩解這一問題（在依賴關係允許的情況下）——
`plan-phase` 中的四個研究員同時執行，而非順序執行。

**執行期間的不透明性。** 當子智慧體執行時，其工作對父會話不可見。
沒有即時進度流。這是全新上下文設計的刻意結果：
子智慧體在其自己的上下文視窗中執行。編排器在
派生行顯示活躍性提示（"runs in a subagent — no output until it returns"）
以設定預期。

**上下文拼接成本。** 為每個智慧體打包正確的工件
需要編排器花費 token 來組裝和傳輸上下文負載。
這是隔離的代價。`gsd-tools.cjs init` 處理器
生成一個在完整性與 token 預算之間取得平衡的 JSON 負載，
採用快取友好的排序，使負載中穩定的部分（專案定義、配置）
在重複呼叫時命中快取。

**模型成本放大。** 在 Opus 層級並行執行五個智慧體
比執行一個成本更高。模型配置檔案系統（`model_profiles.md`，
由 `model-profiles.cjs` 按智慧體解析）讓您可以為
不那麼關鍵的智慧體分配更低成本的層級。`dynamic_routing` 功能
通過以更低層級啟動每個智慧體並僅在軟失敗時升級來進一步降低成本。
完整選項請參閱[配置](../CONFIGURATION.md)。

為換取這些代價，該設計實現了*大型階段的一致品質*。
在 400 行計劃中編寫第十個檔案的執行員不會退化，
因為其上下文是全新的。檢查二十個需求的驗證員不會忘記前十個，
因為它以結構化輸入而非對話歷史的形式接收了所有需求。

---

## 相關資源

- [上下文工程](context-engineering.md) — 驅動本設計的上游原則
- [配置模型配置檔案](../how-to/configure-model-profiles.md) — 如何按智慧體分配模型層級
- [配置參考](../CONFIGURATION.md) — 完整的 `config.json` 架構，
  包括 `models`、`model_overrides`、`dynamic_routing` 和
  `context_window`
- [清單](../INVENTORY.md) — 權威的智慧體清單和工作流列表
- [架構](../ARCHITECTURE.md#agent-model) — 編排器 → 智慧體模式和
  波次執行模型的實現層面細節
- [文件索引](../README.md)
