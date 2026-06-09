# 如何為階段設計 UI

**目標：** 生成一份已鎖定的 UI 設計契約（`UI-SPEC.md`），在規劃者編寫任務之前，確定間距、顏色、字型和文案的決策，從而防止執行階段因隨意選擇樣式導致視覺不一致。

**前置條件：** `.planning/ROADMAP.md` 已存在，且該階段包含前端或 UI 工作。強烈建議先執行 `/gsd-discuss-phase N`——UI 研究員會讀取 `CONTEXT.md`，以避免重複詢問您已經做出的決策。

---

## 判斷此階段是否需要 UI 契約

並非所有階段都需要 `/gsd-ui-phase`。在以下情況下使用它：

- 該階段引入新的 UI 介面（頁面、流程、佈局）
- 將構建多個元件，且視覺一致性至關重要
- 您正在為新專案的前端建立設計系統基線
- 您正在為現有專案新增大量 UI 工作，希望在執行前鎖定 token、間距和顏色

在以下情況下跳過它：

- 該階段純粹是後端、基礎設施或資料工作，沒有面向用戶的輸出
- 早期階段已存在 UI-SPEC.md，且此階段在完全相同的視覺模式上構建，不引入新介面

如果不確定，安全門會提示您：當 `workflow.ui_safety_gate` 啟用時（預設啟用），`/gsd-plan-phase` 在檢測到前端工作但沒有 UI-SPEC.md 時會發出警告，並詢問是否先執行 `/gsd-ui-phase`。

---

## 執行 UI 設計契約

```bash
/gsd-ui-phase 2
```

如果未指定階段編號，GSD Core 會以當前階段為目標。

該命令分兩個階段執行：

1. **`gsd-ui-researcher`** — 讀取 `CONTEXT.md`、`RESEARCH.md` 和 `REQUIREMENTS.md` 中的已有決策，檢測設計系統狀態（shadcn `components.json`、Tailwind 配置、現有 token），並僅針對以下五個領域中尚未回答的設計問題進行提問：間距、顏色、字型、文案和登錄檔安全。
2. **`gsd-ui-checker`** — 從六個維度驗證生成的 `UI-SPEC.md`。如果發現問題，修訂迴圈會重新執行研究員（最多兩次迭代），專門針對被標記的專案。

**輸出：** `.planning/phases/{phase-dir}/` 中的 `{padded_phase}-UI-SPEC.md`。

---

## UI-SPEC 涵蓋的內容

研究員在五個領域鎖定決策：

| 領域 | 示例 |
|---|---|
| **間距** | 基礎比例（4px 或 8px）、網格對齊、元件內邊距 |
| **顏色** | 主色、強調色、中性色調色盤；60/30/10 規則；深色模式考量 |
| **字型** | 字型家族、字號/字重比例約束、標題層次結構 |
| **文案** | CTA 標籤、空狀態訊息、錯誤狀態文案、載入指示器 |
| **登錄檔安全** | shadcn 元件檢查協議（見下文） |

檢查器按六個支柱驗證規格，每項評分 1–4：文案、視覺、顏色、字型、間距和體驗設計（載入/錯誤/空狀態覆蓋）。

---

## shadcn 初始化

對於 React、Next.js 和 Vite 專案，若未找到 `components.json`，研究員會提議初始化 shadcn。流程如下：

1. 訪問 `ui.shadcn.com/create`，配置您的預設（顏色、邊框圓角、字型）
2. 複製預設字串
3. 執行：

```bash
npx shadcn init --preset <paste>
```

預設字串成為 GSD Core 規劃產物中的一等公民，可在各階段和里程碑間復現。

---

## 登錄檔安全門

第三方 shadcn 登錄檔可能注入任意程式碼。當 `workflow.ui_safety_gate` 啟用時（預設啟用），規格要求在安裝任何非官方元件之前執行以下步驟：

```bash
npx shadcn view <component>   # inspect source before installing
npx shadcn diff <component>   # compare against the official registry
```

如果未處理登錄檔安全問題，檢查器會將規格標記為 BLOCKED。若您的專案不使用 shadcn，或您有其他審查流程，可通過 `/gsd-settings` 停用此門控。

---

## 使用草圖發現結果作為起點

如果您已執行 `/gsd-sketch --wrap-up`，UI 研究員會自動載入 `.claude/skills/sketch-findings-[project]/`。經過預驗證的決策（佈局、調色盤、字型、間距）將被視為已鎖定——研究員不會重新詢問它們。執行開始時會顯示一條提示：

```text
⚡ Sketch findings detected: .claude/skills/sketch-findings-[project]/SKILL.md
   Pre-validated decisions (layout, palette, typography, spacing) should be treated
   as locked — not re-asked.
```

這是在 `/gsd-ui-phase` 之前執行 `/gsd-sketch --wrap-up` 的主要原因：它將對話式的設計探索轉化為具有約束力的契約輸入。

---

## 使用 `/gsd-ui-review` 進行事後視覺審計

`/gsd-ui-review` 在執行之後執行，而非之前。用它來對照 UI-SPEC 審計已實現的前端（當沒有規格時，則對照抽象的六支柱標準進行審計）。

```bash
/gsd-ui-review        # audit the current phase
/gsd-ui-review 3      # audit phase 3 specifically
```

它適用於任何包含前端程式碼的專案——不需要 GSD 專案初始化。

**檢查內容（六支柱，每項評分 1–4）：**

1. 文案 — CTA 標籤、空狀態、錯誤狀態
2. 視覺 — 焦點、視覺層次、圖示無障礙性
3. 顏色 — 強調色使用規範、60/30/10 合規性
4. 字型 — 字號和字重約束遵循情況
5. 間距 — 網格對齊、token 一致性
6. 體驗設計 — 載入、錯誤和空狀態覆蓋

**輸出：** `{padded_phase}-UI-REVIEW.md`，包含評分和前三項優先修復事項。當配置了 `gsd-browser` 等瀏覽器 MCP 伺服器時，審計還會捕獲截圖作為視覺證據。

**截圖儲存：** 截圖儲存至 `.planning/ui-reviews/`。系統會自動建立 `.gitignore` 以防止二進位制檔案提交到 git。截圖會在 `/gsd-complete-milestone` 期間清理。

---

## 在階段生命週期中的推薦位置

```text
/gsd-discuss-phase N      ← lock implementation preferences
/gsd-ui-phase N           ← lock design contract (frontend phases)
/gsd-plan-phase N         ← research + plan (reads UI-SPEC.md as context)
/gsd-execute-phase N      ← parallel execution
/gsd-verify-work N        ← manual UAT
/gsd-ui-review N          ← retroactive visual audit (optional but recommended)
```

`/gsd-ui-phase` 位於 discuss 和 plan 之間，因為規劃者會將 `UI-SPEC.md` 作為設計上下文讀取——`PLAN.md` 中的任務會引用規格鎖定的間距 token、顏色變數和文案決策。

---

## 相關文件

- [Spike 與草圖](spike-and-sketch.md)
- [規劃階段](plan-a-phase.md)
- [命令參考](../COMMANDS.md)
- [文件索引](../README.md)
