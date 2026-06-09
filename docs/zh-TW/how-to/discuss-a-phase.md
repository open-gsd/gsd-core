# 如何討論一個階段

**目標：** 在規劃開始之前收集某個階段所需的實施決策，以便研究員和規劃員無需再次詢問您。

**前提條件：** `.planning/ROADMAP.md` 檔案已存在。如果沒有，請先執行 `/gsd-new-project`。

---

## 選擇討論模式

GSD Core 提供兩種模式。根據對程式碼庫的熟悉程度進行選擇。

**如果您想預先表達自己的實施偏好**（訪談模式，預設）：

```bash
/gsd-discuss-phase 2
```

Claude 會識別階段範圍中的模糊地帶，讓您選擇要討論的內容，然後針對每個領域處理大約四個問題。

**如果程式碼庫已有明確的模式，且大多數問題對您來說顯而易見**（假設模式）：

```bash
node gsd-tools.cjs config-set workflow.discuss_mode assumptions
/gsd-discuss-phase 2
```

Claude 通過子代理讀取 5–15 個相關程式碼庫檔案，形成帶有證據和置信度級別的假設，並呈現給您確認或糾正。通常只需 2–4 次互動，而非 15–20 次。

切換回原模式：

```bash
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

請參閱[討論模式說明](../workflow-discuss-mode.md)以獲取完整對比，包括各模式可能節省時間的場景。

---

## 不經選擇步驟直接討論所有模糊地帶

預設情況下，Claude 會呈現模糊地帶並詢問您希望覆蓋哪些內容。如果您想跳過該選擇提示，直接處理所有內容：

```bash
/gsd-discuss-phase 2 --all
```

---

## 加快處理簡單明瞭的階段

**如果該階段已充分理解，您希望 Claude 無需提示即可選擇推薦的預設值：**

```bash
/gsd-discuss-phase 3 --auto
```

Claude 為每個問題選擇推薦答案並記錄選擇。適用於決策風險較低或已在先前階段中隱含的階段。

**如果您有遠端會話限制（無 TUI 選單）：**

```bash
/gsd-discuss-phase 2 --text
```

所有提示將以純文本編號列表的形式呈現，而不是互動式選擇器。

---

## 分組處理問題

如果您希望一次回答多個問題，而不是逐一回答：

```bash
/gsd-discuss-phase 2 --batch
```

Claude 每輪分組 2–5 個問題。

---

## 為每個問題新增權衡分析

如果您希望在做出決定之前檢視選項對比表：

```bash
/gsd-discuss-phase 2 --analyze
```

---

## 從準備好的檔案中批量回答

如果您已有準備好的答案檔案，並希望一次性提交所有決策：

```bash
/gsd-discuss-phase 1 --power
```

---

## 在討論之前檢視 Claude 的假設

**如果您希望在任何互動式會話之前瞭解 Claude 的假設和計劃** — 適用於在投入討論時間之前驗證對齊情況：

```bash
/gsd-discuss-phase 3 --assumptions
```

Claude 輸出其假設（附帶程式碼庫證據和置信度級別）後退出。不會寫入 CONTEXT.md。檢視輸出後，如有需要糾正的內容，再執行正常的討論或假設模式會話。

---

## CONTEXT.md 的內容

討論模式和假設模式都會在階段目錄中生成相同的 `{phase}-CONTEXT.md`。下游代理（研究員、規劃員、計劃檢查員）以相同方式讀取該檔案，無論由哪種模式生成。它包含六個部分：

| 部分 | 用途 |
|---|---|
| `<domain>` | 階段邊界 — 本階段交付的內容 |
| `<decisions>` | 會話中鎖定的實施決策 |
| `<canonical_refs>` | 下游代理必須閱讀的規格說明、ADR 和文件 |
| `<code_context>` | 可複用資產、模式和整合點 |
| `<specifics>` | 使用者參考資料和偏好 |
| `<deferred>` | 記錄留待未來階段處理的想法 |

`<canonical_refs>` 部分是必填項。如果您在討論中引用了某個文件、規格說明或 ADR，Claude 會立即將其新增並讀取，以便為後續問題提供參考。

請參閱 [CONTEXT.md 模式](../reference/context-md.md)以獲取完整的欄位參考。

---

## 決策如何影響規劃

當您接下來執行 `/gsd-plan-phase` 時，規劃員會讀取 CONTEXT.md 以瞭解哪些決策已鎖定。它不會重新詢問此處已回答的問題。研究員會首先讀取該檔案以瞭解需要調查的內容。

**如果執行 `/gsd-plan-phase` 時 CONTEXT.md 缺失**，系統將提供兩種選擇：不使用上下文繼續（計劃僅使用研究和需求，不包含您的設計偏好），或先執行 `/gsd-discuss-phase`。

---

## 如果您已有 PRD 或驗收標準文件

完全跳過 discuss-phase，直接進入規劃：

```bash
/gsd-plan-phase 1 --prd path/to/prd.md
```

規劃員會從 PRD 綜合生成 CONTEXT.md，並將所有需求視為鎖定決策。

---

## 相關內容

- [規劃一個階段](plan-a-phase.md)
- [討論模式](../workflow-discuss-mode.md)
- [CONTEXT.md 模式](../reference/context-md.md)
- [文件索引](../README.md)
