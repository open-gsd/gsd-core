# GSD Core 命令參考

> GSD Core 命令參考手冊 — 所有穩定命令的語法、標誌、選項及示例。功能詳情請參閱[功能參考](FEATURES.md)；工作流程演示請參閱[使用者指南](USER-GUIDE.md)；文件索引請參閱 [README](README.md)。

---

## 命令語法

- **Claude Code / Copilot / OpenCode / Kilo：** `/gsd-command-name [args]`（連字元形式）
- **Gemini CLI：** `/gsd:command-name [args]`（冒號形式 — Gemini 將命令置於 `gsd:` 名稱空間下）
- **Codex：** `$gsd-command-name [args]`

連字元形式與冒號形式是*同一命令在不同執行時中的拼寫方式*。無論使用哪種執行時，安裝程式都會將正確的形式寫入該執行時的命令目錄。

---

## 名稱空間元技能

v1.40 中，六個名稱空間路由器作為第一階段入口點隨附釋出。與平鋪式 86 個技能列表（約 2150 個 token）相比，它們將預載入技能列表的 token 開銷保持在較低水平（6 個路由器約 120 個 token），同時完整功能仍可直接呼叫。模型先選擇名稱空間，再路由到具體子技能。詳見 [#2792](https://github.com/open-gsd/gsd-core/issues/2792)。

| 命令 | 路由至 |
|---------|-----------|
| `/gsd-workflow` | 階段流水線 — discuss / plan / execute / verify / phase / progress |
| `/gsd-project` | 專案生命週期 — 里程碑、審計、摘要 |
| `/gsd-quality` | 品質關卡 — 程式碼審查、除錯、審計、安全、評估、介面 |
| `/gsd-context` | 程式碼庫智慧 — 對映、圖譜、文件、學習記錄 |
| `/gsd-manage` | 管理 — 配置、工作區、工作流、執行緒、更新、釋出、收件箱 |
| `/gsd-ideate` | 探索與捕捉 — 探索、草圖、實驗、規格、捕捉 |

名稱空間技能是**疊加式**的 — 每個現有的具體命令（例如 `/gsd-plan-phase`、`/gsd-code-review --fix`）仍可直接呼叫。

---

## 核心工作流命令

### `/gsd-new-project`

通過深度上下文收集初始化新專案。

| 標誌 | 描述 |
|------|-------------|
| `--auto @file.md` | 從文件中自動提取，跳過互動式問題 |

**前提條件：** 不存在 `.planning/PROJECT.md`
**產出：** `PROJECT.md`、`REQUIREMENTS.md`、`ROADMAP.md`、`STATE.md`、`config.json`、`research/`、`CLAUDE.md`

```bash
/gsd-new-project                    # 互動模式
/gsd-new-project --auto @prd.md     # 從 PRD 自動提取
```

---

### `/gsd-workspace`

管理 GSD 工作區 — 建立、列出或移除隔離的工作區環境，包含倉庫副本和獨立的 `.planning/` 目錄。

| 標誌 | 描述 |
|------|-------------|
| `--new` | 建立新工作區（與 `--name`、`--repos` 等配合使用） |
| `--list` | 列出活動的 GSD 工作區及其狀態 |
| `--remove <name>` | 移除工作區並清理 git 工作樹 |
| `--name <name>` | 工作區名稱（與 `--new` 配合使用） |
| `--repos repo1,repo2` | 逗號分隔的倉庫路徑或名稱（與 `--new` 配合使用） |
| `--path /target` | 目標目錄（預設：`~/gsd-workspaces/<name>`） |
| `--strategy worktree\|clone` | 複製策略（預設：`worktree`） |
| `--branch <name>` | 要檢出的分支（預設：`workspace/<name>`） |
| `--auto` | 跳過互動式問題 |

**使用場景：**
- 多倉庫：在隔離的 GSD 狀態下處理倉庫子集
- 功能隔離：`--repos .` 為當前倉庫建立工作樹

**產出：** `WORKSPACE.md`、`.planning/`、倉庫副本（工作樹或克隆）

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
/gsd-workspace --new --name feature-b --repos . --strategy worktree  # 同倉庫隔離
/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

### `/gsd-discuss-phase`

在規劃前通過自適應提問收集階段上下文。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 階段編號（預設為當前階段） |

| 標誌 | 描述 |
|------|-------------|
| `--all` | 跳過領域選擇 — 互動式討論所有灰色地帶（不自動推進） |
| `--auto` | 自動為所有問題選擇推薦的預設值 |
| `--batch` | 將問題分組批次輸入，而非逐條處理 |
| `--analyze` | 在討論期間新增權衡分析 |
| `--power` | 基於檔案的批次問題解答，從預先準備的答案檔案中讀取 |
| `--assumptions` | 無需互動會話，直接呈現 Claude 對該階段實現的假設 |

**前提條件：** `.planning/ROADMAP.md` 已存在
**產出：** `{phase}-CONTEXT.md`、`{phase}-DISCUSSION-LOG.md`（審計追蹤）

```bash
/gsd-discuss-phase 1                # 階段 1 的互動式討論
/gsd-discuss-phase 1 --all          # 不經選擇步驟討論所有灰色地帶
/gsd-discuss-phase 3 --auto         # 自動為階段 3 選擇預設值
/gsd-discuss-phase --batch          # 當前階段的批次模式
/gsd-discuss-phase 2 --analyze      # 含權衡分析的討論
/gsd-discuss-phase 1 --power        # 從檔案批次解答
/gsd-discuss-phase 3 --assumptions  # 在規劃前呈現 Claude 的假設
```

---

### `/gsd-ui-phase`

為前端階段生成 UI 設計契約。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 階段編號（預設為當前階段） |

**前提條件：** `.planning/ROADMAP.md` 已存在，該階段包含前端/UI 工作
**產出：** `{phase}-UI-SPEC.md`

```bash
/gsd-ui-phase 2                     # 階段 2 的設計契約
```

---

### `/gsd-plan-phase`

研究、規劃並驗證一個階段。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 階段編號（預設為下一個未規劃的階段） |

| 標誌 | 描述 |
|------|-------------|
| `--auto` | 跳過互動式確認 |
| `--research` | 即使 RESEARCH.md 已存在也強制重新研究 |
| `--skip-research` | 跳過領域研究步驟 |
| `--research-phase <N>` | 僅研究模式：為階段 `<N>` 生成研究報告，寫入 RESEARCH.md 後退出，不進入規劃器。取代已刪除的獨立研究命令（#3042）。 |
| `--view` | 僅研究模式修飾符：與 `--research-phase` 配合使用時，將現有 RESEARCH.md 列印到標準輸出並退出（不生成新報告）。RESEARCH.md 不存在時報錯。 |
| `--gaps` | 差距閉合模式（讀取 VERIFICATION.md，跳過研究） |
| `--skip-verify` | 跳過計劃檢查器驗證迴圈 |
| `--prd <file>` | 使用 PRD 檔案而非 discuss-phase 獲取上下文 |
| `--ingest <path-or-glob>` | 使用 ADR 檔案代替 discuss-phase 進行上下文綜合 |
| `--ingest-format <auto\|nygard\|madr\|narrative>` | `--ingest` 的可選 ADR 解析器格式覆蓋 |
| `--reviews` | 根據 REVIEWS.md 中的跨 AI 審查反饋重新規劃 |
| `--validate` | 在規劃開始前執行狀態驗證 |
| `--bounce` | 規劃完成後執行外部計劃彈回驗證（使用 `workflow.plan_bounce_script`） |
| `--skip-bounce` | 即使配置中已啟用也跳過計劃彈回 |
| `--mvp` | 垂直 MVP 模式 — 規劃器將任務組織為功能切片（UI→API→DB），而非水平分層。在無先前階段摘要的新專案第 1 階段使用時，還會生成 `SKELETON.md`（行走骨架）。可通過在 ROADMAP.md 中設定 `**Mode:** mvp` 持久化應用於某階段，屆時無需標誌即可自動應用 `--mvp`。 |
| `--tdd` | TDD 模式 — 規劃器對符合條件的行為新增任務應用 `type: tdd`，使每個任務以失敗測試開始。可與 `--mvp` 組合：`--mvp --tdd` 產生每個行為新增任務以紅-綠流程開始的垂直切片。 |

**前提條件：** `.planning/ROADMAP.md` 已存在
**產出：** `{phase}-RESEARCH.md`、`{phase}-{N}-PLAN.md`、`{phase}-VALIDATION.md`；行走骨架模式觸發時產出 `{phase}/SKELETON.md`

**僅研究模式（`--research-phase <N>`）：**
- 無修飾符：如果 RESEARCH.md 已存在，提示 `update / view / skip`。
- 加 `--research`：強制重新整理 — 無條件重新生成，不提示。
- 加 `--view`：將現有 RESEARCH.md 列印到標準輸出，不生成新報告。RESEARCH.md 不存在時報錯。

**包合法性檢查門（v1.42.1）：**
當研究者推薦外部包時，會對每個包執行 `slopcheck install <pkg> --json` 並在 RESEARCH.md 中寫入 `## Package Legitimacy Audit` 表格，記錄登錄檔、年齡、下載量、原始碼倉庫和 slopcheck 裁決。裁決結果：

- `[SLOP]` — 包從 RESEARCH.md 中完全移除，永遠不會進入規劃器
- `[SUS]` — 包被標記；規劃器在安裝任務前插入 `checkpoint:human-verify`
- `[OK]` — 包已批准，不新增檢查點

來自 WebSearch 的包被標記為 `[ASSUMED]`（而非 `[VERIFIED]`），處理方式與 `[SUS]` 相同 — 安裝前需要人工檢查點。如果無法安裝 `slopcheck`，所有推薦的包都會被標記為 `[ASSUMED]` 並加以限制。

完整的檢查點格式、裁決表和故障排除，請參閱[使用者指南中的包合法性檢查門](USER-GUIDE.md#package-legitimacy-gate-v1421)。

```bash
/gsd-plan-phase 1                              # 研究 + 規劃 + 驗證階段 1
/gsd-plan-phase 3 --skip-research              # 無需研究直接規劃（熟悉的領域）
/gsd-plan-phase --auto                         # 非互動式規劃
/gsd-plan-phase 2 --validate                   # 規劃前驗證狀態
/gsd-plan-phase 1 --bounce                     # 規劃 + 外部彈回驗證
/gsd-plan-phase 2 --ingest docs/adr/0010.md   # 使用 ADR 快速通道進行上下文綜合
/gsd-plan-phase 2 --ingest 'docs/adr/00*.md' --ingest-format auto
/gsd-plan-phase --research-phase 4             # 僅研究階段 4（RESEARCH.md 存在時提示）
/gsd-plan-phase --research-phase 4 --view      # 列印現有 RESEARCH.md，不生成新報告
/gsd-plan-phase --research-phase 4 --research  # 強制重新整理研究，不提示
/gsd-plan-phase 1 --mvp                        # 階段 1 的垂直切片規劃
/gsd-plan-phase 1 --mvp --tdd                  # 垂直切片 + 每個行為新增任務以失敗測試開始
```

---

### `/gsd-plan-review-convergence`

跨 AI 計劃收斂迴圈 — 根據審查反饋重新規劃，直到沒有 HIGH 級別問題為止。執行 `plan-phase → review → replan → re-review` 迴圈（預設最多 3 個迴圈）。為規劃和審查生成隔離代理；編排器處理迴圈控制、HIGH 問題計數、停滯檢測和升級。

| 引數 / 標誌 | 必填 | 描述 |
|-----------------|----------|-------------|
| `N` | **是** | 要規劃和審查的階段編號 |
| `--codex` / `--gemini` / `--claude` / `--opencode` | 否 | 單一審查者選擇 |
| `--all` | 否 | 並行執行所有已配置的審查者 |
| `--max-cycles N` | 否 | 覆蓋迴圈上限（預設 3） |

**退出行為：** HIGH 計數歸零時迴圈退出。停滯檢測在 HIGH 計數在各迴圈間未減少時發出警告。當達到 `--max-cycles` 且仍有 HIGH 問題未解決時，升級門詢問使用者是繼續還是手動審查。

```bash
/gsd-plan-review-convergence 3                    # 預設審查者，3 個迴圈
/gsd-plan-review-convergence 3 --codex            # 僅 Codex 審查
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

---

### `/gsd-ultraplan-phase`

**[測試版]** 將階段規劃解除安裝到 Claude Code 的 ultraplan 雲端；在瀏覽器中審查並匯入回來。計劃在遠端起草，終端保持空閒；在瀏覽器中審查內聯評論，然後通過 `/gsd-import` 將最終計劃匯入 `.planning/`。

| 標誌 | 必填 | 描述 |
|------|----------|-------------|
| `N` | **是** | 要遠端規劃的階段編號 |

**隔離性：** 有意與 `/gsd-plan-phase` 分開，以防上游 ultraplan 變更影響核心規劃流水線。

```bash
/gsd-ultraplan-phase 4                  # 解除安裝階段 4 的規劃
```

---

### `/gsd-execute-phase`

通過基於波次的並行化執行階段中的所有計劃，或執行特定波次。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | **是** | 要執行的階段編號 |
| `--wave N` | 否 | 僅執行階段中的第 `N` 波 |
| `--validate` | 否 | 在執行開始前執行狀態驗證 |
| `--cross-ai` | 否 | 將執行委託給外部 AI CLI（使用 `workflow.cross_ai_command`） |
| `--no-cross-ai` | 否 | 即使配置中啟用了跨 AI 也強制本地執行 |

**前提條件：** 階段已有 PLAN.md 檔案
**產出：** 每個計劃的 `{phase}-{N}-SUMMARY.md`、git 提交，以及階段完全完成時的 `{phase}-VERIFICATION.md`

**包安裝失敗（v1.42.1）：** 如果計劃的安裝步驟失敗，執行器會顯示 `checkpoint:human-verify` 並停止。它不會自動安裝名稱相似的替代包。這是有意為之的 — 靜默替換包名是 slopsquatting 傳播的方式。在登錄檔頁面驗證包後再響應檢查點。

```bash
/gsd-execute-phase 1                # 執行階段 1
/gsd-execute-phase 1 --wave 2       # 僅執行第 2 波
/gsd-execute-phase 1 --validate     # 執行前驗證狀態
/gsd-execute-phase 2 --cross-ai     # 將階段 2 委託給外部 AI CLI
```

---

### `/gsd-verify-work`

帶自動診斷的使用者驗收測試。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 階段編號（預設為最後執行的階段） |

**前提條件：** 階段已被執行
**產出：** `{phase}-UAT.md`，如果發現問題則生成修復計劃

如需基於瀏覽器的 UAT，請使用已配置的瀏覽器 MCP 伺服器。當前的 Open GSD 配套工具是 `gsd-browser`（`gsd-browser mcp`），提供確定性導航、版本化引用、斷言、截圖、視覺差異對比、錄製和人工接管功能。已配置的舊版 Playwright MCP 伺服器仍可使用。

```bash
/gsd-verify-work 1                  # 階段 1 的 UAT
```

---

---

### `/gsd-ship`

從已完成的階段工作建立帶自動生成正文的 PR。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 階段編號或里程碑版本（例如 `4` 或 `v1.0`） |
| `--draft` | 否 | 建立為草稿 PR |

**前提條件：** 階段已驗證（`/gsd-verify-work` 通過），`gh` CLI 已安裝並完成身份驗證
**產出：** 帶有規劃產物豐富正文的 GitHub PR，STATE.md 已更新

```bash
/gsd-ship 4                         # 釋出階段 4
/gsd-ship 4 --draft                 # 作為草稿 PR 釋出
```

**PR 正文包含：**
- ROADMAP.md 中的階段目標
- SUMMARY.md 檔案中的變更摘要
- 已解決的需求（REQ-IDs）
- 驗證狀態
- 關鍵決策
- 來自 `ship.pr_body_sections` 的可選配置 PRD 風格章節

自定義 PR 正文章節的入門指南、示例和驗證規則，請參閱[自定義 PR 正文章節](../ship-pr-body-sections.md)。

---

### `/gsd-ui-review`

對已實現前端的追溯性六柱視覺審計。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 階段編號（預設為最後執行的階段） |

**前提條件：** 專案有前端程式碼（可獨立執行，無需 GSD 專案）
**產出：** `{phase}-UI-REVIEW.md`，截圖儲存在 `.planning/ui-reviews/`

如需更豐富的視覺證據，可將此命令與 `gsd-browser` 或其他瀏覽器 MCP 伺服器配合使用，以便審計可以捕獲截圖、狀態、控制台/網路上下文和可重現的互動步驟。

```bash
/gsd-ui-review                      # 審計當前階段
/gsd-ui-review 3                    # 審計階段 3
```

---

### `/gsd-audit-uat`

跨階段審計所有未完成的 UAT 和驗證專案。

**前提條件：** 至少有一個階段已執行幷包含 UAT 或驗證
**產出：** 帶有人工測試計劃的分類審計報告

```bash
/gsd-audit-uat
```

---

### `/gsd-audit-milestone`

驗證里程碑是否滿足完成定義。

**前提條件：** 所有階段已執行
**產出：** 帶有差距分析的審計報告

```bash
/gsd-audit-milestone
```

---

### `/gsd-complete-milestone`

歸檔里程碑，標記釋出版本。

**前提條件：** 建議先完成里程碑審計
**產出：** `MILESTONES.md` 條目，git 標籤

```bash
/gsd-complete-milestone
```

---

### `/gsd-milestone-summary`

從里程碑產物生成全面的專案摘要，用於團隊入職和審查。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `version` | 否 | 里程碑版本（預設為當前/最新里程碑） |

**前提條件：** 至少有一個已完成或進行中的里程碑
**產出：** `.planning/reports/MILESTONE_SUMMARY-v{version}.md`

**摘要包含：**
- 概述、架構決策、逐階段分解
- 關鍵決策和權衡
- 需求覆蓋率
- 技術債務和延期事項
- 新團隊成員入門指南
- 生成後提供互動式問答

```bash
/gsd-milestone-summary                # 摘要當前里程碑
/gsd-milestone-summary v1.0           # 摘要特定里程碑
```

---

### `/gsd-new-milestone`

啟動下一個版本週期。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `name` | 否 | 里程碑名稱 |
| `--reset-phase-numbers` | 否 | 從第 1 階段重新開始新里程碑，並在路線圖制定前歸檔舊階段目錄 |

**前提條件：** 上一個里程碑已完成
**產出：** 已更新的 `PROJECT.md`、新的 `REQUIREMENTS.md`、新的 `ROADMAP.md`

```bash
/gsd-new-milestone                  # 互動式
/gsd-new-milestone "v2.0 Mobile"    # 命名里程碑
/gsd-new-milestone --reset-phase-numbers "v2.0 Mobile"  # 從 1 重新開始里程碑編號
```

---

## 階段管理命令

### `/gsd-phase`

ROADMAP.md 中階段的 CRUD 操作 — 通過單一合併命令新增、插入、移除或編輯階段。

| 標誌 | 描述 |
|------|-------------|
| （無） | 在當前里程碑末尾追加新的整數階段 |
| `--insert <N>` | 在階段 N 後插入緊急工作作為小數階段（例如 3.1） |
| `--remove <N>` | 移除未來的某個階段並重新編號後續階段 |
| `--edit <N>` | 就地編輯現有階段的任意欄位 |
| `--force` | 允許編輯進行中或已完成的階段（與 `--edit` 配合使用） |

**前提條件：** `.planning/ROADMAP.md` 已存在
**產出：** 已更新的 ROADMAP.md

```bash
/gsd-phase "Add authentication system"          # 追加帶描述的新階段
/gsd-phase --insert 3 "Fix auth race condition" # 在階段 3 和 4 之間插入 → 建立 3.1
/gsd-phase --remove 7               # 移除階段 7，8→7、9→8 等重新編號
/gsd-phase --edit 5                 # 編輯階段 5 的任意欄位
/gsd-phase --edit 5 --force         # 即使階段 5 進行中或已完成也進行編輯
```

---

### `/gsd-mvp-phase`

階段的引導式 MVP 規劃 — 提示輸入使用者故事，執行 SPIDR 拆分檢查，將 `**Mode:** mvp` 寫入 ROADMAP.md，然後委託給 `/gsd-plan-phase`（通過路線圖欄位自動檢測 MVP 模式）。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | **是** | 要轉換為 MVP 模式的階段編號（整數或小數，如 `2.1`） |

| 標誌 | 描述 |
|------|-------------|
| `--force` | 允許轉換 `in_progress` 或 `completed` 狀態的階段 |

**前提條件：** 階段必須已存在於 ROADMAP.md 中（通過 `/gsd-new-project`、`/gsd-phase` 或 `/gsd-phase --insert` 建立）。該命令不建立新階段 — 它轉換現有階段。

**行為：** 收集結構化使用者故事，驗證格式，執行 SPIDR 拆分檢查，將 `**Goal:**` 和 `**Mode:** mvp` 寫入階段的 ROADMAP.md 章節，然後委託給 `/gsd-plan-phase <N>`。演示請參閱[如何規劃 MVP 階段](USER-GUIDE.md#mvp-phase-planning)。

**行走骨架：** 當在無先前階段摘要的新專案第 1 階段使用 `--mvp`（或 `mode: mvp`）時自動觸發。規劃器在 `PLAN.md` 旁邊生成 `SKELETON.md`。

**產出：** 已更新的 ROADMAP.md，以及 `/gsd-plan-phase` 的所有產物；行走骨架模式觸發時生成 `SKELETON.md`。

```bash
/gsd-mvp-phase 1                    # 階段 1 的 MVP 規劃
/gsd-mvp-phase 2.1                  # 小數階段的 MVP 規劃
/gsd-mvp-phase 3 --force            # 即使階段 3 進行中也進行轉換
```

---

### `/gsd-validate-phase`

追溯性審計並填補 Nyquist 驗證空白。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 階段編號 |

```bash
/gsd-validate-phase 2               # 審計階段 2 的測試覆蓋率
```

---

## 導航命令

### `/gsd-progress`

顯示狀態、下一步操作，並自動推進至下一個邏輯工作流步驟。讀取專案狀態並確定適當的操作。

| 標誌 | 描述 |
|------|-------------|
| `--next` | 無需手動選擇路由，自動推進至下一個邏輯工作流步驟 |
| `--do "task description"` | 分析自由形式的意圖並分派到最合適的 GSD 命令 |
| `--forensic` | 在標準報告後附加 6 項完整性審計（STATE 一致性、孤立切換、延期範圍漂移、記憶體標記的待處理工作、阻塞性 todo、未提交程式碼） |

**自動路由行為（`--next`）：**
- 無專案 → 建議 `/gsd-new-project`
- 階段需要討論 → 執行 `/gsd-discuss-phase`
- 階段需要規劃 → 執行 `/gsd-plan-phase`
- 階段需要執行 → 執行 `/gsd-execute-phase`
- 階段需要驗證 → 執行 `/gsd-verify-work`
- 所有階段已完成 → 建議 `/gsd-complete-milestone`

```bash
/gsd-progress                       # "我在哪裡？下一步是什麼？"（含自動路由）
/gsd-progress --next                # 自動推進至下一步
/gsd-progress --do "fix the auth bug"  # 將自由形式意圖分派到最佳 GSD 命令
/gsd-progress --forensic            # 標準報告 + 完整性審計
```

### `/gsd-resume-work`

從上次會話恢復完整上下文。

```bash
/gsd-resume-work                    # 上下文重置或新會話後使用
```

### `/gsd-pause-work`

在階段中途停止時儲存上下文切換資訊。

| 標誌 | 描述 |
|------|-------------|
| `--report` | 在 `.planning/reports/` 中生成會話後摘要，捕獲提交、檔案變更和階段進度 |

```bash
/gsd-pause-work                     # 建立 continue-here.md
/gsd-pause-work --report            # 建立 continue-here.md + 會話報告
```

### `/gsd-manager`

用於從單個終端管理多個階段的互動式命令中心。

**前提條件：** `.planning/ROADMAP.md` 已存在
**行為：**
- 帶有視覺狀態指示器的所有階段儀表板
- 根據依賴關係和進度推薦最優的下一步操作
- 分派工作：discuss 在內聯執行，plan/execute 作為後臺代理執行
- 專為從單個終端並行處理多個階段工作的高階使用者設計
- 通過 `manager.flags` 配置支援每步直通標誌（參閱[配置](CONFIGURATION.md#manager-passthrough-flags)）

```bash
/gsd-manager                        # 開啟命令中心儀表板
/gsd-manager --analyze-deps         # 在並行執行前掃描 ROADMAP 階段的依賴關係
```

**檢查點心跳（#2410）：**

後臺 `execute-phase` 執行在每個波次和計劃邊界處發出 `[checkpoint]` 標記，以防 Claude API SSE 流在多計劃階段上因空閒時間過長而觸發 `Stream idle timeout - partial response received`。格式為：

```
[checkpoint] phase {N} wave {W}/{M} starting, {count} plan(s), {P}/{Q} plans done
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} starting ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} complete ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} complete, {P}/{Q} plans done ({ok}/{count} ok)
```

如果後臺階段中途失敗，請在轉錄中 grep `[checkpoint]` 以檢視最後確認的邊界。管理器的後臺完成處理器在代理出錯時使用這些標記報告部分進度。

**管理器直通標誌：**

在 `.planning/config.json` 的 `manager.flags` 下配置每步標誌。這些標誌會附加到每個分派的命令中：

```json
{
  "manager": {
    "flags": {
      "discuss": "--auto",
      "plan": "--skip-research",
      "execute": "--validate"
    }
  }
}
```

---

### `/gsd-help`

按請求層級顯示 GSD 命令。預設適合單屏顯示；`--full` 為完整參考；`<topic>` 直接跳轉到某一章節。

```bash
/gsd-help                           # 單頁導覽（預設）
/gsd-help --brief                   # 約 10 行的頂級命令簡明摘要
/gsd-help --full                    # 完整參考（每個命令，每個標誌）
/gsd-help <topic>                   # 僅一個章節（例如 /gsd-help debug）
/gsd-help --brief <topic>           # 簡潔的範圍查詢 — 簽名 + 單行摘要
```

完整別名表請參閱 `get-shit-done/workflows/help/modes/topic.md`。未知主題將列印已識別的列表。

---

## 實用工具命令

### `/gsd-explore`

蘇格拉底式構思會話 — 通過深度提問引導某個想法，可選擇生成研究內容，然後將輸出路由到正確的 GSD 產物（筆記、待辦、種子、研究問題、需求或新階段）。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `topic` | 否 | 要探索的主題（例如 `/gsd-explore authentication strategy`） |

```bash
/gsd-explore                        # 開放式構思會話
/gsd-explore authentication strategy  # 探索特定主題
```

---

### `/gsd-undo`

安全 git 回退 — 使用階段清單並通過依賴檢查和確認門回滾 GSD 階段或計劃提交。

| 標誌 | 必填 | 描述 |
|------|----------|-------------|
| `--last N` | （三選一必填） | 顯示最近的 GSD 提交以供互動式選擇 |
| `--phase NN` | （三選一必填） | 回退某個階段的所有提交 |
| `--plan NN-MM` | （三選一必填） | 回退特定計劃的所有提交 |

**安全性：** 回退前檢查依賴的階段/計劃；始終顯示確認門。

```bash
/gsd-undo --last 5                  # 從最近 5 個 GSD 提交中選擇
/gsd-undo --phase 03                # 回退階段 3 的所有提交
/gsd-undo --plan 03-02              # 回退階段 3 第 02 號計劃的提交
```

---

### `/gsd-import`

將外部計劃檔案匯入 GSD 規劃系統，在寫入任何內容之前檢測與 `PROJECT.md` 決策的衝突。

| 標誌 | 必填 | 描述 |
|------|----------|--------------|
| `--from <filepath>` | 是（或 `--from-gsd2`） | 要匯入的外部計劃檔案路徑 |
| `--from-gsd2` | 是（或 `--from`） | 將 GSD-2（`.gsd/`）專案反向遷移回 GSD v1（`.planning/`）格式 |
| `--path <dir>` | 否 | 與 `--from-gsd2` 配合：GSD-2 專案目錄路徑（預設為當前目錄） |

**流程：** 檢測衝突 → 提示解決 → 寫入為 GSD PLAN.md → 通過 `gsd-plan-checker` 驗證

```bash
/gsd-import --from /tmp/team-plan.md    # 匯入並驗證外部計劃
/gsd-import --from-gsd2                # 從 GSD-2 遷移回 v1（當前目錄）
/gsd-import --from-gsd2 --path ~/old-project  # 從不同路徑遷移
```

---

### `/gsd-ingest-docs`

從倉庫中現有的 ADR、PRD、規格和文件引導或合併 `.planning/` 設定。執行並行分類（`gsd-doc-classifier`）以及帶優先順序規則和迴圈檢測的綜合（`gsd-doc-synthesizer`）。生成三分桶衝突報告（`INGEST-CONFLICTS.md`：自動解決、競爭變體、未解決阻塞項），並對 LOCKED-vs-LOCKED ADR 矛盾實施硬性阻止。

| 引數 / 標誌 | 必填 | 描述 |
|-----------------|----------|-------------|
| `path` | 否 | 要掃描的目標目錄（預設為倉庫根目錄） |
| `--mode new\|merge` | 否 | 覆蓋自動檢測（預設：`.planning/` 不存在時為 `new`，存在時為 `merge`） |
| `--manifest <file>` | 否 | YAML 檔案，按文件列出 `{path, type, precedence?}`；覆蓋啟發式分類 |
| `--resolve auto` | 否 | 衝突解決模式（v1：僅 `auto`；`interactive` 保留） |

**限制：** v1 每次呼叫上限為 50 個文件。將共享衝突檢測契約提取到 `references/doc-conflict-engine.md`，`/gsd-import` 也會使用。

```bash
/gsd-ingest-docs                            # 掃描倉庫根目錄，自動檢測模式
/gsd-ingest-docs docs/                      # 僅攝取 docs/ 下的內容
/gsd-ingest-docs --manifest ingest.yaml     # 顯式優先順序清單
```

---

### `/gsd-quick`

執行帶 GSD 保障的臨時任務。

| 標誌 | 描述 |
|------|-------------|
| `--full` | 啟用完整品質流水線 — 討論 + 研究 + 計劃檢查 + 驗證 |
| `--validate` | 僅計劃檢查（最多 2 次迭代）+ 執行後驗證；無討論或研究 |
| `--discuss` | 輕量級預規劃討論 |
| `--research` | 規劃前生成專注研究者 |

細粒度標誌可組合：`--discuss --research --validate` 等同於 `--full`。

| 子命令 | 描述 |
|------------|-------------|
| `list` | 列出所有帶狀態的快速任務 |
| `status <slug>` | 顯示特定快速任務的狀態 |
| `resume <slug>` | 通過 slug 恢復特定快速任務 |

```bash
/gsd-quick                          # 基本快速任務
/gsd-quick --discuss --research     # 討論 + 研究 + 規劃
/gsd-quick --validate               # 僅計劃檢查 + 驗證
/gsd-quick --full                   # 完整品質流水線
/gsd-quick list                     # 列出所有快速任務
/gsd-quick status my-task-slug      # 顯示快速任務的狀態
/gsd-quick resume my-task-slug      # 恢復快速任務
```

### `/gsd-autonomous`

自主執行所有剩餘階段。

| 標誌 | 描述 |
|------|-------------|
| `--from N` | 從特定階段編號開始 |
| `--to N` | 完成特定階段編號後停止 |
| `--interactive` | 精簡上下文並接受使用者輸入 |

```bash
/gsd-autonomous                     # 執行所有剩餘階段
/gsd-autonomous --from 3            # 從階段 3 開始
/gsd-autonomous --to 5              # 執行到階段 5（含）
/gsd-autonomous --from 3 --to 5     # 執行階段 3 到 5
```

### `/gsd-debug`

帶持久狀態的系統性除錯。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `description` | 否 | 錯誤描述 |

| 標誌 | 描述 |
|------|-------------|
| `--diagnose` | 僅診斷模式 — 調查但不嘗試修復 |

**子命令：**
- `/gsd-debug list` — 列出所有活動除錯會話及狀態、假設和下一步操作
- `/gsd-debug status <slug>` — 列印會話的完整摘要（證據數量、已排除數量、解決方案、TDD 檢查點），不生成代理
- `/gsd-debug continue <slug>` — 通過 slug 恢復特定會話（顯示當前焦點後生成延續代理）
- `/gsd-debug [--diagnose] <description>` — 開始新除錯會話（現有行為；`--diagnose` 在找到根本原因後停止，不應用修復）

**TDD 模式：** 當 `.planning/config.json` 中 `tdd_mode: true` 時，除錯會話需要在應用任何修復前編寫並驗證失敗的測試（紅 → 綠 → 完成）。

```bash
/gsd-debug "Login button not responding on mobile Safari"
/gsd-debug --diagnose "Intermittent 500 errors on /api/users"
/gsd-debug list
/gsd-debug status auth-token-null
/gsd-debug continue form-submit-500
```

### `/gsd-add-tests`

為已完成的階段生成測試。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 階段編號 |

```bash
/gsd-add-tests 2                    # 為階段 2 生成測試
```

### `/gsd-stats`

顯示專案統計資訊。

```bash
/gsd-stats                          # 專案指標儀表板
```

### `/gsd-profile-user`

通過對 Claude Code 會話的 8 個維度分析生成開發者行為檔案（溝通風格、決策模式、除錯方法、使用者體驗偏好、供應商選擇、挫折觸發因素、學習風格、解釋深度）。生成用於個性化 Claude 響應的產物。

| 標誌 | 描述 |
|------|-------------|
| `--questionnaire` | 使用互動式問卷代替會話分析 |
| `--refresh` | 重新分析會話並重新生成檔案 |

**生成的產物：**
- `USER-PROFILE.md` — 完整行為檔案
- `CLAUDE.md` 檔案章節 — 由 Claude Code 自動發現

```bash
/gsd-profile-user                   # 分析會話並構建檔案
/gsd-profile-user --questionnaire   # 互動式問卷回退方案
/gsd-profile-user --refresh         # 從新分析中重新生成
```

### `/gsd-health`

驗證 `.planning/` 目錄完整性。使用 `--context` 時，針對 60% / 70% 閾值探測上下文視窗使用率保護（v1.40.0 新增，[#2792](https://github.com/open-gsd/gsd-core/issues/2792)）。

| 標誌 | 描述 |
|------|-------------|
| `--repair` | 自動修復可恢復的問題 |
| `--context` | 探測上下文視窗使用率；60% 時警告，70% 時嚴重警告 |

```bash
/gsd-health                         # 檢查完整性
/gsd-health --repair                # 檢查並修復
/gsd-health --context               # 上下文使用率分類
```

### `/gsd-cleanup`

歸檔已完成里程碑中積累的階段目錄，並刪除上游已刪除的本地分支。

**行為：** 呈現要歸檔的階段目錄的演練摘要（從 `.planning/phases/` 移至 `.planning/milestones/v{X.Y}-phases/`）和上游已刪除的本地分支（通過 `git fetch --prune` 刪除）。寫入任何變更前需要確認。當前檢出的分支永遠不會被刪除。

```bash
/gsd-cleanup
```

---

## 實驗與草圖命令

### `/gsd-spike`

在確定實現方案前執行 2-5 個專注的可行性實驗。每個實驗使用 Given/When/Then 框架，生成可執行程式碼，並返回 VALIDATED / INVALIDATED / PARTIAL 裁決。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `idea` | 否 | 要調查的技術問題或方法 |
| `--quick` | 否 | 跳過接收對話；直接使用 `idea` 文本 |
| `--wrap-up` | 否 | 將已完成的實驗結果打包成可重用的專案本地技能 |

**產出：** `.planning/spikes/NNN-experiment-name/`（含程式碼、結果和 README）；`.planning/spikes/MANIFEST.md`
**`--wrap-up` 產出：** `.claude/skills/spike-findings-[project]/` 技能檔案

```bash
/gsd-spike                              # 互動式接收
/gsd-spike "can we stream LLM tokens through SSE"
/gsd-spike --quick websocket-vs-polling
/gsd-spike --wrap-up                    # 將結果打包為可重用技能
```

---

### `/gsd-sketch`

在確定實現方案前通過一次性 HTML 原型探索設計方向。每個設計問題生成 2-3 個變體供直接瀏覽器比較。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `idea` | 否 | 要探索的 UI 設計問題或方向 |
| `--quick` | 否 | 跳過風格接收；直接使用 `idea` 文本 |
| `--text` | 否 | 文本模式回退 — 用編號列表替換互動式提示（適用於非 Claude 執行時） |
| `--wrap-up` | 否 | 將獲勝的草圖決策打包為可重用的專案本地技能 |

**產出：** `.planning/sketches/NNN-descriptive-name/index.html`（2-3 個互動變體）、`README.md`、共享 `themes/default.css`；`.planning/sketches/MANIFEST.md`
**`--wrap-up` 產出：** `.claude/skills/sketch-findings-[project]/` 技能檔案

```bash
/gsd-sketch                             # 互動式風格接收
/gsd-sketch "dashboard layout"
/gsd-sketch --quick "sidebar navigation"
/gsd-sketch --text "onboarding flow"    # 非 Claude 執行時
/gsd-sketch --wrap-up                   # 將獲勝草圖打包為技能
```

---

## 診斷命令

### `/gsd-forensics`

失敗 GSD 工作流的事後調查 — 診斷出了什麼問題。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `description` | 否 | 問題描述（省略時提示輸入） |

**前提條件：** `.planning/` 目錄已存在
**產出：** `.planning/forensics/report-{timestamp}.md`

**調查內容包括：**
- Git 歷史分析（最近提交、卡滯模式、時間間隔）
- 產物完整性（已完成階段的預期檔案）
- STATE.md 異常和會話歷史
- 未提交的工作、衝突、廢棄的變更
- 至少檢查 4 種異常型別（卡滯迴圈、缺失產物、廢棄工作、崩潰/中斷）
- 如果發現可操作的結果，提供建立 GitHub issue 的選項

```bash
/gsd-forensics                              # 互動式 — 提示輸入問題
/gsd-forensics "Phase 3 execution stalled"  # 帶問題描述
```

---

### `/gsd-extract-learnings`

從已完成的階段工作中提取可重用的模式、反模式和架構決策。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | **是** | 要提取學習記錄的階段編號 |

| 標誌 | 描述 |
|------|-------------|
| `--all` | 從所有已完成的階段中提取學習記錄 |
| `--format` | 輸出格式：`markdown`（預設）、`json` |

**前提條件：** 階段已被執行（SUMMARY.md 檔案已存在）
**產出：** `.planning/learnings/{phase}-LEARNINGS.md`

**提取內容：**
- 架構決策及其依據
- 執行良好的模式（可在未來階段複用）
- 遇到的反模式及其解決方式
- 特定技術的洞察
- 效能和測試觀察

```bash
/gsd-extract-learnings 3                    # 提取階段 3 的學習記錄
/gsd-extract-learnings --all                # 從所有已完成階段提取
```

---

## 工作流管理

### `/gsd-workstreams`

管理用於併發處理不同里程碑領域的並行工作流。

**子命令：**

| 子命令 | 描述 |
|------------|-------------|
| `list` | 列出所有帶狀態的工作流（無子命令時的預設操作） |
| `create <name>` | 建立新工作流 |
| `status <name>` | 某個工作流的詳細狀態 |
| `switch <name>` | 設定活動工作流 |
| `progress` | 所有工作流的進度摘要 |
| `complete <name>` | 歸檔已完成的工作流 |
| `resume <name>` | 在工作流中恢復工作 |

**前提條件：** 活動的 GSD 專案
**產出：** `.planning/` 下的工作流目錄，每個工作流的狀態跟蹤

```bash
/gsd-workstreams                    # 列出所有工作流
/gsd-workstreams create backend-api # 建立新工作流
/gsd-workstreams switch backend-api # 設定活動工作流
/gsd-workstreams status backend-api # 詳細狀態
/gsd-workstreams progress           # 跨工作流進度概覽
/gsd-workstreams complete backend-api  # 歸檔已完成的工作流
/gsd-workstreams resume backend-api    # 在工作流中恢復工作
```

---

## 配置命令

### `/gsd-settings`

工作流切換和模型配置的互動式配置。問題分為六個視覺化章節：

- **規劃** — 研究、計劃檢查器、模式對映器、Nyquist、UI 階段、UI 關卡、AI 階段
- **執行** — 驗證器、TDD 模式、程式碼審查、程式碼審查深度 _（條件性 — 僅在程式碼審查開啟時）_、UI 審查
- **文件與輸出** — 提交文件、跳過討論、工作樹
- **功能** — Intel、Graphify
- **模型與流水線** — 模型配置、自動推進、分支
- **雜項** — 上下文警告、研究問題

所有答案通過 `gsd-tools query config-set` 合併到已解析的專案配置路徑（標準安裝為 `.planning/config.json`，工作流處於活動狀態時為 `.planning/workstreams/<active>/config.json`），保留不相關的鍵。確認後，使用者可以將完整設定物件儲存到 `~/.gsd/defaults.json`，以便未來執行 `/gsd-new-project` 時從相同的基線開始。

```bash
/gsd-settings                       # 互動式配置
```

### `/gsd-config`

通過單一合併命令互動式配置 GSD 設定 — 工作流切換、高階引數、整合和模型配置。

| 標誌 | 描述 |
|------|-------------|
| （無） | 常用切換：模型、research、plan_check、verifier、branching |
| `--advanced` | 高階使用者引數：規劃調優、超時、分支模板、跨 AI 執行、執行時/輸出 |
| `--integrations` | 第三方 API 金鑰、程式碼審查 CLI 路由、代理技能注入 |
| `--profile <name>` | 快速配置切換：`quality`、`balanced`、`budget` 或 `inherit` |

**`--advanced` 章節：**

| 章節 | 鍵 |
|---------|------|
| 規劃調優 | `workflow.plan_bounce`、`workflow.plan_bounce_passes`、`workflow.plan_bounce_script`、`workflow.subagent_timeout`、`workflow.inline_plan_threshold` |
| 執行調優 | `workflow.node_repair`、`workflow.node_repair_budget`、`workflow.auto_prune_state` |
| 討論調優 | `workflow.max_discuss_passes` |
| 跨 AI 執行 | `workflow.cross_ai_execution`、`workflow.cross_ai_command`、`workflow.cross_ai_timeout` |
| Git 定製 | `git.base_branch`、`git.phase_branch_template`、`git.milestone_branch_template` |
| 執行時 / 輸出 | `response_language`、`context_window`、`search_gitignored`、`graphify.build_timeout` |

所有答案通過 `gsd-tools query config-set` 合併，保留不相關的鍵。API 金鑰在所有輸出中以掩碼顯示（`****<last-4>`）。

```bash
/gsd-config                         # 常用互動式配置
/gsd-config --advanced              # 高階使用者引數（六章節提示）
/gsd-config --integrations          # API 金鑰、審查 CLI 路由、代理技能
/gsd-config --profile budget        # 切換到 budget 配置
/gsd-config --profile quality       # 切換到 quality 配置
```

完整的模式和預設值請參閱 [CONFIGURATION.md](CONFIGURATION.md)。

### `/gsd-surface`

切換顯示的技能 — 應用配置、列出或停用叢集，無需重新安裝。

| 子命令 | 描述 |
|------------|-------------|
| `list` | 顯示已啟用和已停用的叢集和技能 |
| `status` | `list` 的別名，附加 token 成本摘要 |
| `profile <name>` | 寫入 `baseProfile` 並重新暫存技能 |
| `disable <cluster>` | 將叢集新增到停用列表並重新暫存 |
| `enable <cluster>` | 從停用列表中刪除叢集並重新暫存 |
| `reset` | 刪除表面增量；恢復安裝時的配置 |

```bash
/gsd-surface list                   # 顯示當前表面
/gsd-surface profile standard       # 切換到 standard 配置
/gsd-surface disable utility        # 停用 utility 叢集
/gsd-surface reset                  # 恢復安裝時的配置
```

---

## 棕地命令

### `/gsd-map-codebase`

使用並行對映代理分析現有程式碼庫。使用 `--fast` 進行快速單代理掃描，或使用 `--query` 搜尋現有 intel。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `area` | 否 | 將對映範圍限定到特定區域 |
| `--fast` | 否 | 快速單焦點評估 — 生成一個對映代理而非四個並行代理（輕量級替代方案） |
| `--query <term>` | 否 | 搜尋 `.planning/intel/` 中可查詢的程式碼庫 intel 檔案（需要 `intel.enabled: true`） |

| 標誌 | 描述 |
|------|-------------|
| `--focus tech\|arch\|quality\|concerns\|tech+arch` | `--fast` 模式的焦點區域（預設：`tech+arch`） |

**產出：** `.planning/codebase/` 分析文件（完整模式）；`.planning/codebase/` 中的目標文件（`--fast`）；intel 查詢結果（`--query`）

```bash
/gsd-map-codebase                   # 完整程式碼庫分析（4 個並行代理）
/gsd-map-codebase auth              # 聚焦 auth 區域
/gsd-map-codebase --fast            # 快速技術 + 架構概覽（1 個代理）
/gsd-map-codebase --fast --focus quality  # 僅品質和程式碼健康狀況
/gsd-map-codebase --query authentication  # 搜尋 intel 中的某個術語
```

### `/gsd-graphify`

構建、查詢和檢查儲存在 `.planning/graphs/` 中的專案知識圖譜。通過在 `config.json` 中設定 `graphify.enabled: true` 選擇啟用（參閱[配置參考](CONFIGURATION.md#graphify-settings)）；停用時，命令列印啟用提示並停止。

| 子命令 | 描述 |
|------------|-------------|
| `build` | 構建或重建知識圖譜（內聯執行 `graphify update .` 並重新整理 `.planning/graphs/`） |
| `query <term>` | 在圖譜中搜索某個術語 |
| `status` | 顯示圖譜新鮮度和統計資訊 |
| `diff` | 顯示自上次構建以來的變更 |

**產出：** `.planning/graphs/` 圖譜產物（節點、邊、快照）

```bash
/gsd-graphify build                 # 構建或重建知識圖譜
/gsd-graphify query authentication  # 在圖譜中搜索某個術語
/gsd-graphify status                # 顯示新鮮度和統計資訊
/gsd-graphify diff                  # 顯示自上次構建以來的變更
```

**程式設計訪問：** `node gsd-tools.cjs graphify <build|query|status|diff|snapshot>` — 參閱 [CLI 工具參考](CLI-TOOLS.md)。

### `gsd-tools intel api-surface`

將 `.planning/intel/api-map.json` 索引（由 `/gsd-map-codebase` 構建）渲染為 `.planning/intel/` 中人類可讀的 `API-SURFACE.md`。以 `config.json` 中 `intel.enabled: true` 為門控；當 Intel 被停用時，命令列印啟用提示並退出。輸出路徑始終為 `.planning/intel/API-SURFACE.md` — 沒有 `--out` 或 `--format` 標誌。當 `api-map.json` 不存在或為空時，命令仍會寫入檔案並附帶明確的"不完整"橫幅，以便使用者不會將沉默誤認為"什麼都不存在"。

**產出：** `.planning/intel/API-SURFACE.md`

```bash
node gsd-tools.cjs intel api-surface              # 渲染 api-map.json → API-SURFACE.md
```

`API-SURFACE.md` 輸出按原始檔分組列出匯出的符號（函式、類、裝飾器、常量）及其簽名和檢測到的可見性。當 `plan_review.source_grounding_authority` 設定為 `intel` 時，計劃漂移保護直接讀取 `api-map.json` 而不是呼叫 `api-surface` 渲染器。

---

## AI 整合命令

### `/gsd-ai-integration-phase`

為涉及構建 AI 系統的階段生成 AI-SPEC.md 設計契約。呈現互動式決策矩陣，顯示特定領域的故障模式和評估標準，並生成包含框架推薦、實現指南和評估策略的 `AI-SPEC.md`。

**產出：** 階段目錄中的 `{phase}-AI-SPEC.md`

**生成：** 3 個並行專家代理：domain-researcher、framework-selector、ai-researcher 和 eval-planner

```bash
/gsd-ai-integration-phase              # 當前階段的嚮導
/gsd-ai-integration-phase 3           # 特定階段的嚮導
```

---

### `/gsd-eval-review`

審計已執行 AI 階段的評估覆蓋率並生成 EVAL-REVIEW.md 修復計劃。根據 `/gsd-ai-integration-phase` 生成的 `AI-SPEC.md` 評估計劃檢查實現情況。將每個評估維度評分為 COVERED/PARTIAL/MISSING。

**前提條件：** 階段已被執行且有 `AI-SPEC.md`
**產出：** `{phase}-EVAL-REVIEW.md`，包含發現結果、差距和修復指南

```bash
/gsd-eval-review                       # 審計當前階段
/gsd-eval-review 3                     # 審計特定階段
```

---

## 更新命令

### `/gsd-update`

更新 GSD，預覽變更日誌，並可選擇同步技能或重新應用本地補丁。

| 標誌 | 描述 |
|------|-------------|
| `--sync` | 更新後從 GSD 登錄檔同步技能 |
| `--reapply` | 更新後恢復本地修改（補丁） |

```bash
/gsd-update                         # 檢查更新並安裝
/gsd-update --sync                  # 更新並同步技能
/gsd-update --reapply               # 更新並重新應用本地補丁
```

---

## 程式碼品質命令

### `/gsd-code-review`

審查階段期間更改的原始檔，查詢錯誤、安全漏洞和程式碼品質問題。使用 `--fix` 可在審查後自動修復發現的問題。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | **是** | 要審查的階段編號（例如 `2` 或 `02`） |
| `--depth=quick\|standard\|deep` | 否 | 審查深度級別（覆蓋 `workflow.code_review_depth` 配置）。`quick`：僅模式匹配（約 2 分鐘）。`standard`：按檔案分析，含特定語言檢查（約 5-15 分鐘，預設）。`deep`：跨檔案分析，包括匯入圖和呼叫鏈（約 15-30 分鐘） |
| `--files file1,file2,...` | 否 | 顯式逗號分隔的檔案列表；完全跳過 SUMMARY/git 範圍界定 |
| `--fix` | 否 | 審查後自動修復問題 — 讀取 REVIEW.md，生成修復代理，原子性地提交每個修復 |
| `--fix --all` | 否 | 將 Info 級別的發現納入修復範圍（預設：僅 Critical + Warning） |
| `--fix --auto` | 否 | 修復 + 重新審查迭代迴圈，最多 3 次迭代 |

**前提條件：** 階段已被執行且有 SUMMARY.md 或 git 歷史
**產出：** `{phase}-REVIEW.md`，包含按嚴重性分類的發現；使用 `--fix` 時產出 `{phase}-REVIEW-FIX.md`
**生成：** `gsd-code-reviewer` 代理；使用 `--fix` 時生成 `gsd-code-fixer` 代理

**可選結構預檢：** 將 `code_quality.fallow.enabled` 設定為 `true` 可在代理審查前執行 fallow。GSD 寫入 `{phase}/FALLOW.json` 並在 `REVIEW.md` 中嵌入 `Structural Findings (fallow)` 章節。使用 `code_quality.fallow.scope` 和 `code_quality.fallow.profile` 配置範圍和配置檔案。

```bash
/gsd-code-review 3                          # 階段 3 的標準審查
/gsd-code-review 2 --depth=deep             # 深度跨檔案審查
/gsd-code-review 4 --files src/auth.ts,src/token.ts  # 顯式檔案列表
/gsd-code-review 3 --fix                    # 審查後修復 Critical + Warning 發現
/gsd-code-review 3 --fix --all             # 審查後修復所有發現（包括 Info）
/gsd-code-review 3 --fix --auto            # 審查、修復並重新審查直到清潔（最多 3 次迭代）
```

---

### `/gsd-audit-fix`

自主審計到修復流水線 — 執行審計、分類發現、通過測試驗證自動修復可修復的問題，並原子性地提交每個修復。

| 標誌 | 描述 |
|------|-------------|
| `--source <audit>` | 要執行的審計型別（預設：`audit-uat`） |
| `--severity high\|medium\|all` | 要處理的最低嚴重性（預設：`medium`） |
| `--max N` | 要修復的最大發現數量（預設：5） |
| `--dry-run` | 分類發現但不修復（顯示分類表） |

**前提條件：** 至少有一個階段已執行幷包含 UAT 或驗證
**產出：** 帶測試驗證的修復提交；分類報告

```bash
/gsd-audit-fix                              # 執行 audit-uat，修復 medium+ 級別的問題（最多 5 個）
/gsd-audit-fix --severity high             # 僅修復高嚴重性問題
/gsd-audit-fix --dry-run                   # 預覽分類而不修復
/gsd-audit-fix --max 10 --severity all     # 修復任意嚴重性的最多 10 個問題
```

---

## 快速與內聯命令

### `/gsd-fast`

內聯執行簡單任務 — 無子代理，無規劃開銷。適用於錯別字修復、配置變更、小型重構、遺忘的提交。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `task description` | 否 | 要做什麼（省略時提示輸入） |

**不是 `/gsd-quick` 的替代品** — 任何需要研究、多步驟規劃或驗證的事項請使用 `/gsd-quick`。

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to gitignore"
```

