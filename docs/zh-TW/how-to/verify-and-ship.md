# 如何驗證併發布階段

**目標：** 對已執行的工作進行使用者驗收測試，診斷並修復任何失敗，然後開啟一個帶有自動生成正文的拉取請求。

**前提條件：** 該階段已執行完畢幷包含 `SUMMARY.md` 檔案。如果執行尚未完成，請參閱[執行階段](execute-a-phase.md)。

---

## 執行使用者驗收測試

```bash
/gsd-verify-work 1
```

GSD Core 讀取該階段的 `SUMMARY.md` 檔案，提取使用者可觀測的交付物，並逐一引導您完成驗證。對於每個檢查點，它會展示*應該*發生的情況，並詢問實際情況是否與之匹配。

- `yes` / `y` / 直接回車 → 通過，進入下一項測試
- 其他任何輸入 → 記錄為問題，嚴重程度根據您的描述推斷

您無需手動分類嚴重程度——GSD Core 會從您的描述中推斷（"崩潰" → 阻塞級，"無法使用" → 嚴重級，"看起來不對" → 外觀級）。

進度將寫入 `.planning/phases/01-<name>/01-UAT.md`，在 `/clear` 之後依然保留。若會話中斷，重新執行 `/gsd-verify-work 1`，GSD Core 會提示是否從上次檢查點恢復。

---

## 發現失敗時：自動診斷與修復規劃

如果有測試報告問題，GSD Core 會自動執行以下步驟：

1. **診斷根本原因** — 為每個問題並行啟動除錯代理，並將根本原因更新至 `UAT.md`。
2. **規劃差距彌補** — 在差距彌補模式下啟動 `gsd-planner`，讀取 `UAT.md`（含診斷結果）並生成新的 `PLAN.md` 檔案。
3. **驗證修復計劃** — 啟動 `gsd-plan-checker` 確保計劃可執行。若發現問題，規劃器與檢查器最多迭代三次。
4. **呈現下一步** — 當計劃通過檢查器時：

```
Plans verified and ready for execution.

`/clear` then `/gsd-execute-phase 1 --gaps-only`
```

執行提示的命令以應用修復，然後重新執行 `/gsd-verify-work 1` 確認一切通過。

---

## 所有測試通過時：釋出階段

一旦所有 UAT 測試通過（或首次執行且未發現問題），該階段將自動在 `ROADMAP.md` 和 `STATE.md` 中標記為已完成。

```bash
/gsd-ship 1
```

GSD Core 執行預檢（驗證狀態、乾淨的工作樹、分支、遠端倉庫、`gh` CLI 身份驗證），推送分支並建立 PR：

```bash
/gsd-ship 1          # 準備審查的 PR
/gsd-ship 1 --draft  # 草稿 PR — 當後續還有更多階段時很有用
```

PR 正文由規劃產物自動組裝：

- 來自 `ROADMAP.md` 的階段目標
- 來自 `SUMMARY.md` 檔案及其關鍵檔案的各計劃摘要
- 已解決的需求（REQ-IDs）
- 來自 `VERIFICATION.md` 的驗證狀態
- 來自 `STATE.md` 的關鍵決策

無需手動編寫正文。

---

## 可選：釋出前或釋出後的程式碼審查

`/gsd-ship` 不會自動執行程式碼審查，但您可以在任意節點插入審查：

**驗證前**（在 UAT 之前發現問題）：

```bash
/gsd-code-review 1          # 標準審查
/gsd-code-review 1 --fix    # 審查後自動修復 Critical 和 Warning 發現
```

**PR 開啟後**（在合併前把關品質）：

```bash
/gsd-code-review 1 --depth=deep  # 包含匯入圖的跨檔案分析
```

請參閱[配置跨 AI 審查](set-up-cross-ai-review.md)，瞭解如何在週期早期為計劃審查配置 Gemini、Codex 或其他審查工具。

---

## 可選：建立乾淨的 PR 分支

如果您的分支包含不希望審查者看到的 `.planning/` 提交：

```bash
/gsd-pr-branch          # 相對於 main 進行過濾
/gsd-pr-branch develop  # 相對於 develop 進行過濾
```

`/gsd-pr-branch` 會建立一個僅包含程式碼變更的新分支——規劃產物提交將被排除。若您的團隊審查規範不包含規劃噪音，請在 `/gsd-ship` 之前執行此命令。

---

## 關閉里程碑

如果這是里程碑中的最後一個階段，請執行里程碑審計並將其歸檔：

```bash
/gsd-audit-milestone      # 驗證所有需求已釋出
/gsd-complete-milestone   # 歸檔，建立 git 標籤
```

`/gsd-complete-milestone` 是 PR 合併後的自然下一步。請參閱[階段迴圈](../explanation/the-phase-loop.md)，瞭解驗證與釋出如何融入完整的專案生命週期。

---

## 相關內容

- [執行階段](execute-a-phase.md)
- [配置跨 AI 審查](set-up-cross-ai-review.md)
- [階段迴圈](../explanation/the-phase-loop.md)
- [命令參考](../COMMANDS.md)
