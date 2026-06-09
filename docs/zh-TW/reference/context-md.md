# CONTEXT.md 結構參考

每個階段的 `CONTEXT.md` 是 GSD Core 用於儲存 `/gsd:discuss-phase` 階段所收集的實現決策的載體。它是研究代理和規劃代理的主要上游輸入。本頁面記錄其結構。參見[文件索引](../README.md)。

---

## 概述

每個經過討論工作流處理的階段，均會在以下路徑生成一份 `CONTEXT.md`：

```
.planning/phases/<NN>-<slug>/<NN>-CONTEXT.md
```

示例：`.planning/phases/03-post-feed/03-CONTEXT.md`。

該檔案由 `get-shit-done/workflows/discuss-phase.md` 中的 `write_context` 步驟生成（或通過 PRD/ADR 攝入快速路徑生成）。在正常操作中，該檔案不會被手動編輯——討論階段工作流負責寫入，下游代理將其作為封閉的可信來源讀取。

---

## 前言（Frontmatter）

`CONTEXT.md` 不包含 YAML 前言。後設資料以內聯形式寫在正文頂部：

```markdown
# Phase [X]: [Name] - Context

**Gathered:** [ISO date]
**Status:** Ready for planning
```

`Status` 欄位在檔案首次寫入時始終為 `Ready for planning`，建立後不再更新。

---

## 塊結構

正文由若干具名 XML 風格的塊組成，以固定順序出現。下游代理通過塊名而非行號來讀取各塊內容。

| 塊名 | 用途 | 由誰填充 | 由誰消費 |
|---|---|---|---|
| `<domain>` | 宣告階段邊界——本階段交付內容及明確排除在範圍之外的內容。在規劃和執行過程中為範圍護欄提供錨點。 | `discuss-phase`（來自 ROADMAP.md 階段目標） | `gsd-planner`、`gsd-plan-checker`（範圍合規性） |
| `<spec_lock>` | 僅在 `check_spec` 步驟發現 `*-SPEC.md` 時才存在。列出鎖定的需求數量和範圍邊界；代理被指示直接讀取 `SPEC.md` 以獲取完整需求。 | `discuss-phase`（條件性） | `gsd-planner`（直接讀取 SPEC.md，而非在此重讀需求） |
| `<decisions>` | 從討論中收集的實現決策，使用 `D-NN` 識別符號標註。分類由實際討論內容產生，而非固定分類體系。包含 `Claude's Discretion` 子節，用於使用者委託代理自行決定的領域。 | `discuss-phase`（互動式討論） | `gsd-planner`（鎖定的決策必須實現）、`gsd-plan-checker`（維度 7 合規性） |
| `<canonical_refs>` | 與本階段相關的所有規格文件、ADR、功能文件或設計文件的完整相對路徑。必填——每份 CONTEXT.md 必須包含此節。代理在規劃或實現之前必須讀取列出的檔案。 | `discuss-phase`（從 ROADMAP.md 引用 + 討論中的使用者引用 + 程式碼庫偵查積累） | `gsd-phase-researcher`、`gsd-planner` |
| `<code_context>` | 在 `scout_codebase` 步驟中發現的可複用資產、已建立的模式和整合點。引導代理使用現有程式碼，而非重新實現。 | `discuss-phase`（程式碼庫偵查） | `gsd-planner`、`gsd-phase-researcher` |
| `<specifics>` | 討論期間逐字記錄的具體"我希望它像 X 一樣"的參考、產品對比或特定示例。 | `discuss-phase`（自由形式使用者輸入） | `gsd-planner` |
| `<deferred>` | 討論中出現但屬於其他階段的想法，予以保留以免遺失。當待辦事項經過審查但未納入範圍時，包含 `Reviewed Todos` 子節。 | `discuss-phase`（範圍蔓延重定向） | 不被自動化代理消費；僅供人工參考 |

---

## 決策識別符號格式

`<decisions>` 中的每條決策均帶有順序編號的 `D-NN` 識別符號：

```markdown
### Layout style
- **D-01:** Card-based layout, not timeline or list
- **D-02:** Each card shows: author avatar, name, timestamp, full post content, reaction counts
```

識別符號的作用域限定在階段內。第 3 階段中的 `D-01` 與第 7 階段中的 `D-01` 無關。計劃檢查器（維度 7）會驗證每個 `D-NN` 是否在生成計劃中至少有一個任務動作加以覆蓋。

---

## 規範引用

`<canonical_refs>` 塊為**必填項**。如果代理發現其缺失，會將該 CONTEXT.md 視為不完整併發出警告。條目按主題分組，包含完整相對路徑以及對檔案所決定或定義內容的簡要說明：

```markdown
<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Feed display
- `docs/features/social-feed.md` — Feed requirements, post card fields, engagement display rules
- `docs/decisions/adr-012-infinite-scroll.md` — Scroll strategy decision, virtualisation requirements

### Empty states
- `docs/design/empty-states.md` — Empty state patterns, illustration guidelines

</canonical_refs>
```

當專案沒有外部規格文件時，該節應明確說明：

```
No external specs — requirements fully captured in decisions above
```

在 `<decisions>` 中散落的內聯提及（如"參見 ADR-019"）是不夠的；代理需要在專用節中獲取完整路徑。

---

## 決策覆蓋關卡關係

計劃檢查器的**維度 7：上下文合規性**在規劃完成後執行覆蓋關卡檢查：

1. `<decisions>` 中的每個 `D-NN` 識別符號必須出現在至少一個計劃任務的 `<action>` 或說明中。
2. 任何任務均不得實現 `<deferred>` 中列出的內容（即範圍蔓延）。
3. `Claude's Discretion` 領域免於此檢查——規劃者可自由選擇。

決策被成功納入計劃的 CONTEXT.md 被視為合規。決策被悄然丟棄或部分交付的 CONTEXT.md 會觸發**維度 7b：範圍縮減檢測**，這始終是一個**阻斷項**。

---

## SPEC.md 整合

當 `/gsd:spec-phase` 在討論階段之前執行時，`check_spec` 步驟會找到 `*-SPEC.md` 檔案並激活 `<spec_lock>`：

```markdown
<spec_lock>
## Requirements (locked via SPEC.md)

**12 requirements are locked.** See `03-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `03-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):** [copied from SPEC.md Boundaries]
**Out of scope (from SPEC.md):** [copied from SPEC.md Boundaries]

</spec_lock>
```

當 `<spec_lock>` 存在時，`<decisions>` 中僅包含來自討論的實現決策——即"如何做"，而非"做什麼"。需求不會在兩個檔案之間重複。

---

## 頁尾

每份 CONTEXT.md 以身份頁尾結尾：

```markdown
---

*Phase: XX-name*
*Context gathered: [date]*
```

---

## 相關內容

- [PLAN.md 結構](plan-md.md)
- [規劃產物](planning-artifacts.md)
- [討論模式](../workflow-discuss-mode.md)
- [文件索引](../README.md)