---

### `/gsd-review`

來自外部 AI CLI 的階段計劃跨 AI 同行評審。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `--phase N` | **是** | 要審查的階段編號 |

| 標誌 | 描述 |
|------|-------------|
| `--gemini` | 包含 Gemini CLI 審查 |
| `--claude` | 包含 Claude CLI 審查（獨立會話） |
| `--codex` | 包含 Codex CLI 審查 |
| `--coderabbit` | 包含 CodeRabbit 審查 |
| `--opencode` | 包含 OpenCode 審查（通過 GitHub Copilot） |
| `--qwen` | 包含 Qwen Code 審查（阿里巴巴 Qwen 模型） |
| `--cursor` | 包含 Cursor 代理審查 |
| `--agy` / `--antigravity` | 包含 Antigravity CLI 審查（使用 Google 憑證免費） |
| `--ollama` | 包含 Ollama 伺服器審查 |
| `--lm-studio` | 包含 LM Studio 伺服器審查 |
| `--llama-cpp` | 包含 llama.cpp 伺服器審查 |
| `--all` | 包含所有可用的審查者（CLI + 本地模型伺服器） |

**預設審查者行為（無標誌）：**
- 如果 `review.default_reviewers` **未設定**，`/gsd-review` 執行所有檢測到的審查者（當前預設行為）。
- 如果 `review.default_reviewers` **已設定**，`/gsd-review` 僅執行該子集（例如 `["gemini","codex"]`）。
- `--all` 始終覆蓋配置並執行完整的檢測集。
- 顯式標誌（例如 `--cursor`）在該次執行中覆蓋 `--all` 和配置預設值。

