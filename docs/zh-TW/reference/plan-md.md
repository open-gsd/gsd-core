# PLAN.md 模式參考

每個計劃的 `PLAN.md` 是 GSD Core 的可執行工作單元——一份結構化文件，精確告知執行器代理需要構建什麼以及如何驗證構建是否正確完成。本頁記錄其結構。參見[文件索引](../README.md)。

---

## 概述

計劃存放在以下位置的階段目錄中：

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-PLAN.md
```

例如：`.planning/phases/03-post-feed/03-02-PLAN.md`（第 3 階段，第 2 計劃）。

計劃由 `gsd-planner` 代理生成（由 `/gsd:plan-phase` 觸發），並由 `execute-phase` 消費。一個階段通常包含一到四個計劃；同一階段內的計劃被分配到執行波次，以便獨立工作並行執行。

---

## YAML 前置後設資料

每個 PLAN.md 以位於 `---` 分隔符之間的 YAML 前置後設資料塊開頭。

### 註釋示例

```yaml
---
phase: 03-post-feed
plan: 02
type: execute
wave: 2
depends_on: ["03-01"]
files_modified:
  - src/components/PostFeed.tsx
  - src/components/PostCard.tsx
  - src/app/feed/page.tsx
autonomous: true
requirements: ["FEED-01", "FEED-03"]
user_setup: []

must_haves:
  truths:
    - "User can scroll through posts from followed accounts"
    - "Each post shows author avatar, name, timestamp, and content"
    - "Empty state appears when no posts exist"
  artifacts:
    - path: "src/components/PostFeed.tsx"
      provides: "Scrollable post list"
      min_lines: 40
    - path: "src/components/PostCard.tsx"
      provides: "Individual post card"
      exports: ["PostCard"]
  key_links:
    - from: "src/components/PostFeed.tsx"
      to: "/api/feed"
      via: "fetch in useEffect"
      pattern: "fetch.*api/feed"
---
```

### 前置後設資料欄位參考

| 欄位 | 是否必填 | 型別 | 用途 |
|---|---|---|---|
| `phase` | 是 | string | 階段識別符號，例如 `03-post-feed`。 |
| `plan` | 是 | string | 階段內的計劃編號，例如 `02`。 |
| `type` | 是 | `execute` 或 `tdd` | 標準計劃使用 `execute`；測試驅動計劃使用 `tdd`，測試在實現之前編寫。 |
| `wave` | 是 | integer | 執行波次。波次 1 中的計劃並行執行（無依賴關係）。波次 2 及以上的計劃等待上一波次的所有計劃完成後才開始。由 `gsd-planner` 在規劃時預先計算。 |
| `depends_on` | 是 | array of plan IDs | 該計劃必須等待的前置計劃。空陣列表示波次 1。示例：`["03-01"]` 表示該計劃在第 3 階段計劃 01 完成後執行。 |
| `files_modified` | 是 | array of paths | 該計劃建立或修改的所有檔案。被計劃檢查器用於檢測同波次檔案衝突，也被 execute-phase 用於合併跟蹤。 |
| `autonomous` | 是 | boolean | 當所有任務型別均為 `auto` 時為 `true`。當計劃包含任何需要人工互動的 `checkpoint:*` 任務時為 `false`。 |
| `requirements` | 是 | array of IDs | 該計劃所對應的 ROADMAP.md 中的需求 ID。每個階段需求 ID 必須出現在至少一個計劃的 `requirements` 欄位中。空陣列是阻斷項（BLOCKER）。 |
| `user_setup` | 否 | array of objects | Claude 無法自動化的外部服務設定步驟（賬戶建立、金鑰獲取、控制台配置）。存在時，execute-phase 會為開發者生成 `USER-SETUP.md` 檢查清單。 |
| `must_haves` | 是 | object | 以目標為導向的驗證標準。詳見下文。 |

---

## `must_haves` 欄位

`must_haves` 描述了階段目標達成後必須可觀測到的真實狀態。該欄位在規劃階段派生，並在執行後由 `gsd-verifier` 代理驗證。

### 子欄位

| 子欄位 | 型別 | 用途 |
|---|---|---|
| `truths` | array of strings | 從使用者視角可觀測到的行為。每項必須可驗證。示例：`"User can send a message"`，而非 `"WebSocket library installed"`。 |
| `artifacts` | array of objects | 必須存在且具有實質性實現（非樁程式碼）的檔案。 |
| `artifacts[].path` | string | 相對於專案根目錄的檔案路徑。 |
| `artifacts[].provides` | string | 該檔案所提供的能力。 |
| `artifacts[].min_lines` | integer（可選） | 被視為非樁程式碼的最小行數。 |
| `artifacts[].exports` | array of strings（可選） | 需要驗證的預期命名匯出項。 |
| `artifacts[].contains` | string（可選） | 必須出現在檔案中的正規表示式或字面量模式。 |
| `key_links` | array of objects | 製品之間的關鍵連線——使系統端到端執行的接線。 |
| `key_links[].from` | string | 原始檔或元件。 |
| `key_links[].to` | string | 目標檔案、端點或模組。 |
| `key_links[].via` | string | 連線方式描述（例如 `fetch in useEffect`、`Prisma query`、`import`）。 |
| `key_links[].pattern` | string（可選） | 用於驗證原始碼中連線是否存在的正規表示式。 |

---

## 正文結構

前置後設資料之後，計劃正文使用執行器代理讀取的具名 XML 風格塊。

### `<objective>`

說明計劃所交付的內容及其對專案的重要性：

```xml
<objective>
Implement the post feed as a scrollable card list.

