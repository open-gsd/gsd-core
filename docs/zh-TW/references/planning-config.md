<planning_config>

`.planning/` 目錄行為的配置選項。

<config_schema>
```json
"planning": {
  "commit_docs": true,
  "search_gitignored": false
},
"git": {
  "branching_strategy": "none",
  "phase_branch_template": "gsd/phase-{phase}-{slug}",
  "milestone_branch_template": "gsd/{milestone}-{slug}"
}
```

| 選項 | 預設值 | 描述 |
|--------|---------|-------------|
| `commit_docs` | `true` | 是否將規劃工件提交到 git |
| `search_gitignored` | `false` | 在廣泛 rg 搜尋中新增 `--no-ignore` |
| `git.branching_strategy` | `"none"` | Git 分支策略：`"none"`、`"phase"` 或 `"milestone"` |
| `git.phase_branch_template` | `"gsd/phase-{phase}-{slug}"` | 階段策略的分支模板 |
| `git.milestone_branch_template` | `"gsd/{milestone}-{slug}"` | 里程碑策略的分支模板 |
</config_schema>

<commit_docs_behavior>

**當 `commit_docs: true`（預設）：**
- 規劃檔案正常提交
- SUMMARY.md、STATE.md、ROADMAP.md 在 git 中跟蹤
- 規劃決策的完整歷史保留

**當 `commit_docs: false`：**
- 跳過 `.planning/` 檔案的所有 `git add`/`git commit`
- 使用者必須將 `.planning/` 新增到 `.gitignore`
- 適用於：OSS 貢獻、客戶專案、保持規劃私有

**使用 `gsd-tools.cjs query`（推薦）：**

```bash
# 提交時自動檢查 commit_docs + gitignore：
gsd-tools.cjs query commit "docs: update state" --files .planning/STATE.md

# 通過 state load 載入配置（返回 JSON）：
INIT=$(gsd-tools.cjs query state.load)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
# commit_docs 在 JSON 輸出中可用

# 或使用包含 commit_docs 的 init 命令：
INIT=$(gsd-tools.cjs query init.execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
# commit_docs 包含在所有 init 命令輸出中
```

**自動檢測：** 如果 `.planning/` 被 gitignore，無論 config.json 如何，`commit_docs` 自動為 `false`。這防止使用者在 `.gitignore` 中有 `.planning/` 時出現 git 錯誤。

**通過 CLI 提交（自動處理檢查）：**

```bash
gsd-tools.cjs query commit "docs: update state" --files .planning/STATE.md
```

CLI 在內部檢查 `commit_docs` 配置和 gitignore 狀態 —— 無需手動條件判斷。

</commit_docs_behavior>

<search_behavior>

**當 `search_gitignored: false`（預設）：**
- 標準 rg 行為（尊重 .gitignore）
- 直接路徑搜尋有效：`rg "pattern" .planning/` 找到檔案
- 廣泛搜尋跳過 gitignored：`rg "pattern"` 跳過 `.planning/`

**當 `search_gitignored: true`:**
- 在應該包含 `.planning/` 的廣泛 rg 搜尋中新增 `--no-ignore`
- 僅在搜尋整個倉庫並期望 `.planning/` 匹配時需要

**注意：** 大多數 GSD 操作使用直接檔案讀取或顯式路徑，無論 gitignore 狀態如何都有效。

</search_behavior>

<setup_uncommitted_mode>

使用未提交模式：

1. **設定配置：**
   ```json
   "planning": {
     "commit_docs": false,
     "search_gitignored": true
   }
   ```

2. **新增到 .gitignore：**
   ```
   .planning/
   ```

3. **已存在的跟蹤檔案：** 如果 `.planning/` 之前被跟蹤：
   ```bash
   git rm -r --cached .planning/
   git commit -m "chore: stop tracking planning docs"
   ```

4. **分支合併：** 當使用 `branching_strategy: phase` 或 `milestone` 時，`complete-milestone` 工作流在 `commit_docs: false` 時自動從暫存區移除 `.planning/` 檔案，然後才進行合併提交。