**產出：** `{phase}-REVIEWS.md` — 可供 `/gsd-plan-phase --reviews` 使用

```bash
# 設定專案預設審查者，用於無標誌的 /gsd-review 執行
gsd config-set review.default_reviewers '["gemini","codex"]'

/gsd-review --phase 2             # 使用配置中的 gemini+codex 執行
/gsd-review --phase 3 --all
/gsd-review --phase 2 --gemini
/gsd-review --phase 2 --cursor    # 一次性覆蓋
```

---

### `/gsd-pr-branch`

通過過濾 `.planning/` 提交建立乾淨的 PR 分支。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `target branch` | 否 | 基礎分支（預設：`main`） |

**目的：** 審查者只看到程式碼變更，而非 GSD 規劃產物。

```bash
/gsd-pr-branch                     # 相對於 main 進行過濾
/gsd-pr-branch develop             # 相對於 develop 進行過濾
```

---

### `/gsd-secure-phase`

追溯性驗證已完成階段的威脅緩解措施。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `phase number` | 否 | 要審計的階段（預設：最後完成的階段） |

**前提條件：** 階段必須已被執行。有無現有 SECURITY.md 均可執行。
**產出：** `{phase}-SECURITY.md`，包含威脅驗證結果
**生成：** `gsd-security-auditor` 代理

