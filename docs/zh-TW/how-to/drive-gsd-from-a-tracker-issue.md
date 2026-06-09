# 如何從追蹤器議題驅動 GSD Core

**目標：** 將一個範圍明確的 GitHub、Linear 或 Jira 議題，通過完整的 GSD 流水線從隔離工作區推進至合併 PR——僅使用 GSD Core 中已有的命令，無需任何自定義指令碼或追蹤器整合。

**前提條件：** GSD Core 已安裝。議題範圍有邊界、驗收標準可觀測，且無上游阻塞依賴。

有關該模式背後的概念與設計理由，請參閱[議題驅動編排詳解](../issue-driven-orchestration.md)。

---

## 第一步：將議題對映到階段

開啟追蹤器議題，決定它如何對應 `ROADMAP.md` 中的階段：

- **議題與現有階段匹配** → 記下階段編號，轉至第二步。
- **議題是獨立的新工作** → 新增一個階段：

```bash
/gsd-phase "描述與議題標題一致的內容"
```

- **議題緊急，必須插入現有階段之間** → 插入一個小數階段：

```bash
/gsd-phase --insert 3 "Fix: 來自議題的描述"
```

複製追蹤器議題的 URL。您將在第三步中將其貼上到 `CONTEXT.md`，以便在上下文壓縮後仍保留可追溯性。

---

## 第二步：建立隔離工作區

每個議題都有專屬工作區——一個帶有獨立 `.planning/` 目錄的 git worktree。未完成的工作、中止的計劃和探索性提交均保留在 `main` 之外。

```bash
/gsd-workspace --new --name my-issue-slug --repos . --strategy worktree
```

繼續操作前，切換到工作區目錄：

```bash
cd ~/gsd-workspaces/my-issue-slug
```

---

## 第三步：討論階段

執行 discuss-phase，在規劃開始之前確定實現決策。會話開啟後，將追蹤器議題 URL 貼上到討論中，以便記錄到 `CONTEXT.md`。

```bash
/gsd-discuss-phase N
```

GSD 會就議題範圍中的模糊點進行提問——錯誤處理、邊界情況、介面契約、技術選型。您的回答將影響後續生成的計劃。

如果您已知曉所有答案並希望快速推進：

```bash
/gsd-discuss-phase N --auto
```

---

## 第四步：規劃階段

```bash
/gsd-plan-phase N
```

GSD 會派生研究代理，讀取您的 `CONTEXT.md` 決策（包括議題 URL），並生成原子化的 `PLAN.md` 檔案。計劃檢查器會在儲存前驗證每份計劃。

如果您希望在執行前由外部 AI CLI 進行同行評審（對於重大變更推薦使用）：

```bash
/gsd-review --phase N
/gsd-plan-phase N --reviews
```

或執行完整的計劃-評審-收斂迴圈，直到不再有 HIGH 級別的問題：

```bash
/gsd-plan-review-convergence N
```

---

## 第五步：執行階段

互動式逐階段執行：

```bash
/gsd-execute-phase N
```

無人值守地執行所有剩餘階段：

```bash
/gsd-autonomous
```

在視覺化儀表盤中監控進度並跨階段排程工作：

```bash
/gsd-manager
```

三種方式均會更新 `STATE.md`，原子化提交每項任務，並執行階段後驗證器。

---

## 第六步：驗證工作

```bash
/gsd-verify-work N
```

GSD 會逐條引導您核對階段目標中的驗收標準（與追蹤器議題對應）。如有失敗，GSD 會診斷根本原因並建立修復計劃。重複執行和重新驗證，直到所有檢查通過。

即使程式碼看起來正確，也應將 `verification_failed` 視為阻塞——失敗通常會揭示原始議題中遺漏的驗收標準。

---

## 第七步：評審與釋出

在開啟 PR 前先進行程式碼評審：

```bash
/gsd-code-review N
/gsd-code-review N --fix
```

然後建立 PR：

```bash
/gsd-ship N
```

GSD 會從您的規劃產物中組裝 PR 正文：階段目標、變更摘要、已滿足的需求、驗證狀態和關鍵決策。在 PR 正文中加入 `Closes #NNN` 或 `Fixes #NNN`（或通過 `/gsd-config` 設定），以便在 PR 合併時自動關閉追蹤器議題。

---

## 第八步：記錄後續工作

在處理議題的過程中，您常常會發現相關工作。在不丟失上下文的情況下進行記錄：

```bash
/gsd-capture "Follow-up: 發現的工作描述"           # 作為待辦事項新增
/gsd-capture --seed "值得未來階段考慮的想法"         # 為下一個里程碑保留
/gsd-capture --backlog "不緊急但值得跟蹤的內容"      # 存入待辦列表
```

GSD 不會自動向追蹤器釋出內容。從已記錄的後續工作中建立追蹤器議題是獨立的手動步驟——這保留了人工稽核的環節。

---

## 條件場景

| 情境 | 處理方式 |
|-----------|-----------|
| 議題非常小（拼寫錯誤、配置變更） | 跳過工作區 + 討論 + 規劃；改用 `/gsd-quick` |
| 議題包含多個獨立子任務 | 使用 `/gsd-manager` 跨計劃並行執行 |
| 議題被其他議題阻塞 | 在上游阻塞解除前不要開始；GSD 沒有自動依賴輪詢 |
| 執行中途發現議題範圍比預期大 | 停止，執行 `/gsd-phase --insert N` 新增子階段，然後繼續 |
| 想跳過互動式討論 | 對 `/gsd-discuss-phase` 使用 `--auto` 標誌，或為專案級自動化設定 `workflow.skip_discuss: true` |
| 多個議題構成一個連貫的釋出版本 | 執行 `/gsd-new-milestone` 將其分組，並執行 `/gsd-autonomous` 按順序執行 |

---

## 相關資源

- [議題驅動編排詳解](../issue-driven-orchestration.md)
- [使用工作區隔離工作](isolate-work-with-workspaces.md)
- [驗證與釋出](verify-and-ship.md)
- [文件索引](../README.md)
