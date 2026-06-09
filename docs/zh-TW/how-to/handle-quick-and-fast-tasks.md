# 如何處理快速輕量級任務

並非每項工作都需要完整的階段流程。GSD 提供了兩個輕量級命令，適用於不需要完整的討論 → 計劃 → 執行 → 驗證迴圈的工作。

有關何時值得使用完整階段流水線的說明，請參閱[上下文工程](../explanation/context-engineering.md)。

---

## 決定使用哪個命令

| 場景 | 命令 |
|-----------|---------|
| 修復 Bug、新增小功能，或任何無法概括為單一瑣碎編輯的任務 | `/gsd-quick` |
| 修復錯別字、更新配置值、新增 `.gitignore` 條目，或任何涉及 ≤ 3 個檔案且耗時不到一分鐘的更改 | `/gsd-fast` |
| 任務有未知因素、需要調研，或將涉及超過幾個檔案 | `/gsd-quick` 加 `--research` |

**經驗法則：** 如果你哪怕有一刻猶豫該任務是否屬於瑣碎操作，就使用 `/gsd-quick`。當範圍看起來不夠簡單時，`/gsd-fast` 會自動將你重定向到 `/gsd-quick`。

---

## `/gsd-quick` — 帶有 GSD 保證的臨時任務

`/gsd-quick` 執行一個規劃器和執行器，提供與完整階段相同的原子提交和 STATE.md 跟蹤保證，但無需階段開銷（無 ROADMAP 條目、無討論階段、無跨多個計劃的波次協調）。

### 基本用法

```bash
/gsd-quick
```

GSD 會提示你輸入任務描述，然後進行規劃和執行。產出物儲存在 `.planning/quick/` 中。

你也可以直接傳入描述：

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

### 標誌

當任務需要時，新增標誌可引入更多品質流水線步驟。

| 標誌 | 功能說明 |
|------|-------------|
| `--discuss` | 在規劃器執行前進行輕量級的預規劃討論，梳理灰色地帶並將決策記錄到 `CONTEXT.md` 中 |
| `--research` | 由專注的調研代理在規劃前調查方案、庫和潛在問題 |
| `--validate` | 計劃檢查（最多 2 次迭代）加上執行後驗證 |
| `--full` | 以上全部 — 等同於 `--discuss --research --validate` |

標誌可自由組合：

```bash
/gsd-quick --research --validate   # research + plan-checking + verification, no discuss
/gsd-quick --discuss               # just surface grey areas before planning
/gsd-quick --full                  # the complete quality pipeline
```

### 何時新增標誌

- 當你不確定如何處理任務或使用哪個庫時，新增 `--research`。
- 當任務涉及關鍵程式碼路徑，且你希望驗證代理確認必要條件已滿足時，新增 `--validate`。
- 當任務有設計選擇需要在規劃器執行前鎖定時，新增 `--discuss`——例如，當正確的錯誤處理行為不夠明顯時。
- 當任務確實比較重要，通常應作為階段規劃，但又不屬於 ROADMAP 範疇時，使用 `--full`。

### 列出和恢復快速任務

```bash
/gsd-quick list                    # show all quick tasks with status
/gsd-quick status my-task-slug     # show status of a specific task
/gsd-quick resume my-task-slug     # resume an interrupted task
```

---

## `/gsd-fast` — 內聯瑣碎編輯

`/gsd-fast` 直接在當前上下文中完成工作。沒有子代理、沒有 `PLAN.md`，也沒有調研。它僅適用於你自己在一分鐘內即可完成的更改。

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to .gitignore"
```

如果你省略描述，GSD 會提示你輸入。

`/gsd-fast` 在繼續操作前會檢查任務是否確實屬於瑣碎操作。如果判斷範圍過大，它會停止並重定向你：

```text
This looks like it needs planning. Use /gsd-quick instead:
  /gsd-quick "your task description"
```

完成更改後，`/gsd-fast` 以原子方式提交，並且如果 `.planning/STATE.md` 中存在 `Quick Tasks Completed` 表格，則向其追加一行。

---

## `/gsd-quick` 相比 `/gsd-fast` 多提供的能力

| 能力 | `/gsd-fast` | `/gsd-quick` |
|------------|------------|--------------|
| 子代理規劃器 | 否 | 是 |
| 子代理執行器 | 否 | 是 |
| 調研代理 | 否 | 可選（`--research`） |
| 計劃檢查 | 否 | 可選（`--validate`） |
| 執行後驗證 | 否 | 可選（`--validate`） |
| 討論階段 | 否 | 可選（`--discuss`） |
| 工作樹隔離 | 否 | 是（預設） |
| 每任務原子提交 | 單次提交 | 每個計劃任務一次 |
| STATE.md 跟蹤 | 若表格存在則追加行 | 始終更新 |
| `.planning/quick/` 產出物 | 否 | 是 |

關鍵區別在於子代理隔離。`/gsd-quick` 在獨立的上下文視窗中啟動全新的規劃器和執行器，這意味著工作會被妥善規劃，提交按任務原子化，且編排器可驗證結果。`/gsd-fast` 僅使用當前上下文視窗，有意限制於無需上述任何流程的瑣碎更改。

---

## 相關文件

- [階段迴圈](../explanation/the-phase-loop.md)
- [上下文工程](../explanation/context-engineering.md)
- [命令參考](../COMMANDS.md)
- [文件索引](../README.md)