三種執行模式：
1. SECURITY.md 已存在 — 審計並驗證現有緩解措施
2. 無 SECURITY.md 但 PLAN.md 有威脅模型 — 從產物生成
3. 階段未執行 — 退出並提供指導

```bash
/gsd-secure-phase                   # 審計最後完成的階段
/gsd-secure-phase 5                 # 審計特定階段
```

---

### `/gsd-docs-update`

生成或更新經程式碼庫驗證的專案文件。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| `--force` | 否 | 跳過儲存提示，重新生成所有文件 |
| `--verify-only` | 否 | 檢查現有文件的準確性，不生成 |

**產出：** 最多 9 個文件檔案（README、架構、API、入門、開發、測試、配置、部署、貢獻）
**生成：** `gsd-doc-writer` 代理（每種文件型別一個），然後是用於事實驗證的 `gsd-doc-verifier` 代理

每個文件寫作代理直接探索程式碼庫 — 不存在幻覺路徑或過時簽名。文件驗證代理對照即時檔案系統檢查宣告。

```bash
/gsd-docs-update                    # 互動式生成/更新文件
/gsd-docs-update --force            # 重新生成所有文件
/gsd-docs-update --verify-only      # 僅驗證現有文件
```

---

## 任務捕捉與待辦命令

### `/gsd-capture`

