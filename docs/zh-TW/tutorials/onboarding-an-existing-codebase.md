# 將現有程式碼庫納入工作流

在本教程中，您將把 GSD Core 引入一個已有程式碼的倉庫。您將對程式碼庫進行對映，建立一個描述您所*新增*內容的專案，並針對一個小型聚焦變更執行首次討論與規劃迴圈。完成後，GSD Core 的規劃流水線將瞭解您的技術棧、規範和關注點——並在每次規劃時運用這些知識。

---

## 您將構建的內容

我們將向一個現有的 Express 應用程式新增一個 `GET /health` 端點。該變更足夠小，不會分散您對真正核心內容的注意力：GSD Core 在規劃任何內容之前如何學習您的程式碼庫。

---

## 前提條件

- **Node.js 18 或更高版本** — `node --version` 應輸出 `v18.x.x` 或更高版本。
- **一個現有專案** — 任何已有程式碼的倉庫。不必須是 Express；這些步驟適用於任何技術棧。
- **Claude Code** — 在您的倉庫根目錄中開啟。

---

## 第 1 步 — 安裝 GSD Core

在您的倉庫根目錄執行：

```bash
npx @opengsd/gsd-core@latest
```

在提示時選擇 **Claude Code** 和 **local**。您將看到：

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

---

## 第 2 步 — 使用許可權啟動 Claude Code

```bash
claude --dangerously-skip-permissions
```

---

## 第 3 步 — 對映程式碼庫

在建立專案之前，先讓 GSD Core 瞭解已有的內容。這是使棕地規劃準確的關鍵步驟。

```text
/gsd-map-codebase
```

GSD Core 會派生四個並行對映子代理（您將看到"Spawning 4 parallel codebase mapper agents…"——這需要 1–5 分鐘；請勿中斷）。每個代理專注於不同的關注點：

| 代理 | 關注點 |
|-------|-------|
| 技術對映器 | 技術棧、框架、依賴項 |
| 架構對映器 | 模式、層次、資料流 |
| 品質對映器 | 規範、測試實踐 |
| 關注點對映器 | 技術債務、風險領域 |

當所有四個代理返回後，您將看到：

```text
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md        (47 lines) - Technologies and dependencies
- ARCHITECTURE.md (62 lines) - System design and patterns
- STRUCTURE.md    (38 lines) - Directory layout and organisation
- CONVENTIONS.md  (55 lines) - Code style and patterns
- TESTING.md      (41 lines) - Test structure and practices
- INTEGRATIONS.md (29 lines) - External services and APIs
- CONCERNS.md     (33 lines) - Technical debt and issues
```

開啟 `.planning/codebase/STACK.md`。您將看到 GSD Core 檢測到的語言、執行時、框架版本和關鍵依賴項——這些內容基於實際讀取的檔案，而非猜測。

開啟 `.planning/codebase/CONVENTIONS.md`。您將看到它從您的原始碼中觀察到的命名規範、錯誤處理模式和程式碼風格規則。GSD Core 為該倉庫生成的每個計劃都將自動遵循這些規範。

開啟 `.planning/codebase/CONCERNS.md`。在進行任何新功能開發之前，這是最值得閱讀的檔案——它會展現可能影響您計劃的技術債務和脆弱區域。

---

## 第 4 步 — 清除上下文並建立專案

清除會話視窗：

```text
/clear
```

現在建立專案。由於 GSD Core 在上一步中發現了現有程式碼，它已經知道這是一個棕地專案。當您執行 `/gsd-new-project` 時，問題將聚焦於您所*新增*的內容，而非重新描述已有的內容：

```text
/gsd-new-project
```

GSD Core 會詢問您想構建什麼。請用您正在新增的功能來回答，而不是描述整個程式碼庫：

```text
Add a GET /health endpoint to the Express app. It should return
{ "status": "ok", "uptime": <seconds> }. We'll use it for load-balancer
health checks.
```

GSD Core 會進一步提出少量澄清問題，然後繼續建立需求和路線圖。由於它已讀取 `ARCHITECTURE.md` 和 `STACK.md`，它會自動將現有能力對映到 `PROJECT.md` 的 **Validated** 部分——您無需描述現有的 API 介面。

對所有工作流設定選擇推薦預設值。

當路線圖子代理返回後，您將看到一個建議的路線圖。對於單個小型變更，它將只有一個階段：