Purpose: Core display feature for the social feed phase.
Output: PostFeed and PostCard components wired to /api/feed.
</objective>
```

### `<execution_context>`

列出執行器在開始前讀取的工作流檔案。始終包含 execute-plan 工作流；當計劃包含檢查點任務時，額外新增檢查點參考：

```xml
<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>
```

### `<context>`

引用執行器需要讀取的原始檔。包括專案級規劃文件以及計劃必須複用其模式或型別的原始檔。僅當後續計劃對其型別或決策存在真實依賴時，才引用前序計劃的 `SUMMARY.md` 檔案——而非無條件引用：

```xml
<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@src/components/UserCard.tsx
</context>
```

### `<tasks>`

包含一個或多個 `<task>` 元素。對於 `type="auto"` 的任務，每個任務元素必須包含 `<name>`、`<files>`、`<read_first>`、`<action>`、`<verify>`、`<acceptance_criteria>` 和 `<done>`。

---

## 任務型別

| 型別 | 使用場景 | 自主程度 |
|---|---|---|
| `auto` | 執行器可獨立完成的所有內容。 | 完全自主。 |
| `checkpoint:human-verify` | 需要人工檢視執行中的介面或服務進行視覺或功能驗證。 | 暫停執行；呈現給開發者；批准後恢復。 |
| `checkpoint:decision` | 執行過程中出現的需要開發者輸入的實現選擇。 | 暫停執行；呈現選項；選擇後恢復。 |
| `checkpoint:human-action` | 真正不可避免的手動步驟（賬戶建立、硬體互動）。謹慎使用。 | 暫停執行；確認後恢復。 |

包含任何檢查點任務的計劃必須在前置後設資料中設定 `autonomous: false`。

---

## `auto` 任務結構

```xml
<task type="auto">
  <name>Task 1: Create PostCard component</name>
  <files>src/components/PostCard.tsx</files>
  <read_first>src/components/UserCard.tsx, src/types/post.ts</read_first>
  <action>Create PostCard component accepting a Post prop (id, authorId, content, createdAt,
    reactionCount). Render author avatar using UserAvatar from UserCard pattern. Show timestamp
    using date-fns formatDistanceToNow. Export as named export PostCard.</action>
  <verify>npx tsc --noEmit</verify>
  <acceptance_criteria>
    - src/components/PostCard.tsx exports named export PostCard
    - PostCard.tsx contains "reactionCount" prop usage
    - npx tsc --noEmit exits 0
  </acceptance_criteria>
  <done>PostCard renders post content with author and timestamp</done>
