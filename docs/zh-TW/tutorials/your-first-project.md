# 你的第一個專案

在本教程中，你將安裝 GSD Core 並從頭構建一個小型命令列待辦事項應用——一個階段、一個 PR、完整的流程迴圈。完成後，你將至少執行過核心階段迴圈中的每一條命令一次，並看到每條命令所生成的規劃產物。

---

## 你將構建什麼

一個 Node.js CLI 工具，支援新增、列出和完成儲存在本地 JSON 檔案中的待辦事項。它足夠小，可以在一次會話中完成，且僅使用 Node.js 標準庫，無需安裝任何額外依賴。

---

## 前提條件

- **Node.js 18 或更高版本** — `node --version` 應列印 `v18.x.x` 或更高版本。
- **Claude Code** — 在你想使用的專案目錄中開啟。
- 初次安裝需要網路連線。

不需要其他工具。GSD Core 本身將在下一步安裝。

---

## 第 1 步 — 安裝 GSD Core

在專案目錄中開啟終端並執行：

```bash
npx @opengsd/gsd-core@latest
```

安裝程式會詢問你使用的 AI 程式設計執行時，以及是全域性安裝還是安裝到當前專案。現在選擇 **Claude Code** 和**本地安裝**（僅此專案）。

你將看到類似如下的輸出：

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

注意專案中現在存在一個 `.claude/` 目錄。這是 GSD Core 的命令和代理所在的位置。

> 為什麼選本地而不是全域性？本地安裝可將技能版本固定到該專案。如需全域性安裝，請參閱 [在你的執行時上安裝](../how-to/install-on-your-runtime.md)。

---

## 第 2 步 — 以許可權模式啟動 Claude Code

GSD Core 會生成讀寫檔案的子代理。以許可權標誌啟動 Claude Code，這樣它就不會在每次檔案操作時暫停詢問：

```bash
claude --dangerously-skip-permissions
```

你將進入專案目錄中的 Claude Code 提示符。

---

## 第 3 步 — 建立專案

在 Claude Code 提示符處輸入以下斜槓命令：

```text
/gsd-new-project
```

GSD Core 將開啟一段對話。它首先提問：

```text
What do you want to build?
```

輸入類似以下內容：

```text
A Node.js CLI tool for managing to-do items. Users run `todo add "buy milk"`,
`todo list`, and `todo done 1`. Items are saved to a local todos.json file.
No external dependencies — Node built-ins only.
```

GSD Core 會繼續提出幾個澄清性問題。自然地回答即可。它在撰寫任何計劃之前，正在瞭解你的關注點。

問題結束後，它會提議進行領域調研。對於如此小的專案，你可以跳過調研——在提示時選擇**跳過調研**。

GSD Core 隨後會要求你選擇工作流設定（模式、粒度、調研代理）。每項均選擇推薦的預設值。這些設定將寫入 `.planning/config.json`。

最後，一個路線圖子代理開始執行（你會看到"Spawning roadmapper…"的提示——這是正常的，大約需要一分鐘）。返回後，GSD Core 會展示一份路線圖提案。對於單階段專案，它看起來類似：

```text
Proposed Roadmap

1 phase | 4 requirements mapped | All v1 requirements covered ✓

| # | Phase              | Goal                                    | Requirements      |
|---|--------------------|-----------------------------------------|-------------------|
| 1 | Core CLI           | add / list / done commands, todos.json  | CLI-01 … CLI-04   |
```

輸入 **Approve** 以接受路線圖。

**`.planning/` 中建立的內容：**

```text
.planning/
  PROJECT.md          ← 你的專案描述和需求
  REQUIREMENTS.md     ← 每個 v1 功能的 REQ-ID
  ROADMAP.md          ← 第 1 階段，狀態：待處理
  STATE.md            ← 會話記憶，當前位置
  config.json         ← 工作流設定
```

現在開啟 `.planning/ROADMAP.md` 並閱讀。注意第 1 階段有目標、必須滿足的需求列表和成功標準——這些是執行必須交付的可觀測行為。

---

## 第 4 步 — 清除上下文並討論第 1 階段

GSD Core 的設計圍繞全新的上下文。在每個階段之前清除主會話視窗：

```text
/clear
```

然後開始第 1 階段的討論：

```text
/gsd-discuss-phase 1
```

GSD Core 讀取階段目標並詢問你的實現偏好。這些決定將影響*如何*構建，而不僅僅是*構建什麼*。示例交流：

```text
> How should done items be stored — mark them in place or move them?
  Mark them in place with a "done" flag.

> Should `todo list` show completed items by default?
  No, hide them unless --all is passed.

> Error format when todos.json doesn't exist yet?
  Create it silently on first add.
```

討論結束後，GSD Core 會寫入：

```text
.planning/phases/01-core-cli/CONTEXT.md
```

