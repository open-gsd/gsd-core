# 上下文視窗監視器

一個後置工具鉤子（Claude Code 中的 `PostToolUse`，Gemini CLI 中的 `AfterTool`），當上下文視窗使用率較高時向 Agent 發出警告。

## 問題背景

狀態列向**使用者**展示上下文使用情況，但 **Agent** 本身並不感知上下文限制。當上下文剩餘量不足時，Agent 會持續工作直至觸及上限——可能在任務進行到一半、狀態尚未儲存時就被迫中斷。

## 工作原理

1. 狀態列鉤子將上下文指標寫入 `/tmp/claude-ctx-{session_id}.json`
2. 每次工具呼叫結束後，上下文監視器讀取這些指標
3. 當剩餘上下文低於閾值時，以 `additionalContext` 的形式注入警告
4. Agent 在對話中接收到警告後即可採取相應措施

## 閾值

| 級別 | 剩餘量 | Agent 行為 |
|-------|-----------|----------------|
| 正常 | > 35% | 無警告 |
| 警告 | <= 35% | 完成當前任務收尾，避免開啟新的複雜工作 |
| 嚴重 | <= 25% | 立即停止，儲存狀態（`/gsd-pause-work`） |

## 防抖機制

為避免反覆向 Agent 傳送重複警告：
- 首次警告始終立即觸發
- 後續警告需間隔 5 次工具呼叫才會再次觸發
- 嚴重級別升級（WARNING -> CRITICAL）可繞過防抖機制

## 架構

```
Statusline Hook (gsd-statusline.js)
    | writes
    v
/tmp/claude-ctx-{session_id}.json
    ^ reads
    |
Context Monitor (gsd-context-monitor.js, PostToolUse/AfterTool)
    | injects
    v
additionalContext -> Agent sees warning
```

中間橋接檔案是一個簡單的 JSON 物件：

```json
{
  "session_id": "abc123",
  "remaining_percentage": 28.5,
  "used_pct": 71,
  "timestamp": 1708200000
}
```

## 與 GSD 的整合

GSD 的 `/gsd-pause-work` 命令用於儲存執行狀態。WARNING 訊息建議使用該命令，CRITICAL 訊息則要求立即儲存狀態。

## 配置

兩個鉤子均在執行 `npx @opengsd/gsd-core` 安裝時自動註冊——正常情況下無需手動操作。有關鉤子配置詳情、閾值覆蓋以及手動註冊示例，請參閱[配置文件](CONFIGURATION.md)。

簡要參考：狀態列鉤子在 `settings.json` 中註冊為 `statusLine`；上下文監視器（`gsd-context-monitor.js`）註冊為 `PostToolUse` 鉤子（Gemini CLI 中為 `AfterTool`）。兩項配置均使用執行安裝程式時的 Node 執行檔絕對路徑。在 Windows PowerShell 中，需在帶引號的執行檔路徑前新增 `&` 字首。

## 安全性

- 鉤子對所有操作進行 try/catch 包裹，出錯時靜默退出
- 不會阻塞工具執行——監視器出現故障不應影響 Agent 的工作流程
- 過期指標（超過 60 秒）將被忽略
- 缺失的橋接檔案可被優雅處理（適用於子 Agent 及新會話）

---

## 相關文件

- [架構](ARCHITECTURE.md)
- [配置](CONFIGURATION.md)
- [文件索引](README.md)
