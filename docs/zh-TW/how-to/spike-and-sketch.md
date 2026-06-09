# 如何在正式提交前進行技術驗證與介面草圖

**目標：** 在將某個階段鎖定到具體方案之前，通過聚焦的可行性實驗（spike）和一次性 HTML 原型（sketch）來降低實現風險。

**前提條件：** 無。`/gsd-spike` 和 `/gsd-sketch` 會自行建立所需的儲存目錄，不要求已初始化 GSD 專案。

---

## 決策：spike、sketch，還是兩者都用

| 你想回答的問題… | 使用 |
|---|---|
| "這個技術方案真的可行嗎？" | `/gsd-spike` |
| "這個佈局 / 互動 / 視覺處理感覺對嗎？" | `/gsd-sketch` |
| "正確的技術方案是什麼，它應該長什麼樣？" | 兩者都用，順序是：先 spike，再 sketch |

Spike 通過可執行程式碼和 VALIDATED / INVALIDATED / PARTIAL 結論來回答二元可行性問題。Sketch 通過 2–3 個可在瀏覽器中對比的 HTML 變體來回答視覺問題。兩者互為補充——spike 證明方案可構建，sketch 證明設計值得構建。

---

## 執行 spike

### 互動式引導（預設）

```bash
/gsd-spike
```

GSD 會詢問技術問題，將其分解為 2–5 個獨立實驗，以 **Given / When / Then** 假設形式呈現，並在開始構建前請求確認。

### 直接提供想法

```bash
/gsd-spike "can we stream LLM tokens through SSE"
```

### 跳過引導，直接執行

```bash
/gsd-spike --quick "websocket vs SSE latency"
```

`--quick` 跳過分解對話，直接將引數作為單個 spike 問題處理。當問題已經足夠具體、無需進一步細化時使用此選項。

### 每個實驗產出內容

`.planning/spikes/NNN-descriptive-name/` 中的每個 spike 包含：

- 可執行的程式碼（非虛擬碼）
- 在編寫任何程式碼之前寫好的 **Given / When / Then** 假設
- 記錄邊界情況、方向調整和意外發現的調查軌跡
- 附有證據的 **VALIDATED**、**INVALIDATED** 或 **PARTIAL** 結論
- 包含 frontmatter、執行說明和結果的 `README.md`

所有 spike 均在 `.planning/spikes/MANIFEST.md` 中建立索引。

### 打包調查結果

當你獲得有效訊號後，將調查結果封裝成專案本地技能，以便後續會話自動載入：

```bash
/gsd-spike --wrap-up
```

此命令會寫入 `.claude/skills/spike-findings-[project]/`。該技能會被自動發現，並在後續的 `/gsd-sketch`、`/gsd-ui-phase` 和 `/gsd-plan-phase` 執行時載入——無需顯式引用。

---

## 執行 sketch

### 風格引導（預設）

```bash
/gsd-sketch
```

GSD 會開啟一段簡短對話，在編寫任何程式碼之前探索感覺、視覺參考和核心使用者操作。它每次只問一個問題，只有在你說"開始"後才動手構建。

### 直接提供設計方向

```bash
/gsd-sketch "dashboard layout"
```

### 跳過風格引導，直接執行

```bash
/gsd-sketch --quick "sidebar navigation"
```

`--quick` 完全跳過引導對話，直接使用引數作為設計方向。

### 非 Claude 執行時（Codex、Gemini CLI 等）

```bash
/gsd-sketch --text "onboarding flow"
```

`--text` 將互動式提示替換為純文本編號列表。當你的執行時不支援 `AskUserQuestion` 時使用此選項。

### 每個草圖產出內容

`.planning/sketches/NNN-descriptive-name/` 中的每個 sketch 包含：

- 帶有 2–3 個變體、可通過選項卡導航訪問的 `index.html`——直接在瀏覽器中開啟，無需構建步驟
- 功能性互動元素（懸停、點選、過渡動畫）
- 使用來自先前 spike 調查結果的欄位名和資料結構的近似真實內容
- 來自 `.planning/sketches/themes/default.css` 的共享 CSS 變數
- 包含設計問題、變體說明和關注點的 `README.md`

所有 sketch 均在 `.planning/sketches/MANIFEST.md` 中建立索引。

### 打包獲勝的設計決策

選定變體後，將視覺決策捕獲到專案本地技能中：

```bash
/gsd-sketch --wrap-up
```

此命令會寫入 `.claude/skills/sketch-findings-[project]/`。該技能由 `/gsd-ui-phase` 自動獲取——經過預驗證的決策（佈局、色彩方案、排版、間距）被視為已鎖定，不會再次詢問。

---

## 組合流程：spike → sketch → phase

當你對技術可行性和視覺方向都不確定時，推薦使用以下順序：

```bash
/gsd-spike "SSE vs WebSocket for real-time feed"
/gsd-spike --wrap-up

/gsd-sketch "real-time feed UI"
/gsd-sketch --wrap-up

/gsd-discuss-phase N
/gsd-plan-phase N
```

spike 調查結果會為 sketch 提供參考（真實資料結構、真實互動狀態、實際約束）。兩次 wrap-up 均會持久化決策，規劃器和 UI 研究員會自動載入，因此在 `/gsd-discuss-phase` 或 `/gsd-ui-phase` 期間無需重新解釋選擇。

---

## spike 或 sketch 如何流入某個階段

Spike 和 sketch 的產物不需要手動引用。GSD 會在以下兩個時間點自動讀取它們：

1. **`/gsd-sketch`** — 在構建原型前載入 `.claude/skills/spike-findings-*/`，使變體反映已驗證的約束（流式狀態、真實欄位名等）
2. **`/gsd-ui-phase N`** — 在生成 UI 設計契約前載入 `.claude/skills/sketch-findings-*/`；經過預驗證的設計決策被視為已鎖定

當存在 `spike-findings-*` 技能時，規劃器也會讀取 spike 調查結果，從而使已驗證的技術選擇（採用哪個庫、哪種協議、哪種資料格式）直接流入任務計劃，無需反覆解釋。

---

## 相關文件

- [設計 UI 階段](design-a-ui-phase.md)
- [規劃階段](plan-a-phase.md)
- [命令參考](../COMMANDS.md)
- [文件索引](../README.md)
