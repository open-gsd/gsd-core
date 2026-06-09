# 如何規劃階段

**目標：** 將階段決策和研究成果轉化為可原子化執行、可驗證的任務計劃。

**前提條件：** `.planning/ROADMAP.md` 已存在。強烈建議（但非必須）先通過 `/gsd-discuss-phase` 生成 `{phase}-CONTEXT.md`。

---

## 執行標準規劃流程

```bash
/gsd-plan-phase 2
```

該命令按順序執行三個階段：

1. **研究** — `gsd-phase-researcher` 子代理調查相關領域並寫入 `{phase}-RESEARCH.md`。
2. **規劃** — `gsd-planner` 子代理讀取上下文、研究成果和需求，然後寫入一個或多個 `{phase}-{N}-PLAN.md` 檔案。
3. **驗證** — `gsd-plan-checker` 子代理從八個維度驗證計劃品質，並觸發修訂迴圈（最多三次迭代），直至品質門控通過。

若未指定階段編號，GSD Core 將自動定位 ROADMAP.md 中下一個未規劃的階段。

---

## 跳過或強制執行研究

**如果領域已熟悉且無需新的研究：**

```bash
/gsd-plan-phase 3 --skip-research
```

**如果 RESEARCH.md 已存在但需要強制重新整理：**

```bash
/gsd-plan-phase 3 --research
```

**如果只想執行研究** — 寫入 RESEARCH.md 後在規劃前退出：

```bash
/gsd-plan-phase --research-phase 4
```

若 RESEARCH.md 已存在，系統會提示選擇更新、檢視或跳過。如需強制重新整理而不顯示提示：

```bash
/gsd-plan-phase --research-phase 4 --research
```

將現有 RESEARCH.md 列印到標準輸出而不啟動研究代理：

```bash
/gsd-plan-phase --research-phase 4 --view
```

注意：`--research-phase <N>` 是 `/gsd-plan-phase` 上的標誌。不存在獨立的研究階段命令——原來的獨立研究命令已被棄用，以此標誌取而代之。

---

## 按垂直功能切片而非水平層次進行規劃

**如果希望任務按端到端的薄切片組織**（每個功能從 UI → API → DB），而非按技術層次：

```bash
/gsd-plan-phase 1 --mvp
```

在新專案的第一階段且無先前階段摘要的情況下，`--mvp` 還會生成 `SKELETON.md`——一份 Walking Skeleton，涵蓋專案腳手架、路由、一次真實的資料庫讀寫、一次真實的 UI 互動以及開發部署。

也可在 ROADMAP.md 中該階段的條目裡新增 `**Mode:** mvp`，無需每次使用標誌即可持久啟用 MVP 模式。

---

## 要求每個新增行為任務包含一個失敗測試

**如果需要強制 TDD** — 每個新增行為的任務在實現前先編寫一個失敗測試：

```bash
/gsd-plan-phase 1 --tdd
```

可與 `--mvp` 組合使用：

```bash
/gsd-plan-phase 1 --mvp --tdd
```

這將生成垂直切片，其中每個新增行為的任務均遵循 RED → GREEN → REFACTOR 流程。規劃器會對符合條件的任務（業務邏輯、API 端點、資料轉換）應用 `type: tdd`，並對 UI、配置和膠水程式碼使用標準的 `type: execute`。

TDD 模式也可在配置中持久化：

```bash
node gsd-tools.cjs config-set workflow.tdd_mode true
```

---

## 基於跨 AI 評審反饋重新規劃

**如果已執行 `/gsd-review --phase N` 且存在 `REVIEWS.md`：**

```bash
/gsd-plan-phase 3 --reviews
```

規劃器會讀取 `REVIEWS.md` 並修訂計劃以解決反饋問題。不可與 `--gaps` 組合使用。

**如果需要自動化迴圈** — 持續重新規劃和重新評審，直至不再存在 HIGH 級別關注點：

```bash
/gsd-plan-review-convergence 3
```

收斂迴圈執行規劃 → 評審 → 重新規劃 → 再評審的週期（預設最多三次）。使用 `--max-cycles N` 可覆蓋上限。

---

## 在驗證失敗後彌補差距

**如果 `VERIFICATION.md` 存在未解決的差距，且只想針對這些差距重新規劃：**

```bash
/gsd-plan-phase 3 --gaps
```

研究階段將被跳過；規劃器直接讀取驗證中的差距資訊。

---

## 在規劃開始前驗證專案狀態

```bash
/gsd-plan-phase 2 --validate
```

在啟動研究代理前執行狀態驗證。如果懷疑 ROADMAP.md 或 STATE.md 已發生偏移，請使用此選項。

---

## 規劃完成後執行外部彈跳驗證

**如果已配置 `workflow.plan_bounce_script` 且需要對完成的計劃進行外部驗證：**

```bash
/gsd-plan-phase 1 --bounce
```

即使在配置中已啟用彈跳，也可跳過：

```bash
/gsd-plan-phase 1 --skip-bounce
```

---

## 禁止互動式確認

```bash
/gsd-plan-phase --auto
```

跳過所有提示。適用於自動化流水線。若配置中 `research_enabled` 為 false，則跳過研究階段。

---

## 計劃輸出內容

成功執行後會寫入以下檔案：

| 檔案 | 用途 |
|---|---|
| `{phase}-RESEARCH.md` | 領域研究、軟體包合法性審計、驗證架構 |
| `{phase}-VALIDATION.md` | 奈奎斯特測試對映——計劃必須滿足的測試用例（第 8 維度） |
| `{phase}-{N}-PLAN.md` | 包含前置資訊、波次分配和驗收標準的可執行任務計劃 |
| `{phase}/SKELETON.md` | Walking Skeleton（MVP 模式，僅限新專案的第一階段） |

每個 PLAN.md 包含帶有強制 `<read_first>` 和 `<acceptance_criteria>` 欄位的任務。每個 `<acceptance_criteria>` 條目均可作為源斷言、行為斷言、測試命令或 CLI 輸出進行驗證——絕不使用主觀性語言。

完整的欄位參考請參閱 [PLAN.md 模式](../reference/plan-md.md)。

### 計劃品質維度

`gsd-plan-checker` 在允許執行前從八個維度驗證計劃：

1. 任務原子性——每個任務只關注單一問題
2. 依賴正確性——波次順序一致
3. 驗收標準可驗證性——無主觀標準
4. `<read_first>` 完整性——被修改的檔案始終列入其中
5. 具體的 `<action>` 值——無模糊的"對齊"類指令
6. `must_haves` 源自階段目標
7. 需求 ID 覆蓋率——每個階段需求 ID 至少出現在一個計劃中
8. 奈奎斯特測試對映——計劃涵蓋 VALIDATION.md 中的驗證策略

修訂迴圈最多執行三次。若三次迭代後品質門控仍未通過，檢查器將顯示剩餘問題供人工審查。

---

## 重新規劃已關閉的階段

如果某階段的 `VERIFICATION.md` 中 `status: passed`，則該階段被視為已關閉。嘗試重新規劃會以錯誤終止。如果關閉操作有誤，可使用 `--force` 覆蓋：

```bash
/gsd-plan-phase 2 --force
```

警告資訊將寫入轉錄記錄和所有已提交的計劃文件中。

---

## 相關內容

- [討論階段](discuss-a-phase.md)
- [執行階段](execute-a-phase.md)
- [PLAN.md 模式](../reference/plan-md.md)
- [命令](../COMMANDS.md)
