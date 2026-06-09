<overview>
TDD 關乎設計品質，而非覆蓋率指標。紅-綠-重構迴圈迫使你在實現前思考行為，從而產生更清晰的介面和更可測試的程式碼。

**原則：** 如果在編寫 `fn` 之前能用 `expect(fn(input)).toBe(output)` 描述行為，TDD 會改善結果。

**關鍵洞察：** TDD 工作本質上比標準任務更重 —— 它需要 2-3 個執行週期（RED → GREEN → REFACTOR），每個週期都涉及檔案讀取、測試執行和可能的除錯。TDD 功能獲得專門的計劃，以確保整個週期內有完整的上下文可用。
</overview>

<when_to_use_tdd>
## 何時 TDD 提高品質

**TDD 候選（建立 TDD 計劃）：**
- 有明確輸入/輸出的業務邏輯
- 有請求/響應契約的 API 端點
- 資料轉換、解析、格式化
- 驗證規則和約束
- 有可測試行為的演算法
- 狀態機和工作流
- 有清晰規格的工具函式

**跳過 TDD（使用帶 `type="auto"` 任務的標準計劃）：**
- UI 佈局、樣式、視覺元件
- 配置更改
- 連線現有元件的膠水程式碼
- 一次性指令碼和遷移
- 無業務邏輯的簡單 CRUD
- 探索性原型

**啟發式：** 能在編寫 `fn` 之前寫 `expect(fn(input)).toBe(output)` 嗎？
→ 能：建立 TDD 計劃
→ 不能：使用標準計劃，事後新增測試（如需要）
</when_to_use_tdd>

<tdd_plan_structure>
## TDD 計劃結構

每個 TDD 計劃通過完整的 RED-GREEN-REFACTOR 迴圈實現**一個功能**。

```markdown
---
phase: XX-name
plan: NN
type: tdd
---

<objective>
[什麼功能以及為什麼]
Purpose: [該功能 TDD 的設計收益]
Output: [可工作的、已測試的功能]
</objective>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@relevant/source/files.ts
</context>

<feature>
  <name>[功能名稱]</name>
  <files>[原始檔, 測試檔案]</files>
  <behavior>
    [可測試術語描述的預期行為]
    Cases: 輸入 → 預期輸出
  </behavior>
  <implementation>[測試通過後如何實現]</implementation>
</feature>

<verification>
[證明功能有效的測試命令]
</verification>

<success_criteria>
- 失敗測試已編寫並提交
- 實現通過測試
- 重構完成（如需要）
- 所有 2-3 個提交都存在
</success_criteria>

<output>
完成後，建立包含以下內容的 SUMMARY.md：
- RED: 編寫了什麼測試，為什麼失敗
- GREEN: 什麼實現讓它通過
- REFACTOR: 做了什麼清理（如有）
- Commits: 生成的提交列表
</output>
```

**每個 TDD 計劃一個功能。** 如果功能足夠簡單可以批次處理，那就足夠簡單可以跳過 TDD —— 使用標準計劃，事後新增測試。
</tdd_plan_structure>

<execution_flow>
## 紅-綠-重構迴圈

**RED - 編寫失敗測試：**
1. 按專案約定建立測試檔案
2. 編寫描述預期行為的測試（來自 `<behavior>` 元素）
3. 執行測試 - 必須**失敗**
4. 如果測試通過：功能已存在或測試有誤。調查。
5. 提交：`test({phase}-{plan}): add failing test for [feature]`

**GREEN - 實現使其通過：**
1. 編寫使測試通過的最小程式碼
2. 不耍小聰明，不最佳化 - 只讓它工作
3. 執行測試 - 必須**通過**
4. 提交：`feat({phase}-{plan}): implement [feature]`

**REFACTOR（如需要）：**
1. 如果存在明顯的改進，清理實現
2. 執行測試 - 必須**仍然通過**
3. 僅在做出更改時提交：`refactor({phase}-{plan}): clean up [feature]`

**結果：** 每個 TDD 計劃產生 2-3 個原子提交。
</execution_flow>

<test_quality>
## 好測試 vs 壞測試

**測試行為，而非實現：**
- 好："返回格式化的日期字串"
- 壞："用正確引數呼叫 formatDate 輔助函式"
- 測試應該能經受重構