將想法、任務、筆記和種子捕捉到適當的目的地。預設模式新增結構化待辦事項；標誌路由到專業的捕捉工作流。

| 標誌 | 描述 |
|------|-------------|
| （無） | 捕捉為結構化待辦事項供後續處理 |
| `--note [text]` | 零摩擦筆記 — 追加、列出（`--note list`）或提升（`--note promote N`） |
| `--backlog <description>` | 使用 999.x 編號新增到待辦停車場 |
| `--seed [idea summary]` | 捕捉具有觸發條件的前瞻性想法 |
| `--list` | 列出待處理的待辦事項並選擇一項處理 |
| `--global` | 使用全域性範圍（用於筆記操作） |

**待辦停車場：** 999.x 編號使條目保持在活動階段序列之外；階段目錄立即建立，以便 `/gsd-discuss-phase` 和 `/gsd-plan-phase` 可以在其上執行。
**種子：** 保留完整的原因、觸發時機和麵包屑 — 由 `/gsd-new-milestone` 使用。

**產出：** `.planning/todos/`（預設）、筆記檔案（--note）、ROADMAP.md 待辦章節（--backlog）、`.planning/seeds/SEED-NNN-slug.md`（--seed）

```bash
/gsd-capture "Consider adding dark mode support"   # 新增待辦事項
/gsd-capture --note "Caching strategy idea"        # 快速筆記
/gsd-capture --note list                           # 列出所有筆記
/gsd-capture --note promote 3                      # 將筆記 3 提升為待辦事項
/gsd-capture --backlog "GraphQL API layer"         # 新增到待辦停車場
/gsd-capture --seed "Add real-time collaboration when WebSocket infra is in place"
/gsd-capture --list                                # 瀏覽並處理待辦事項
```