開啟該檔案。你會看到一個 `## Implementation Decisions` 章節，準確記錄了你所說的內容。規劃器讀取該檔案——因此你在此處做出的決定將貫穿到每個任務計劃中。

---

## 第 5 步 — 規劃第 1 階段

```text
/gsd-plan-phase 1
```

四個調研子代理並行展開工作（你會看到"Spawning 4 researchers…"的提示）。這需要 1–5 分鐘，請勿中斷。

返回後，規劃器讀取 CONTEXT.md 和調研結果，建立原子任務計劃。然後，計劃檢查器在儲存之前驗證每個計劃是否實現了階段目標。

**建立的內容：**

```text
.planning/phases/01-core-cli/
  RESEARCH.md         ← 領域調研結果
  01-01-PLAN.md       ← 任務：建立 todos.json 讀寫助手
  01-02-PLAN.md       ← 任務：實現 add / list / done 命令
```

開啟 `01-01-PLAN.md`。你會看到一個 `<task>` 塊，包含名稱、涉及的檔案、操作步驟、驗證命令和完成條件。注意 `<verify>` 標籤——GSD Core 的執行器將在寫入程式碼後執行該命令。

---

## 第 6 步 — 執行第 1 階段

```text
/gsd-execute-phase 1
```

GSD Core 將計劃分組為波次（獨立計劃並行執行），為每個計劃生成一個全新的 200k 上下文執行器，並原子性地提交每個任務。

你將看到類似如下內容：

```text
Wave 1 (parallel):
  [Executor A] → 01-01-PLAN.md (read/write helpers)   ✓ committed
  [Executor B] → 01-02-PLAN.md (CLI commands)          ✓ committed

[Verifier] Checking codebase against phase goals...
  CLI-01 todo add   ✓
  CLI-02 todo list  ✓
  CLI-03 todo done  ✓
  CLI-04 --all flag ✓
  Status: PASS
```

**建立的內容：**

```text
.planning/phases/01-core-cli/
  01-01-SUMMARY.md    ← 執行器 A 構建並提交的內容
  01-02-SUMMARY.md    ← 執行器 B 構建並提交的內容
  VERIFICATION.md     ← REQ 覆蓋情況：PASS
```

現在執行你的 CLI：

```bash
node todo.js add "buy milk"
node todo.js add "write tests"
node todo.js list
node todo.js done 1
node todo.js list
```

你應該看到條目出現，並且在標記完成後，條目 1 從預設列表中消失。這是 GSD Core 交付的你的第一個可見結果。

---

## 第 7 步 — 驗證工作

```text
/gsd-verify-work 1
```

GSD Core 提取階段的成功標準並逐一引導你完成：

```text
[1/3] Can you run `node todo.js add "buy milk"` without errors?
> yes

[2/3] Does `node todo.js list` show only incomplete items by default?
> yes

[3/3] Does `node todo.js done 1` mark item 1 complete and hide it from the default list?
> yes

All 3 checks passed. Phase 1 verified.
```

如果任何檢查失敗，GSD Core 會診斷根本原因並建立修復計劃。再次執行 `/gsd-execute-phase 1` 應用修復，然後重新執行 `/gsd-verify-work 1`。

**建立的內容：**

```text
.planning/phases/01-core-cli/UAT.md   ← 所有檢查及其結果
```

---

## 第 8 步 — 釋出

```text
/gsd-ship 1
```

GSD Core 使用自動生成的正文建立拉取請求。PR 正文始終包含：摘要、變更內容、已解決的需求、驗證情況和關鍵決策。

你將看到：

```text
Pull request created: https://github.com/your-org/your-repo/pull/1

Title: feat(phase-1): core CLI — add / list / done commands
```

這就是完整的流程——從想法到合併 PR——一個階段。

---

## 你學到了什麼

- 如何使用 `npx @opengsd/gsd-core@latest` 安裝 GSD Core。
- `/gsd-new-project` 如何將一段對話轉化為由 `.planning/` 產物支撐的路線圖。
- `/gsd-discuss-phase` 如何在任何規劃開始之前捕獲實現決策。
- `/gsd-plan-phase` 如何生成並行調研器併產出原子任務計劃。
- `/gsd-execute-phase` 如何以並行波次執行這些計劃並提交每個任務。
- `/gsd-verify-work` 如何引導完成成功標準並在需要時生成修復計劃。
- `/gsd-ship` 如何將已驗證的階段轉化為拉取請求。

對於多階段專案，對每個階段重複第 4–8 步，然後執行 `/gsd-progress --next`，讓 GSD Core 自動檢測下一步。

---

## 相關資源

- [階段迴圈](../explanation/the-phase-loop.md) — 迴圈為何如此設計
- [操作指南](../README.md#how-to-guides) — 針對特定情況的任務型操作說明
- [接入現有程式碼庫](onboarding-an-existing-codebase.md) — 將 GSD Core 引入棕地倉庫
