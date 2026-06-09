# 如何恢復與排查問題

**目標：** 識別並修復常見問題——從上下文丟失、狀態損壞，到安裝失敗和許可權錯誤——採用條件化的處理步驟結構。

**前提條件：** GSD Core 已安裝。若遇到安裝問題，請參閱 [在您的執行時中安裝](install-on-your-runtime.md)。

---

## 上下文與會話問題

### 如果您不清楚當前所處的位置

```bash
/gsd-progress
```

讀取所有狀態檔案，並精確告知您當前位置以及下一步操作。

若要自動跳轉到正確的下一步：

```bash
/gsd-progress --next
```

### 如果您正在開始新會話並需要恢復上下文

```bash
/gsd-resume-work
```

從上次交接中恢復完整的會話上下文，包括當前階段、規劃決策以及工作停止的位置。

### 如果長時間會話中品質開始下降

在執行主要命令之間清空上下文視窗：

```bash
/clear
```

然後恢復狀態：

```bash
/gsd-resume-work
```

GSD 的設計圍繞全新上下文展開。每個子代理已獲得乾淨的 200k 視窗。主會話會隨時間退化——清空並恢復才是正確的處理方式，而非繼續硬撐。

### 如果您希望在停止前儲存上下文

```bash
/gsd-pause-work
```

將當前位置建立為 `.planning/HANDOFF.json`。新增 `--report` 可同時將會話後摘要寫入 `.planning/reports/`：

```bash
/gsd-pause-work --report
```

---

## 規劃完整性問題

### 如果 `.planning/` 完整性不確定

```bash
/gsd-health
```

以錯誤、警告和資訊說明的形式報告狀態：

| 狀態 | 含義 |
|--------|---------|
| `HEALTHY` | 所有預期產物存在且格式正確 |
| `DEGRADED` | 存在應當處理的警告，但工作可以繼續 |
| `BROKEN` | 存在將阻斷執行的嚴重錯誤 |

可自動修復的常見問題（錯誤 E004、E005；警告 W003、W008）：

```bash
/gsd-health --repair
```

該命令會重新建立缺失的 `STATE.md`，將損壞的 `config.json` 重置為預設值，並補充所有缺失的配置鍵。它不會覆蓋 `PROJECT.md` 或 `ROADMAP.md`。

### 如果 STATE.md 引用了不存在的階段

這會產生警告 `W002`。使用狀態 CLI 進行診斷和修復：

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state validate
```

在不寫入的情況下預覽同步將更改的內容：

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync --verify
```

應用同步：

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync
```

這些命令從磁碟上的實際專案狀態重建 `STATE.md`，取代手動編輯 `STATE.md` 的操作。

### 如果看到"專案已初始化"

`.planning/PROJECT.md` 已存在。`/gsd-new-project` 是一項安全檢查。如果您確實想重新開始，請先刪除 `.planning/` 目錄：

```bash
rm -rf .planning/
```

然後重新執行 `/gsd-new-project`。

### 如果上下文視窗利用率過高

```bash
/gsd-health --context
```

探測上下文視窗利用率保護機制。警告閾值為 60%，嚴重閾值為 70%。如果超過警告閾值，請在開始下一個主要命令前執行 `/clear` 後跟 `/gsd-resume-work`。

---

## 執行問題

### 如果執行器在執行 Bash 命令時遇到"Permission denied"

GSD 的 `gsd-executor` 子代理需要具有寫入許可權的 Bash 訪問。在 `~/.claude/settings.json` 的 `permissions.allow` 下新增所需模式。至少需要：

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git checkout:*)"
```

針對特定技術棧的模式（Rails、Python、Node、Rust），請參閱 `docs/USER-GUIDE.md` 中"執行器子代理遇到 Permission denied"一節的完整表格。

按專案配置的替代方案：在專案根目錄的 `.claude/settings.local.json` 中新增相同的配置塊。

### 如果執行失敗或產生存根程式碼

檢查計劃是否過於宏大。計劃最多應包含兩到三個任務。如果任務太大，則超出單個上下文視窗能可靠產出的範圍。請以更小的範圍重新規劃該階段：

```bash
/gsd-plan-phase 1
```

若要系統性地診斷出錯原因，請參閱 [除錯失敗的執行](debug-a-failed-execution.md)。

### 如果並行執行導致構建鎖定錯誤或預提交鉤子失敗

這是由多個代理同時觸發構建工具引起的。自 v1.26 起，GSD 自動處理此問題。如果您使用的是舊版本，或仍然出現競爭問題，請停用並行執行：

```bash
/gsd-settings
```

將 `parallelization.enabled` 設定為 `false`。

### 如果子代理顯示失敗但提交已完成

在得出某些內容出錯的結論之前，請檢查 git 日誌：

```bash
git log --oneline -10
```

Claude Code 中存在一個已知的分類錯誤，可能在工作實際成功時報告失敗。GSD 的編排器會抽查實際輸出，但如果您發現不一致，提交記錄才是最終依據。

---

## 計劃與階段問題

