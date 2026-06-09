# 如何從 GSD-2 遷移

**目標：** 將較舊的 GSD-2 專案（`.gsd/` 目錄佈局）升級遷移到 GSD Core（`.planning/` 佈局），並可選擇將專案倉庫中已有的 ADR、PRD 或規範文件納入新的規劃結構。

**前提條件：** GSD Core 已安裝。GSD-2 專案目錄在磁碟上可訪問。

---

## 瞭解遷移內容

GSD-2 使用 `.gsd/` 目錄作為規劃根目錄，GSD Core 使用 `.planning/`。遷移過程讀取 `.gsd/` 中的工件，並將其寫入所有 GSD Core 命令所期望的標準 `.planning/` 結構中。

| GSD-2 中的現有內容 | `/gsd-import --from-gsd2` 產生的內容 |
|----------------------|-----------------------------------------|
| `.gsd/PROJECT.md` | `.planning/PROJECT.md` |
| `.gsd/ROADMAP.md` | `.planning/ROADMAP.md` |
| `.gsd/STATE.md` | `.planning/STATE.md` |
| `.gsd/phases/` 目錄 | `.planning/phases/` 目錄 |
| 階段 `PLAN.md` 檔案 | GSD Core `{NN}-{MM}-PLAN.md` 檔案（強制重新命名） |

衝突檢測會在寫入任何檔案之前執行。如果目標目錄中已存在 `PROJECT.md` 且匯入內容與之矛盾，遷移將在 BLOCKER 門控處停止，並列出需要您解決的衝突。

---

## 執行遷移

### 遷移當前目錄

```bash
/gsd-import --from-gsd2
```

GSD 讀取當前工作目錄下的 `.gsd/`，並將遷移後的工件寫入 `.planning/`。

### 從其他路徑遷移

```bash
/gsd-import --from-gsd2 --path ~/projects/old-project
```

當 GSD-2 專案不在當前工作目錄時，使用 `--path` 指定路徑。

---

## 解決衝突

如果衝突檢測發現阻斷項——例如，GSD-2 的技術棧宣告與現有的 `.planning/PROJECT.md` 相矛盾——它會列印衝突報告並停止，不寫入任何檔案。

閱讀報告，解決矛盾（編輯源文件或現有規劃工件），然後重新執行 `/gsd-import --from-gsd2`。遷移可以安全地重複執行，直至順利通過。

---

## 匯入外部計劃檔案

如果您擁有的是獨立的計劃文件（團隊規劃文件、Markdown 規範、匯出的任務列表），而非完整的 GSD-2 專案，請使用 `--from` 代替：

```bash
/gsd-import --from /tmp/team-plan.md
```

GSD 執行相同的衝突檢測流程，將內容轉換為 GSD Core `PLAN.md` 格式，並使用計劃檢查器驗證結果。驗證完成後，您將看到目標檔名和後續步驟。

---

## 吸收現有文件

如果您的倉庫中已包含 ADR（架構決策記錄）、PRD 或規範文件，可在遷移完成後使用 `/gsd-ingest-docs` 將其合併到 `.planning/` 結構中：

### 掃描整個倉庫（自動檢測模式）

```bash
/gsd-ingest-docs
```

如果 `.planning/` 已經存在（例如，剛完成遷移後），GSD 預設使用合併模式——將匯入的文件與已有內容並行合併，而非覆蓋。

### 限定到特定目錄

```bash
/gsd-ingest-docs docs/
/gsd-ingest-docs docs/adr/
```

### 使用顯式優先順序清單

當文件型別混合，或您希望控制衝突時哪份文件優先：

```bash
/gsd-ingest-docs --manifest ingest.yaml
```

清單是一個 YAML 檔案，每個文件列出 `{path, type, precedence?}`。請參閱 [Commands](../COMMANDS.md) 中 `--manifest` 標誌說明，瞭解其期望的結構。

### 強制指定模式

```bash
/gsd-ingest-docs --mode merge     # 合併到現有 .planning/
/gsd-ingest-docs --mode new       # 從零開始引導（覆蓋）
```

**輸出：** `/gsd-ingest-docs` 始終生成一個 `INGEST-CONFLICTS.md`，其中包含三個類別——自動解決、競爭變體和未解決的阻斷項。每次匯入執行後請審查此檔案。僅在 LOCKED 與 LOCKED 的 ADR 矛盾時才會硬停止；其他所有情況均會呈現供您審查，而不會被靜默丟棄。

---

## 驗證遷移後的專案

遷移及文件匯入完成後，確認專案狀態的一致性：

```bash
/gsd-health
/gsd-health --repair
```

`/gsd-health` 檢查 `.planning/` 目錄的完整性並報告任何偏差。`--repair` 會自動修復可恢復的問題。

然後檢查 GSD Core 是否能夠讀取您的專案狀態：

```bash
/gsd-progress
```

如果專案遷移順利，您將看到當前階段狀態和推薦的下一步操作。從此處起，適用標準 GSD Core 工作流程。

---

## 條件說明：什麼能遷移，什麼不能

| 情形 | 處理方式 |
|-----------|-----------|
| 當前目錄中存在 `.gsd/` | 執行 `/gsd-import --from-gsd2`（無需 `--path`） |
| `.gsd/` 在其他目錄 | 使用 `--path ~/projects/old-project` |
| 您有獨立的計劃文件，而非完整的 GSD-2 專案 | 使用 `/gsd-import --from /path/to/plan.md` |
| 您在 `docs/adr/` 中有 ADR | 遷移後執行 `/gsd-ingest-docs docs/adr/` |
| 您有 ADR、PRD 和規範的混合文件 | 在倉庫根目錄執行 `/gsd-ingest-docs`，它會自動分類 |
| 衝突檢測報告阻斷項 | 解決列出的矛盾後重新執行；在所有阻斷項清除前不會寫入任何檔案 |
| 您不確定遷移是否成功 | 執行 `/gsd-health` 和 `/gsd-progress` 進行確認 |
| INGEST-CONFLICTS.md 列出未解決的阻斷項 | 這些需要手動解決，相關文件才能被納入規劃 |

---

## 相關內容

- [您的第一個專案](../tutorials/your-first-project.md)
- [Commands](../COMMANDS.md)
- [文件索引](../README.md)