```text
Proposed Roadmap

1 phase | 2 requirements mapped | All v1 requirements covered ✓

| # | Phase          | Goal                                          | Requirements |
|---|----------------|-----------------------------------------------|--------------|
| 1 | Health endpoint| GET /health returning status and uptime JSON  | HLT-01, HLT-02 |
```

批准路線圖。

**在 `.planning/` 中建立的內容：**

```text
.planning/
  PROJECT.md          ← project description; existing capabilities in "Validated"
  REQUIREMENTS.md     ← HLT-01, HLT-02
  ROADMAP.md          ← Phase 1, status: pending
  STATE.md            ← session memory
  config.json         ← workflow settings
  codebase/           ← the seven map files from Step 3
```

注意 `.planning/codebase/` 已經從第 3 步存在。GSD Core 在編寫 `PROJECT.md` 時讀取了這些檔案，這就是為什麼它無需您描述即可填充已驗證的需求。

---

## 第 5 步 — 清除上下文並討論第 1 階段

```text
/clear
```

```text
/gsd-discuss-phase 1
```

由於 GSD Core 已讀取您的 `CONVENTIONS.md` 和 `ARCHITECTURE.md`，其問題基於您的實際程式碼庫——而非通用建議。您可能會看到：

```text
> Your routes are registered in src/routes/index.js. Should the health
  endpoint live there, or in a dedicated src/routes/health.js?
  A dedicated health.js — keep routes separated.

> Your existing error middleware returns { error: "message" }. Should
  /health use the same shape for error responses?
  Yes, stay consistent.

> Should uptime be calculated from process.uptime() or a stored start time?
  process.uptime() is fine.
```

討論結束後，GSD Core 將寫入：

```text
.planning/phases/01-health-endpoint/CONTEXT.md
```

開啟該檔案。`## Implementation Decisions` 部分記錄了您的回答。規劃器將在編寫任何任務之前讀取此檔案——因此您關於檔案位置和響應格式的偏好將出現在計劃中，而不僅僅停留在討論裡。

---

## 第 6 步 — 規劃第 1 階段

```text
/gsd-plan-phase 1
```

四個研究子代理並行執行（1–5 分鐘）。當它們返回後，規劃器讀取 `CONTEXT.md`、研究結果和您的程式碼庫對映，建立符合您規範的任務計劃。

**建立的內容：**

```text
.planning/phases/01-health-endpoint/
  RESEARCH.md         ← findings on health endpoint patterns
  01-01-PLAN.md       ← Task: create src/routes/health.js
  01-02-PLAN.md       ← Task: register health route in src/routes/index.js
```

開啟 `01-01-PLAN.md`。注意 `<files>` 標籤引用了 `src/routes/health.js`——正是您在討論中指定的路徑，與 GSD Core 在程式碼庫對映中觀察到的路由模式一致。這正是程式碼庫對映發揮作用的體現。

---

## 下一步

您現在擁有一個帶有程式碼庫對映、討論決策記錄和經過驗證的任務計劃的專案——所有內容均基於您的實際程式碼。從這裡開始，工作流與綠地專案完全相同：

```text
/gsd-execute-phase 1
/gsd-verify-work 1
/gsd-ship 1
```

對於每個未來的功能，當結構發生重大變化時，再次執行 `/gsd-map-codebase`，以保持程式碼庫對映的時效性。

---

## 您學到了什麼

- `/gsd-map-codebase` 如何執行四個並行代理，在 `.planning/codebase/` 中生成 `STACK.md`、`ARCHITECTURE.md`、`CONVENTIONS.md`、`CONCERNS.md`、`STRUCTURE.md`、`TESTING.md` 和 `INTEGRATIONS.md`。
- 在棕地倉庫中執行 `/gsd-new-project` 如何將問題聚焦於您所*新增*的內容，並從現有程式碼中填充已驗證的需求。
- 程式碼庫對映如何塑造 `/gsd-discuss-phase` 中的每個問題——檔案路徑、模式和規範均來自您的實際程式碼。
- 規劃器如何讀取 `CONTEXT.md` 和 `CONVENTIONS.md` 來生成符合您倉庫風格的計劃。

---

## 相關內容

- [您的第一個專案](your-first-project.md) — 從安裝到 PR 的完整綠地迴圈
- [通過命令使用對映程式碼庫](../COMMANDS.md) — 所有 `/gsd-map-codebase` 標誌和子命令
- [文件索引](../README.md)