---

### `/gsd-review-backlog`

審查並將待辦停車場中的條目提升到活動里程碑。

**每個條目的操作：** 提升（移至活動序列）、保留（留在待辦停車場）、移除（刪除）。

```bash
/gsd-review-backlog
```

---

### `/gsd-thread`

管理用於跨會話工作的持久上下文執行緒。

| 引數 | 必填 | 描述 |
|----------|----------|-------------|
| （無）/ `list` | — | 列出所有執行緒 |
| `list --open` | — | 僅列出狀態為 `open` 或 `in_progress` 的執行緒 |
| `list --resolved` | — | 僅列出狀態為 `resolved` 的執行緒 |
| `status <slug>` | — | 顯示特定執行緒的狀態 |
| `close <slug>` | — | 將執行緒標記為已解決 |
| `name` | — | 通過名稱恢復現有執行緒 |
| `description` | — | 建立新執行緒 |

執行緒是用於跨多個會話但不屬於任何特定階段的工作的輕量級跨會話知識儲存。比 `/gsd-pause-work` 更輕量。

```bash
/gsd-thread                         # 列出所有執行緒
/gsd-thread list --open             # 僅列出開放/進行中的執行緒
/gsd-thread list --resolved         # 僅列出已解決的執行緒
/gsd-thread status fix-deploy-key   # 顯示執行緒狀態
/gsd-thread close fix-deploy-key    # 將執行緒標記為已解決
/gsd-thread fix-deploy-key-auth     # 恢復執行緒
/gsd-thread "Investigate TCP timeout in pasta service"  # 建立新執行緒
```