</setup_uncommitted_mode>

<branching_strategy_behavior>

**分支策略：**

| 策略 | 建立分支時機 | 分支範圍 | 合併點 |
|----------|---------------------|--------------|-------------|
| `none` | 從不 | N/A | N/A |
| `phase` | `execute-phase` 開始時 | 單個階段 | 階段後用戶手動合併 |
| `milestone` | 里程碑第一個 `execute-phase` | 整個里程碑 | `complete-milestone` 時 |

**當 `git.branching_strategy: "none"`（預設）：**
- 所有工作提交到當前分支
- 標準 GSD 行為

**當 `git.branching_strategy: "phase"`：**
- `execute-phase` 在執行前建立/切換到分支
- 分支名來自 `phase_branch_template`（如 `gsd/phase-03-authentication`）
- 所有計劃提交到該分支
- 階段完成後使用者手動合併分支
- `complete-milestone` 提供合併所有階段分支的選項

**當 `git.branching_strategy: "milestone"`：**
- 里程碑的第一個 `execute-phase` 建立里程碑分支
- 分支名來自 `milestone_branch_template`（如 `gsd/v1.0-mvp`）
- 里程碑中所有階段提交到同一分支
- `complete-milestone` 提供將里程碑分支合併到 main 的選項

**模板變數：**

| 變數 | 可用於 | 描述 |
|----------|--------------|-------------|
| `{phase}` | phase_branch_template | 零填充階段號（如 "03"） |
| `{slug}` | 兩者 | 小寫、連字元名稱 |
| `{milestone}` | milestone_branch_template | 里程碑版本（如 "v1.0"） |

**檢查配置：**

使用 `init execute-phase` 返回所有配置為 JSON：
```bash
INIT=$(gsd-tools.cjs query init.execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
# JSON 輸出包含：branching_strategy, phase_branch_template, milestone_branch_template
```

或使用 `state load` 獲取配置值：
```bash
INIT=$(gsd-tools.cjs query state.load)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
# 從 JSON 解析 branching_strategy, phase_branch_template, milestone_branch_template
```

**分支建立：**

```bash
# 階段策略
if [ "$BRANCHING_STRATEGY" = "phase" ]; then
  PHASE_SLUG=$(echo "$PHASE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  BRANCH_NAME=$(echo "$PHASE_BRANCH_TEMPLATE" | sed "s/{phase}/$PADDED_PHASE/g" | sed "s/{slug}/$PHASE_SLUG/g")
  git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
fi

# 里程碑策略
if [ "$BRANCHING_STRATEGY" = "milestone" ]; then
  MILESTONE_SLUG=$(echo "$MILESTONE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  BRANCH_NAME=$(echo "$MILESTONE_BRANCH_TEMPLATE" | sed "s/{milestone}/$MILESTONE_VERSION/g" | sed "s/{slug}/$MILESTONE_SLUG/g")
  git checkout -b "$BRANCH_NAME" 2>/dev/null || git checkout "$BRANCH_NAME"
fi
```

**complete-milestone 時的合併選項：**

| 選項 | Git 命令 | 結果 |
|--------|-------------|--------|
| Squash 合併（推薦） | `git merge --squash` | 每個分支單個乾淨提交 |
| 帶歷史合併 | `git merge --no-ff` | 保留所有單獨提交 |
| 不合並直接刪除 | `git branch -D` | 丟棄分支工作 |
| 保留分支 | （無） | 後續手動處理 |

推薦 Squash 合併 —— 保持 main 分支歷史乾淨，同時在分支中保留完整開發歷史（直到刪除）。

**使用場景：**

| 策略 | 最適合 |
|----------|----------|
| `none` | 獨立開發、簡單專案 |
| `phase` | 每階段程式碼審查、細粒度回滾、團隊協作 |
| `milestone` | 釋出分支、預釋出環境、每個版本一個 PR |

</branching_strategy_behavior>

</planning_config>