**每個測試一個概念：**
- 好：分別為有效輸入、空輸入、畸形輸入編寫測試
- 壞：用多個斷言檢查所有邊緣情況的單個測試

**描述性名稱：**
- 好："should reject empty email"、"returns null for invalid ID"
- 壞："test1"、"handles error"、"works correctly"

**不包含實現細節：**
- 好：測試公共 API、可觀察行為
- 壞：Mock 內部實現、測試私有方法、斷言內部狀態
</test_quality>

<framework_setup>
## 測試框架設定（如不存在）

當執行 TDD 計劃但沒有配置測試框架時，作為 RED 階段的一部分進行設定：

**1. 檢測專案型別：**
```bash
# JavaScript/TypeScript
if [ -f package.json ]; then echo "node"; fi

# Python
if [ -f requirements.txt ] || [ -f pyproject.toml ]; then echo "python"; fi

# Go
if [ -f go.mod ]; then echo "go"; fi

# Rust
if [ -f Cargo.toml ]; then echo "rust"; fi
```

**2. 安裝最小框架：**
| 專案 | 框架 | 安裝 |
|---------|-----------|---------|
| Node.js | Jest | `npm install -D jest @types/jest ts-jest` |
| Node.js (Vite) | Vitest | `npm install -D vitest` |
| Python | pytest | `pip install pytest` |
| Go | testing | 內建 |
| Rust | cargo test | 內建 |

**3. 按需建立配置：**
- Jest: 帶 ts-jest preset 的 `jest.config.js`
- Vitest: 帶測試全域性變數的 `vitest.config.ts`
- pytest: `pytest.ini` 或 `pyproject.toml` 部分

**4. 驗證設定：**
```bash
# 執行空測試套件 - 應該以 0 個測試通過
npm test  # Node
pytest    # Python
go test ./...  # Go
cargo test    # Rust
```

**5. 建立第一個測試檔案：**
遵循專案約定的測試位置：
- 原始檔旁邊的 `*.test.ts` / `*.spec.ts`
- `__tests__/` 目錄
- 根目錄的 `tests/` 目錄

框架設定是第一個 TDD 計劃 RED 階段的一次性成本。
</framework_setup>

<error_handling>
## 錯誤處理

**測試在 RED 階段沒有失敗：**
- 功能可能已存在 - 調查
- 測試可能有誤（沒測試你以為的東西）
- 前進前修復

**測試在 GREEN 階段沒有通過：**
- 除錯實現
- 不要跳到重構
- 持續迭代直到綠色

**測試在 REFACTOR 階段失敗：**
- 撤銷重構
- 提交過早
- 用更小的步驟重構

**不相關的測試失敗：**
- 停下來調查
- 可能表明耦合問題
- 前進前修復
</error_handling>

<commit_pattern>
## TDD 計劃的提交模式

TDD 計劃產生 2-3 個原子提交（每個階段一個）：

```
test(08-02): add failing test for email validation

- Tests valid email formats accepted
- Tests invalid formats rejected
- Tests empty input handling

feat(08-02): implement email validation

- Regex pattern matches RFC 5322
- Returns boolean for validity
- Handles edge cases (empty, null)

refactor(08-02): extract regex to constant (optional)

- Moved pattern to EMAIL_REGEX constant
- No behavior changes
- Tests still pass
```

**與標準計劃對比：**
- 標準計劃：每個任務 1 個提交，每個計劃 2-4 個提交
- TDD 計劃：單個功能 2-3 個提交

兩者遵循相同格式：`{type}({phase}-{plan}): {description}`

**好處：**
- 每個提交獨立可回滾
- Git bisect 在提交級別工作
- 顯示 TDD 紀律的清晰歷史
- 與整體提交策略一致
</commit_pattern>

<context_budget>
## 上下文預算

TDD 計劃目標 **~40% 上下文使用率**（低於標準計劃的 ~50%）。

為什麼更低：
- RED 階段：編寫測試、執行測試、可能除錯為什麼沒有失敗
- GREEN 階段：實現、執行測試、可能對失敗進行迭代
- REFACTOR 階段：修改程式碼、執行測試、驗證無迴歸

每個階段涉及讀取檔案、執行命令、分析輸出。來回往復本質上比線性任務執行更重。

單一功能聚焦確保整個週期保持完整品質。
</context_budget>