---

## 路線圖管理命令

### `roadmap validate`

驗證 ROADMAP.md 的結構完整性，包括里程碑字首一致性。

**前提條件：** `.planning/ROADMAP.md` 已存在
**產出：** 驗證報告；發現任何錯誤或警告時以非零值退出

```bash
node gsd-tools.cjs roadmap validate
```

---

### `roadmap upgrade --convention milestone-prefixed`

將舊版 `Phase N` ID 遷移到以里程碑為字首的 `Phase M-NN` 約定。

| 標誌 | 必填 | 描述 |
|------|----------|-------------|
| `--convention milestone-prefixed` | 是 | 要遷移到的目標約定 |
| `--apply` | 否 | 將變更寫入磁碟（預設：僅演練） |

**前提條件：** `.planning/ROADMAP.md` 已存在
**產出：** 演練差異（預設）或就地 ROADMAP.md 重寫（`--apply`）

```bash
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed         # 演練
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed --apply  # 應用
```

---

## 狀態管理命令

### `state validate`

檢測 STATE.md 與實際檔案系統之間的漂移。

**前提條件：** `.planning/STATE.md` 已存在
**產出：** 驗證報告，顯示 STATE.md 欄位與檔案系統實際情況之間的任何漂移

```bash
node gsd-tools.cjs state validate
```