### 如果計劃看起來有誤或與您的意圖不符

在規劃之前執行 `/gsd-discuss-phase N`。大多數計劃品質問題來自本可由 `CONTEXT.md` 預防的假設：

```bash
/gsd-discuss-phase 1
```

若要檢視 GSD 當前做出的假設而無需開始完整會話：

```bash
/gsd-discuss-phase 3 --assumptions
```

### 如果您需要在執行後更改某些內容

不要重新執行 `/gsd-execute-phase`。請使用 `/gsd-quick` 進行有針對性的修復：

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

或使用 `/gsd-verify-work N` 通過 UAT 系統性地識別和修復問題。

### 如果命令在"Spawning…"處似乎卡住了

請等待。GSD 子代理在獨立的上下文視窗中執行。其工作在進行中對父會話不可見。生成行上的活躍度提示確認這是預期行為。研究和規劃代理通常需要 1–5 分鐘；驗證代理在大型階段中可能需要更長時間。

不要中斷會話。終止它會丟棄進行中的子代理工作。

如果已超過 10 分鐘，請檢查代理任務在 Claude Code 側邊欄中是否仍顯示為活躍狀態。

---

## 工作流狀態問題

### 如果工作流似乎已損壞或狀態不一致

```bash
/gsd-forensics
```

或附帶描述：

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

`/gsd-forensics` 執行事後調查：git 歷史異常、產物完整性、STATE.md 一致性、未提交的工作以及孤立的工作樹。它將報告寫入 `.planning/forensics/` 並給出推薦的補救步驟。該命令為只讀，不會修改您的專案檔案。

### 如果您需要回滾某個階段或計劃

```bash
/gsd-undo --phase 03          # 回滾階段 3 的所有提交
/gsd-undo --plan 03-02        # 回滾階段 3 中計劃 02 的提交
/gsd-undo --last 5            # 從最近 5 個 GSD 提交中互動式選擇
```

`/gsd-undo` 在回滾前檢查依賴階段，並始終顯示確認步驟。

---

## 安裝與更新問題

### 如果安裝後 GSD 未被識別

重啟您的執行時。GSD 將斜槓命令安裝到您執行時的命令目錄中（例如 `~/.claude/commands/gsd/`）。大多數執行時僅在啟動時發現新命令。

如果問題仍然存在，請驗證安裝：

```bash
npx @opengsd/gsd-core@latest --claude --local
```

有關特定執行時的安裝路徑和排查說明，請參閱 [在您的執行時中安裝](install-on-your-runtime.md)。

### 如果更新覆蓋了您的本地更改

自 v1.17 起，安裝程式將本地修改的檔案備份到 `gsd-local-patches/`。重新應用您的更改：

```bash
/gsd-update --reapply
```

### 如果無法通過 npm 更新

如果 `npx @opengsd/gsd-core` 因 npm 故障或網路限制而失敗，請參閱 `docs/manual-update.md` 瞭解無需 npm 訪問即可完成更新的逐步手動更新流程。

有關常規更新，請參閱 [更新 GSD](update-gsd.md)。

---

## 成本問題

### 如果模型費用過高

切換到預算配置檔案：

```bash
/gsd-config --profile budget
```

如果對該領域已很熟悉，請通過設定停用研究和計劃檢查代理：

```bash
/gsd-settings
```

另外，請稽核已啟用的 MCP 伺服器。每個已啟用的 MCP 伺服器都會在每個回合中將其工具架構注入。瀏覽器和平臺特定工具每個可能消耗 20k+ 個令牌。在 `.claude/settings.json` 中停用當前階段不需要的伺服器：

```json
{
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

---

## 恢復快速參考

| 問題 | 解決方案 |
|---------|---------|
| 上下文丟失或新會話 | `/gsd-resume-work` 或 `/gsd-progress` |
| 不知道下一步是什麼 | `/gsd-progress --next` |
| 階段出錯 | `/gsd-undo --phase NN`，然後重新規劃 |
| 某些內容損壞 | `/gsd-debug "description"`（新增 `--diagnose` 可僅分析而不修復） |
| STATE.md 不同步 | `state validate` 後 `state sync` |
| `.planning/` 完整性不確定 | `/gsd-health`，然後 `/gsd-health --repair` |
| 工作流狀態似乎損壞 | `/gsd-forensics` |
| 快速針對性修復 | `/gsd-quick` |
| 計劃與您的願景不符 | `/gsd-discuss-phase N` 後重新規劃 |
| 成本過高 | `/gsd-config --profile budget` 和 `/gsd-settings` 關閉代理 |
| 更新破壞了本地更改 | `/gsd-update --reapply` |
| 需要會話摘要 | `/gsd-pause-work --report` |
| 並行執行構建錯誤 | 更新 GSD 或設定 `parallelization.enabled: false` |

---

## 相關內容

- [除錯失敗的執行](debug-a-failed-execution.md)
- [在您的執行時中安裝](install-on-your-runtime.md)
- [命令](../COMMANDS.md)
- [文件索引](../README.md)
