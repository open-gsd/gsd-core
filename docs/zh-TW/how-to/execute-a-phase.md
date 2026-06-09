# 如何執行階段

**目標：** 通過基於波次的並行執行來執行已規劃的階段，並將每個計劃作為原子性 git 提交落地。

**前置條件：** 該階段至少有一個 `PLAN.md` 檔案。如果規劃尚未完成，請先執行 `/gsd-plan-phase N` —— 參見[規劃階段](plan-a-phase.md)。

---

## 執行完整階段

```bash
/gsd-execute-phase 1
```

GSD Core 讀取階段的計劃檔案，將其按依賴關係分組為若干波次，併為每個計劃生成獨立的執行器代理。每個執行器在下一波次開始前以原子方式提交其工作。

在分發任何代理之前，GSD Core 會列印波次表：

```
## Execution Plan

Phase 1: Core middleware — 3 plans across 2 wave(s)

| Wave | Plans          | What it builds            |
|------|----------------|---------------------------|
| 1    | 01-01, 01-02   | Core validation function  |
| 2    | 01-03          | Express middleware wrapper |
```

第 1 波次的計劃並行執行（每個在獨立的 git 工作樹中）。第 2 波次等待所有第 1 波次提交合並後才開始。

關於底層代理協調模型，請參見[多代理編排](../explanation/multi-agent-orchestration.md)。

---

## 執行單個波次

如果只想執行一個波次——例如，在進入第 2 波次之前先檢查第 1 波次的輸出——請使用 `--wave N`：

```bash
/gsd-execute-phase 1 --wave 2
```

GSD Core 僅執行第 2 波次的計劃。它會首先檢查所有較早波次是否已完成；如果任何第 1 波次計劃仍標記為未完成，則會停止並提示你先完成較早波次。

---

## 執行前驗證狀態

如果你懷疑 `.planning/` 目錄與檔案系統不同步——例如在崩潰或上一次執行中斷之後——請傳入 `--validate`：

```bash
/gsd-execute-phase 1 --validate
```

GSD Core 在生成任何執行器之前執行狀態一致性檢查。檢測到的偏差會被上報，你可以在繼續之前接受或糾正。

---

## 恢復停滯的執行

如果執行中途停止——配額錯誤、網路斷開或會話崩潰——波次級別的進度會被保留。GSD Core 會檢查每個計劃的 `SUMMARY.md` 檔案；已有該檔案的計劃在重新執行時會自動跳過：

```bash
/gsd-execute-phase 1
```

GSD Core 會跳過 `SUMMARY.md` 已存在的計劃，並從第一個未完成的計劃繼續。

**如果提交存在但 `SUMMARY.md` 缺失**（執行器已提交，但在會話結束前未寫入摘要），GSD Core 會彈出一個安全恢復門並提供三個選項：

- `close out manually` — 檢查提交，手動編寫 `SUMMARY.md`，然後重新執行。
- `re-execute from scratch` — 在分發新執行器前回滾或替代部分提交。
- `mark-and-skip` — 記錄異常並繼續，僅在明確確認後執行。

關於系統性故障診斷，請參見[除錯失敗的執行](debug-a-failed-execution.md)。

---

## 輸出位置

所有波次完成後，階段目錄包含：

```
.planning/phases/01-<name>/
  01-01-SUMMARY.md    # What plan 01 built, key files, deviations
  01-02-SUMMARY.md
  01-03-SUMMARY.md
  VERIFICATION.md     # Requirement-by-requirement pass/fail status
```

所有波次完成後，`STATE.md` 和 `ROADMAP.md` 會自動更新。`VERIFICATION.md` 僅在階段完全完成時寫入。

Git 歷史記錄中每個任務會有一個提交（來自各執行器），隨後是編排器的跟蹤提交。

---

## 跨 AI 執行

要將執行委託給在 `workflow.cross_ai_command` 中配置的外部 AI CLI（Codex、Gemini 等）：

```bash
/gsd-execute-phase 2 --cross-ai
```

要在配置中啟用跨 AI 時強制本地執行：

```bash
/gsd-execute-phase 2 --no-cross-ai
```

---

## 相關內容

- [規劃階段](plan-a-phase.md)
- [驗證與釋出](verify-and-ship.md)
- [除錯失敗的執行](debug-a-failed-execution.md)
- [命令參考](../COMMANDS.md)