---

### `state sync [--verify]`

從磁碟上的實際專案狀態重建 STATE.md。

| 標誌 | 描述 |
|------|-------------|
| `--verify` | 演練模式 — 顯示建議的變更而不寫入 |

**前提條件：** `.planning/` 目錄已存在
**產出：** 反映檔案系統實際情況的已更新 `STATE.md`

```bash
node gsd-tools.cjs state sync             # 從磁碟重建 STATE.md
node gsd-tools.cjs state sync --verify    # 演練：顯示變更而不寫入
```

---

### `state planned-phase`

在 plan-phase 完成後記錄狀態轉換（已規劃/準備執行）。

| 標誌 | 描述 |
|------|-------------|
| `--phase N` | 已規劃的階段編號 |
| `--plans N` | 生成的計劃數量 |

**前提條件：** 階段已被規劃
**產出：** 包含規劃後狀態的已更新 `STATE.md`

```bash
node gsd-tools.cjs state planned-phase --phase 3 --plans 2
```

---

## 社群命令

### 社群鉤子

可選的 git 和會話鉤子，由 `.planning/config.json` 中的 `hooks.community: true` 控制。除非明確啟用，否則均為無操作。

| 鉤子 | 用途 |
|------|---------|
| `gsd-validate-commit.sh` | 對 git 提交資訊強制執行 Conventional Commits 格式 |
| `gsd-session-state.sh` | 跟蹤會話狀態轉換 |
| `gsd-phase-boundary.sh` | 執行階段邊界檢查 |

啟用方式：
```json
{ "hooks": { "community": true } }
```

---

### 社群邀請

加入 GSD Discord 社群，請訪問 GSD README 中的連結，或執行 `/gsd-help` 並點選其中顯示的 Discord 連結。

---

## 貢獻：技能描述標準

技能描述（每個 `commands/gsd/*.md` frontmatter 中的 `description:` 欄位）會被注入到每個會話的系統提示中。為保持每會話開銷較低，描述必須不超過 100 個字元，且不得重複 `argument-hint:` 中已有的標誌文件。

一個 lint 門執行此預算：

```bash
npm run lint:descriptions
```

該檢查也作為 `npm test` 的一部分通過 `tests/enh-2789-description-budget.test.cjs` 執行。

---

## 相關文件

- [配置參考](CONFIGURATION.md)
- [CLI 工具參考](CLI-TOOLS.md)
- [功能參考](FEATURES.md)
- [文件索引](README.md)
