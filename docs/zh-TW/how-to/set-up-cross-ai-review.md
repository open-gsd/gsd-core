# 如何設定跨 AI 評審

**目標：** 配置參與計劃評審的 AI 評審者，對已規劃的階段執行評審，並利用反饋收斂出無 HIGH 級別問題的計劃。

**前提條件：** 該階段已完成規劃（`.planning/phases/` 目錄中存在 `{phase}-PLAN.md` 檔案），且至少安裝並認證了一個外部 AI CLI。

---

## 決定使用哪些評審者

GSD Core 可將評審請求路由至以下任意組合：Gemini CLI、Claude（獨立會話）、Codex CLI、CodeRabbit、OpenCode、Qwen Code、Cursor、Antigravity CLI、Ollama、LM Studio 以及 llama.cpp。

每位評審者會獨立地對您的 `PLAN.md` 檔案執行相同的結構化提示。由於不同模型存在不同的盲區，多評審者共識能比任何單一評審者發現更多問題。

**如果您尚未安裝任何外部 CLI**，請至少安裝一個：

```bash
# Gemini CLI（使用 Google 憑據免費使用）
npm install -g @google/gemini-cli

# Antigravity CLI（使用 Google 憑據免費使用）
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Codex CLI
npm install -g @openai/codex
```

---

## 設定預設評審者（可選）

預設情況下，`/gsd-review` 會執行所有檢測到的 CLI。若要將特定子集固定為專案預設值：

```bash
/gsd-config --integrations
```

整合嚮導涵蓋 API 金鑰、程式碼評審 CLI 路由以及 `review.default_reviewers` 列表。將該列表設定為您希望作為無標誌預設值的評審者——例如 `["gemini","codex"]`。

或者，也可通過 `gsd-tools` 直接設定：

```bash
gsd config-set review.default_reviewers '["gemini","codex"]'
```

完整的整合設定架構（API 金鑰、每個評審者的模型覆蓋、本地伺服器主機地址）請參閱[配置](../CONFIGURATION.md)。

---

## 執行評審

### 標準評審（使用已配置的預設值或所有檢測到的 CLI）

```bash
/gsd-review --phase 3
```

GSD 會依次呼叫每位評審者，收集結構化反饋（摘要、優點、HIGH/MEDIUM/LOW 級別問題、建議、風險評估），並將合併後的輸出寫入 `.planning/phases/03-.../03-REVIEWS.md`。

### 為一次性執行選擇單個評審者

```bash
/gsd-review --phase 3 --gemini
/gsd-review --phase 3 --codex
/gsd-review --phase 3 --cursor
```

任何顯式標誌都會覆蓋該次執行的 `--all` 預設值和 `review.default_reviewers`。

### 並行執行所有可用評審者

```bash
/gsd-review --phase 3 --all
```

`--all` 始終覆蓋配置，執行完整的檢測集合，包括任何已配置的本地模型伺服器（Ollama、LM Studio、llama.cpp）。

### 本地模型伺服器評審者

如果您在本地執行 Ollama 或 LM Studio，當伺服器可達時，使用 `--all` 會自動將其包含在內。您也可以顯式指定：

```bash
/gsd-review --phase 3 --ollama
/gsd-review --phase 3 --lm-studio
```

如果預設值（`localhost:11434` / `localhost:1234`）不適用，請通過 `/gsd-config --integrations` 在 `review.*` 鍵下配置主機地址和模型選擇。

---

## 讀取評審輸出

`{padded_phase}-REVIEWS.md` 檔案包含：

- 每位評審者的獨立評審，附帶按嚴重程度分類的問題
- **共識摘要**部分，綜合了兩位或更多評審者提出的問題——從此處開始獲取最高優先順序訊號
- **分歧觀點**部分，記錄評審者意見不一致的領域

---

## 將反饋納入計劃

檢視輸出後，結合反饋重新規劃：

```bash
/gsd-plan-phase 3 --reviews
```

規劃器會讀取 `REVIEWS.md`，並在儲存前調整計劃以解決相關問題。

---

## 自動化計劃-評審-重規劃迴圈

對於希望迭代直至所有 HIGH 級別問題解決的階段，請使用收斂迴圈：

```bash
/gsd-plan-review-convergence 3
```

此命令執行 `plan-phase → review → replan → re-review`，最多迴圈三次（預設）。當 HIGH 級別問題數量降至零時，迴圈退出。

### 使用特定評審者進行收斂

```bash
/gsd-plan-review-convergence 3 --codex
/gsd-plan-review-convergence 3 --gemini
```

### 使用所有評審者並提高迴圈上限進行收斂

```bash
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

**停滯檢測：** 如果 HIGH 級別問題數量在各輪次間未減少，GSD 會向您發出警告。當迴圈上限已達但仍存在未解決的 HIGH 級別問題時，升級門控會詢問是否繼續或手動審查。

---

## 條件判斷：選擇哪些評審者

| 場景 | 推薦方式 |
|-----------|---------------------|
| 已安裝 Gemini CLI | `--gemini` 始終是良好的起始評審者 |
| 希望免費多評審者覆蓋 | `--gemini` + `--agy`（兩者均使用 Google 憑據） |
| 專案以 OpenAI 為主 | 新增 `--codex` 以獲取 OpenAI 模型視角 |
| 希望使用 GitHub Copilot 的模型 | 新增 `--opencode` |
| 希望完全避免 API 費用 | 使用本地模型配置 Ollama 並使用 `--ollama` |
| 釋出前需要最大覆蓋率 | `/gsd-plan-review-convergence N --all` |
| 快速迭代並希望獲得快速反饋 | 選擇一個 CLI：`/gsd-review --phase N --gemini` |

---

## 相關內容

- [驗證併發布](verify-and-ship.md)
- [配置](../CONFIGURATION.md)
- [命令](../COMMANDS.md)
- [文件索引](../README.md)
