# 如何除錯失敗的執行

**目標：** 在某個階段執行失敗、卡住或產生不完整工作時進行恢復，並在不丟失進度或重複已成功工作的情況下乾淨地繼續。

**前提條件：** 您已執行 `/gsd-execute-phase N`，執行在寫入 `VERIFICATION.md` 之前停止，或者您看到意外輸出、缺少檔案，或進度條卡住不動。

---

## 判斷執行是卡住還是失敗

在採取任何恢復操作之前，先確認實際發生了什麼。

### 如果您看到"Spawning…"後超過 1–5 分鐘沒有輸出

這是正常現象，並非凍結。GSD 子代理在獨立的上下文視窗中執行。spawn 行上的存活註釋可以確認這一點。請不要中斷會話。

如果超過 10 分鐘仍無結果，請檢查 Claude Code 側邊欄。如果代理任務顯示已完成但沒有輸出，結果可能在上下文切換中丟失——請重新執行相同的命令：

```bash
/gsd-execute-phase 1
```

GSD 在分派執行器之前會檢查 `SUMMARY.md` 檔案。已有該檔案的計劃將被自動跳過。

### 如果執行在某個 wave 中途停止並顯示錯誤資訊

檢查 git 歷史記錄，檢視哪些計劃已成功提交：

```bash
git log --oneline -20
```

已提交工作的計劃會有類似 `feat(01-02): …` 的條目。沒有提交的計劃是不完整的，重新執行時會被重新執行。

### 如果執行器已提交程式碼但未寫入 SUMMARY.md

GSD 會在下次執行時檢測到這一情況，並彈出一個安全恢復確認介面，提供三個選項：

- **手動收尾** — 自行檢查提交內容，寫入 `SUMMARY.md`，然後重新執行。
- **從頭重新執行** — 在分派新執行器之前，回滾或覆蓋部分提交。
- **標記並跳過** — 記錄異常並繼續，僅在您明確確認後執行。

---

## 診斷根本原因

### 執行 `/gsd-debug --diagnose`

如果執行產生了錯誤輸出、存根程式碼或驗證失敗，使用診斷模式進行調查，而不應用任何修復：

```bash
/gsd-debug --diagnose "Phase 2 executor produced stubs instead of real code"
```

`--diagnose` 在找到根本原因後停止，不修改您的檔案。它會在 `.planning/debug/<slug>.md` 建立一個會話檔案，以便您在需要時稍後繼續調查。

要啟動同時應用修復的完整除錯會話：

```bash
/gsd-debug "Login middleware not handling 401 correctly after phase 3"
```

GSD 收集症狀，使用科學方法進行結構化調查，並提出修復方案。如果您的配置中設定了 `tdd_mode: true`，則在應用任何修復之前需要先有一個失敗的測試。

### 檢視活動除錯會話

```bash
/gsd-debug list
```

顯示所有開啟的會話及其當前假設和下一步操作。要恢復特定會話：

```bash
/gsd-debug continue <slug>
```

---

## 使用 `/gsd-forensics` 進行事後分析

如果根本原因從錯誤輸出中無法判斷——例如，計劃引用了不存在的檔案、執行產生了意外結果，或狀態似乎已損壞——請執行取證調查：

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

GSD 分析 git 歷史記錄、`.planning/` 製品完整性、STATE.md 一致性、未提交的工作和孤立的 worktree。它將結構化報告寫入 `.planning/forensics/report-<timestamp>.md`，並給出推薦的修復步驟。

`/gsd-forensics` 是隻讀的——它不會修改您的專案檔案。

**可檢測的問題：**

- **卡死迴圈** — 同一檔案在短時間內出現在三個或更多連續提交中（如果提交訊息相似，則置信度為 HIGH）
- **缺失製品** — 某階段有提交但沒有 `SUMMARY.md` 或 `VERIFICATION.md`
- **遺棄的工作** — 存在未提交的更改，且 STATE.md 顯示執行進行到一半，最後一次提交超過兩小時前
- **崩潰或中斷** — 未提交的更改結合活動的執行狀態和孤立的 worktree
- **範圍漂移** — 最近的提交觸及了當前階段預期檔案集之外的檔案

---

## 恢復後繼續執行

一旦底層問題解決，重新執行執行命令：

```bash
/gsd-execute-phase 1
```

GSD 會跳過 `SUMMARY.md` 已存在的計劃，僅為剩餘計劃分派執行器。

如果您只需要重新執行特定的 wave：

```bash
/gsd-execute-phase 1 --wave 2
```

如果您想在分派前驗證 `.planning/` 的完整性：

```bash
/gsd-execute-phase 1 --validate
```

---

## 使用 `/gsd-undo` 回滾

如果執行產生了您想完全丟棄的程式碼，請使用計劃清單進行回滾，而不是手動 `git revert`：

### 回滾單個計劃

```bash
/gsd-undo --plan 03-02
```

回滾階段 `3` 中計劃 `02` 的所有提交。GSD 在寫入任何更改之前會顯示確認介面。

### 回滾整個階段

```bash
/gsd-undo --phase 03
```

回滾階段 `3` 的所有提交。GSD 會檢查後續階段是否依賴該階段，並在繼續之前發出警告。

### 從最近的提交中互動式選擇

```bash
/gsd-undo --last 5
```

顯示最近五個 GSD 提交，讓您選擇要回滾的內容。

---

## 中斷後恢復會話上下文

如果您在上下文重置或新會話後返回專案：

```bash
/gsd-resume-work
```

從上次交接中恢復您的完整會話上下文，包括當前階段、阻塞項以及執行停止的位置。

或者，要檢視當前進度並自動跳轉到下一個正確步驟：

```bash
/gsd-progress --next
```

---

## 相關內容

- [執行階段](execute-a-phase.md)
- [恢復與故障排查](recover-and-troubleshoot.md)
- [命令](../COMMANDS.md)
- [文件索引](../README.md)
