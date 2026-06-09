# 如何使用工作區隔離工作

**目標：** 建立一個完全隔離的 GSD 環境——獨立的 git worktree、獨立的 `.planning/` 根目錄，以及可選的多倉庫支援——適用於功能分支或多倉庫工作場景。

**前提條件：** 已安裝 `git` 且倉庫支援 worktree。對於多倉庫工作區，目標倉庫需存在於本地或可通過路徑訪問。

---

## 什麼是工作區

工作區是一個自包含的環境，將一個或多個 git worktree（或克隆）與獨立的 `.planning/` 根目錄配對。每個工作區包含：

- 獨立的 `.planning/` 目錄，**完全獨立**於源倉庫的 `.planning/`——並非其子目錄
- 獨立的 `WORKSPACE.md` 清單檔案，用於跟蹤成員倉庫
- git worktree（預設）或指定倉庫的完整克隆，在專用分支上檢出（預設：`workspace/<name>`）

工作區預設存放在 `~/gsd-workspaces/<name>/` 下。

```
~/gsd-workspaces/
└── feature-b/
    ├── WORKSPACE.md        ← 清單檔案
    ├── .planning/          ← 完全獨立的 GSD 狀態
    │   ├── PROJECT.md
    │   ├── ROADMAP.md
    │   └── ...
    ├── hr-ui/              ← hr-ui 倉庫的 worktree 或克隆
    └── ZeymoAPI/           ← ZeymoAPI 倉庫的 worktree 或克隆
```

由於工作區的 `.planning/` 與源倉庫相互獨立，不會與源倉庫中已有的規劃狀態發生重疊或衝突。

---

## 為多個倉庫建立工作區

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
```

GSD 會在 `~/gsd-workspaces/feature-b/` 中建立 `hr-ui` 和 `ZeymoAPI` 的 worktree，在每個倉庫中檢出 `workspace/feature-b` 分支，寫入 `WORKSPACE.md`，並建立一個空的 `.planning/` 目錄，準備好供 `/gsd-new-project` 使用。

自定義位置：

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI --path /projects/feature-b
```

---

## 為當前倉庫建立工作區

當你需要在單個倉庫上進行功能分支隔離——獨立分支、獨立 `.planning/`、不受 main 分支狀態影響時：

```bash
/gsd-workspace --new --name payments-rework --repos .
```

`.` 表示為當前倉庫建立 worktree，該 worktree 會在 `workspace/payments-rework` 分支上檢出。

若要強制使用完整克隆而非 worktree：

```bash
/gsd-workspace --new --name payments-rework --repos . --strategy clone
```

---

## 顯式指定分支

```bash
/gsd-workspace --new --name payments-rework --repos . --branch feature/payments-v2
```

`--branch` 標誌為工作區中所有倉庫設定分支名稱，預設為 `workspace/<name>`。

---

## 跳過互動式詢問

```bash
/gsd-workspace --new --name payments-rework --repos . --auto
```

GSD 將接受所有預設值，無需提示確認。

---

## 在工作區內初始化 GSD

建立工作區後，進入工作區目錄並初始化 GSD 專案：

```bash
cd ~/gsd-workspaces/feature-b
/gsd-new-project
```

工作區內的 `.planning/` 目錄是從該目錄執行所有後續 GSD 命令的根目錄。它與源倉庫中存在的任何 `.planning/` 完全獨立。

---

## 列出工作區

```bash
/gsd-workspace --list
```

列印所有活躍的 GSD 工作區及其狀態。

---

## 刪除工作區

```bash
/gsd-workspace --remove feature-b
```

GSD 會移除 git worktree 並清理工作區目錄。此操作不會從遠端倉庫刪除分支——僅刪除本地 worktree 和工作區目錄。

---

## 何時使用工作區而非工作流

選擇工作區的場景：

- 你需要跨**多個倉庫**協同工作，且這些倉庫需要在同一個 GSD 專案下進行協調（例如，一個 API 倉庫和一個 UI 倉庫需要一起釋出）
- 你需要每個功能擁有**獨立的 git worktree**，帶有各自的分支、鎖檔案和構建產物——以確保一個環境中的構建和依賴安裝不會影響另一個環境
- 你希望擁有**完全獨立的 `.planning/` 根目錄**，而非主倉庫 `.planning/` 的子目錄
- 你正在採用 Issue 驅動的工作流，將每個跟蹤器 Issue 對映到一個工作區（參見[從跟蹤器 Issue 驅動 GSD](drive-gsd-from-a-tracker-issue.md)）

選擇[工作流](work-in-parallel-with-workstreams.md)的場景：

- 所有工作都在**單一倉庫**中進行，共享相同的 git 歷史
- 你希望在不同關注領域（API、UI、基礎設施）上併發執行 `/gsd-plan-phase` 或 `/gsd-discuss-phase`，且各自的 `STATE.md` 檔案之間互不干擾
- 你不需要每個關注領域擁有獨立的 worktree；切換規劃上下文即可滿足需求

---

## 相關內容

- [使用工作流並行工作](work-in-parallel-with-workstreams.md)
- [從跟蹤器 Issue 驅動 GSD](drive-gsd-from-a-tracker-issue.md)
- [命令](../COMMANDS.md)
- [文件索引](../README.md)
