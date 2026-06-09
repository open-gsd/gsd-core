# Git 規劃提交

通過 `gsd-tools.cjs query commit` 提交規劃工件，它會自動檢查 `commit_docs` 配置和 gitignore 狀態（與舊版 `gsd-tools.cjs commit` 行為相同）。

## 通過 CLI 提交

先傳提交說明，然後用 `--files` 顯式傳入檔案路徑。`commit` 與 `commit-to-subrepo` 都應使用 `--files` 來宣告要提交的路徑。

對 `.planning/` 檔案始終使用此方式 —— 它會自動處理 `commit_docs` 與 gitignore 檢查：

```bash
gsd-tools.cjs query commit "docs({scope}): {description}" --files .planning/STATE.md .planning/ROADMAP.md
```

如果 `commit_docs` 為 `false` 或 `.planning/` 被 gitignore，CLI 會返回 `skipped`（帶原因）。無需手動條件檢查。

## 修改上次提交

將 `.planning/` 檔案變更合併到上次提交：

```bash
gsd-tools.cjs query commit "" --files .planning/codebase/*.md --amend
```

## 提交訊息模式

| 命令 | 範圍 | 示例 |
|------|------|------|
| plan-phase | phase | `docs(phase-03): create authentication plans` |
| execute-phase | phase | `docs(phase-03): complete authentication phase` |
| new-milestone | milestone | `docs: start milestone v1.1` |
| remove-phase | chore | `chore: remove phase 17 (dashboard)` |
| insert-phase | phase | `docs: insert phase 16.1 (critical fix)` |
| add-phase | phase | `docs: add phase 07 (settings page)` |

## 何時跳過

- config 中 `commit_docs: false`
- `.planning/` 被 gitignore
- 無變更可提交（用 `git status --porcelain .planning/` 檢查）
