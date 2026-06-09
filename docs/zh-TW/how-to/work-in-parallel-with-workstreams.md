# 如何通過工作流並行處理多個領域

**目標：** 併發推進不同里程碑領域（後端 API、前端儀表板、基礎設施或其他關注點）的工作，同時避免一個領域的規劃狀態汙染另一個領域。

**前提條件：** 已啟用的 GSD Core 專案（`.planning/ROADMAP.md` 存在）。若尚未建立，請先執行 `/gsd-new-project`。

---

## 什麼是工作流

工作流是單一程式碼庫內部的隔離規劃上下文。每個工作流擁有獨立的 `.planning/workstreams/<name>/` 子樹，其中包含獨立的 `STATE.md`、`ROADMAP.md`、`REQUIREMENTS.md` 以及 `phases/` 目錄。程式碼庫本身——原始碼、git 歷史記錄和分支——在所有工作流之間共享。

```
.planning/
├── PROJECT.md          ← shared
├── config.json         ← shared
├── codebase/           ← shared
└── workstreams/
    ├── backend-api/
    │   ├── STATE.md
    │   ├── ROADMAP.md
    │   ├── REQUIREMENTS.md
    │   └── phases/
    └── frontend-dash/
        ├── STATE.md
        ├── ROADMAP.md
        ├── REQUIREMENTS.md
        └── phases/
```

當某個工作流處於啟用狀態時，所有 GSD 命令——`/gsd-progress`、`/gsd-discuss-phase`、`/gsd-plan-phase`、`/gsd-execute-phase`——都將從該工作流的目錄讀取並寫入。切換工作流會將所有這些命令重定向到另一個子樹，而不會影響原始碼樹。

---

## 建立工作流

```bash
/gsd-workstreams create backend-api
```

GSD 會在 `.planning/workstreams/backend-api/` 下建立工作流目錄，並初始化一個框架 `STATE.md` 和 `ROADMAP.md`。工作流不會自動啟用——需要顯式切換。

---

## 列出工作流

```bash
/gsd-workstreams list
```

顯示所有工作流，以及當前會話中哪個工作流處於啟用狀態。

---

## 切換到某個工作流

```bash
/gsd-workstreams switch backend-api
```

從此時起，所有 GSD 工作流命令均在 `backend-api` 上下文中執行。切換是會話範圍的：當多個 Claude Code 終端同時開啟同一倉庫時，每個會話可以持有不同的啟用工作流，互不干擾。

切換後，按正常階段工作流推進：

```bash
/gsd-discuss-phase 1
/gsd-plan-phase 1
/gsd-execute-phase 1
/gsd-verify-work 1
```

如需在另一個領域工作，在第二個終端中切換工作流：

```bash
/gsd-workstreams switch frontend-dash
/gsd-discuss-phase 1
/gsd-plan-phase 1
```

---

## 檢視所有工作流的進度

```bash
/gsd-workstreams progress
```

列印跨工作流摘要——每個工作流的階段狀態、當前位置和未完成工作——無需在工作流之間來回切換。

檢視單個工作流的詳細狀態：

```bash
/gsd-workstreams status backend-api
```

---

## 在工作流中恢復工作

在上下文重置或新會話後，恢復您的位置：

```bash
/gsd-workstreams resume backend-api
```

此命令會啟用該工作流並恢復上次已知位置，等價於切換後再執行 `/gsd-resume-work`。

---

## 歸檔已完成的工作流

當某個工作流的里程碑工作完成時：

```bash
/gsd-workstreams complete backend-api
```

GSD 會將該工作流標記為已歸檔，並將其從活躍列表中移出。規劃產物將保留在 `.planning/workstreams/backend-api/` 下以供審計。

---

## 在不切換工作流的情況下將單條命令定向到特定工作流

如需對某個特定工作流執行一條命令，而不更改當前會話的啟用上下文，請使用 `--ws` 標誌：

```bash
/gsd-progress --ws frontend-dash
/gsd-plan-phase 2 --ws backend-api
```

`--ws` 在解析順序中具有最高優先順序，不會更改會話範圍的指標。

---

## 何時選擇工作流而非工作區

在以下情況下選擇工作流：

- 所有工作都位於**同一倉庫**並共享相同的 git 歷史記錄
- 您希望**併發**規劃或討論不同關注領域（API、UI、基礎設施），而不讓一個工作流的 `STATE.md` 覆蓋另一個的
- 建立時不需要為每個工作流單獨建立分支（當然，您仍可在每個工作流的執行過程中正常建立分支）
- 建立完整 git worktree 的開銷與所需隔離程度不匹配

在以下情況下選擇[工作區](isolate-work-with-workspaces.md)：

- 您需要在**多個倉庫**之間工作（例如 `hr-ui` 和 `ZeymoAPI`）
- 每個功能需要**獨立 git worktree** 或克隆的隔離——完全獨立的分支、鎖檔案和構建產物
- 您希望在每個工作區中獨立執行 `/gsd-new-project`，擁有完全獨立的 `.planning/` 根目錄，而不是主倉庫 `.planning/` 的子目錄

---

## 相關文件

- [用工作區隔離工作](isolate-work-with-workspaces.md)
- [階段迴圈](../explanation/the-phase-loop.md)
- [命令](../COMMANDS.md)
- [文件索引](../README.md)