</task>
```

### `auto` 任務必填欄位

| 欄位 | 規則 |
|---|---|
| `<files>` | 任務建立或修改的所有檔案。執行器只寫入這些檔案。 |
| `<read_first>` | 執行器在修改任何內容之前必須讀取的檔案——包括待修改檔案、任何真實來源的模式檔案以及必須複用其型別或約定的檔案。 |
| `<action>` | 包含精確識別符號、檔案路徑、函式簽名和預期值的具體指令。不能在未指定目標狀態的情況下說"將 X 與 Y 對齊"。不包含程式碼圍欄塊或完整實現。 |
| `<verify>` | 可執行的命令或檢查，用於證明任務已成功完成。必須能區分通過與失敗——`echo "done"` 無效。 |
| `<acceptance_criteria>` | 可驗證的條件：可通過 grep 驗證的字串、命令退出碼、可觀測行為。不含主觀性語言（"看起來正確"、"配置正確"）。 |
| `<done>` | 已完成結果的簡短可量化陳述。 |

---

## 計劃品質維度

`gsd-plan-checker` 代理在執行開始前對每個 PLAN.md 進行 12 個維度的審查。任何未通過 BLOCKER 級別檢查的計劃將被退回給 `gsd-planner` 修訂（最多 3 次迭代）：

| 維度 | 檢查內容 |
|---|---|
| **1 — 需求覆蓋率** | ROADMAP.md 中每個階段需求 ID 出現在至少一個計劃的 `requirements` 前置後設資料欄位中，並有相應的覆蓋任務。 |
| **2 — 任務完整性** | 每個 `auto` 任務攜帶所有必填欄位（`<files>`、`<action>`、`<verify>`、`<acceptance_criteria>`、`<done>`）。無模糊或空欄位。 |
| **3 — 依賴正確性** | `depends_on` 引用有效、無迴圈，並與波次編號一致。第 N 波次計劃僅依賴波次 < N 的計劃。 |
| **4 — 關鍵連結規劃** | `must_haves.key_links` 中的製品有對應的實現接線任務——而非僅創建制品。 |
| **5 — 範圍合理性** | 計劃保持在上下文預算內：每個計劃 2–3 個任務（4 個 = 警告，5 個及以上 = BLOCKER），每個計劃 ≤ 8–10 個檔案（15 個及以上 = BLOCKER）。 |
| **6 — 驗證推導** | `must_haves.truths` 是使用者可觀測行為，而非實現細節。製品對映到真實狀態。關鍵連結覆蓋關鍵接線。 |
| **7 — 上下文合規性** | CONTEXT.md 中每個 `D-NN` 決策至少由一個任務處理。沒有任務實現 `<deferred>` 中的內容。 |
| **7b — 範圍縮減檢測** | 任務操作不會在未交付完整決策範圍的情況下，悄悄將已鎖定決策降級為"v1"、"樁程式碼"或"未來增強"。發現時始終為 BLOCKER。 |
| **7c — 架構層級合規性** | 任務按照 RESEARCH.md 架構責任對映（如存在）將能力分配到正確層級。安全敏感能力分配到錯誤層級時為 BLOCKER。 |
| **8 — 奈奎斯特合規性** | 當 `workflow.nyquist_validation` 已啟用且 RESEARCH.md 存在時，每個任務有 `<automated>` 驗證命令，連續 3 個任務的視窗內不缺少覆蓋，且 VALIDATION.md 存在。 |
| **9 — 跨計劃資料契約** | 當計劃共享資料管道時，其轉換相互相容——沒有計劃刪除另一個計劃需要原始形式的資料。 |
| **10 — CLAUDE.md 合規性** | 計劃遵守 `./CLAUDE.md` 中的專案特定約定、禁止模式、必需工具和安全要求。 |
| **11 — 研究解決** | 當 RESEARCH.md 存在時，其 `## Open Questions` 部分在規劃繼續之前標記為 `(RESOLVED)`。 |
| **12 — 模式合規性** | 當 PATTERNS.md 存在時，任務為每個新建或修改的檔案引用正確的類比模式。 |

---

## 波次執行模型

波次編號在規劃階段預先計算。Execute-phase 按波次編號對計劃進行分組，並行執行每個波次的計劃：

```
Wave 1: Plan 01, Plan 02, Plan 03  (all run simultaneously — no dependencies)
Wave 2: Plan 04                    (waits for Wave 1 to complete)
Wave 3: Plan 05                    (waits for Wave 2 to complete)
```

同一波次中修改重疊檔案的計劃不得處於同一波次——計劃檢查器的維度 3 會將此標記為 BLOCKER。

---

## 計劃輸出

計劃成功執行後，執行器在以下路徑寫入 SUMMARY.md：

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-SUMMARY.md
```

SUMMARY.md 是所構建內容的權威記錄。同一階段內的後續計劃，僅當對其型別或決策存在真實依賴時，才可引用該檔案。

---

## 相關內容

- [CONTEXT.md 模式](context-md.md)
- [規劃製品](planning-artifacts.md)
- [功能特性](../FEATURES.md)
- [文件索引](../README.md)
