# 討論模式：假設模式與訪談模式

GSD Core 的討論階段提供兩種模式，用於在規劃開始前收集實現上下文。瞭解何時使用哪種模式，有助於減少來回溝通，更快地生成確認後的 `CONTEXT.md`。

有關執行任一模式的分步說明，請參閱[討論階段使用指南](how-to/discuss-a-phase.md)。

## 模式

### `discuss`（預設）

原始訪談式流程。Claude 識別階段中的模糊區域，呈現供選擇，然後針對每個區域提出大約四個問題。適用於：

- 程式碼庫較新的早期階段
- 使用者有強烈意見希望主動表達的階段
- 偏好有引導的對話式上下文收集的使用者

### `assumptions`

以程式碼庫為中心的流程。Claude 通過子代理深度分析程式碼庫（讀取 5–15 個相關檔案），形成帶有證據的假設，並呈現供確認或糾正。適用於：

- 具有清晰規範的成熟程式碼庫
- 覺得訪談問題顯而易見的使用者
- 更快的上下文收集（約 2–4 次互動，而非約 15–20 次）

## 配置

```bash
# 啟用假設模式
node gsd-tools.cjs config-set workflow.discuss_mode assumptions

# 切換回訪談模式
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

該設定為每個專案獨立儲存（保存於 `.planning/config.json`）。有關兩種模式所生成檔案的完整結構，請參閱 [CONTEXT.md 結構說明](reference/context-md.md)。

## 假設模式的工作原理

1. **初始化** — 與討論模式相同（載入先前上下文、探查程式碼庫、檢查待辦事項）
2. **深度分析** — 探索子代理讀取與階段相關的 5–15 個程式碼庫檔案
3. **呈現假設** — 每條假設包含：
   - Claude 將做什麼以及原因（引用檔案路徑）
   - 若假設不正確會出現什麼問題
   - 置信度（確信 / 可能 / 不明確）
4. **確認或糾正** — 使用者審查假設，選擇需要修改的條目
5. **寫入 CONTEXT.md** — 與討論模式輸出格式完全相同

## 標誌相容性

| 標誌 | `discuss` 模式 | `assumptions` 模式 |
|------|----------------|-------------------|
| `--auto` | 自動選擇推薦答案 | 跳過確認步驟，自動解決"不明確"項 |
| `--batch` | 將問題分批分組 | 不適用（糾正已批次處理） |
| `--text` | 純文本問題（遠端會話） | 純文本問題（遠端會話） |
| `--analyze` | 每個問題顯示權衡表 | 不適用（假設已包含證據） |

## 輸出

兩種模式均生成包含相同六個章節的 `CONTEXT.md`：

- `<domain>` — 階段邊界
- `<decisions>` — 已鎖定的實現決策
- `<canonical_refs>` — 下游代理必須閱讀的規範/文件
- `<code_context>` — 可複用資產、規範、整合點
- `<specifics>` — 使用者參考和偏好
- `<deferred>` — 記錄供未來階段使用的想法

下游代理（researcher、planner、checker）以相同方式使用此檔案，無論由哪種模式生成。有關完整欄位參考，請參閱 [CONTEXT.md 結構說明](reference/context-md.md)。

## 相關資源

- [討論階段](how-to/discuss-a-phase.md) — 執行 `/gsd-discuss-phase` 的分步指南（支援兩種模式）。
- [CONTEXT.md 結構說明](reference/context-md.md) — 兩種模式所生成檔案的完整欄位參考。
- [階段迴圈](explanation/the-phase-loop.md) — 討論如何融入更廣泛的 討論 → 規劃 → 執行 → 驗證 → 釋出 迴圈。
- [文件索引](README.md) — GSD Core 文件的完整目錄。
