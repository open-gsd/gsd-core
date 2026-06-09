# GSD Core 文件

文件按四個象限組織：**教程**通過實踐幫助你學習，**操作指南**解決具體任務，**參考文件**提供權威資訊，**概念說明**探討設計理念與決策。

語言版本：[English](../README.md) · [Português (pt-BR)](../pt-BR/README.md) · [日本語](../ja-JP/README.md) · [简体中文](../zh-CN/README.md) · **繁體中文**

---

## Tutorials

- [第一個專案](tutorials/your-first-project.md) — 從安裝到首個已交付階段，一條有保障的路徑
- [接入現有程式碼庫](tutorials/onboarding-an-existing-codebase.md) — 將 GSD Core 引入已有專案的程式碼庫

---

## How-to guides

- [在你的執行時上安裝](how-to/install-on-your-runtime.md) — 適用於全部 15 個受支援執行時的安裝步驟
- [討論一個階段](how-to/discuss-a-phase.md) — 在規劃開始前記錄實現決策
- [規劃一個階段](how-to/plan-a-phase.md) — 執行調研、分解工作並驗證計劃品質
- [執行一個階段](how-to/execute-a-phase.md) — 使用全新上下文的子代理以並行波次執行計劃
- [驗證並交付](how-to/verify-and-ship.md) — 審查已完成的工作、診斷失敗並建立 PR
- [自主執行階段](how-to/run-phases-autonomously.md) — 使用自主模式進行無人值守的階段執行
- [處理快速臨時任務](how-to/handle-quick-and-fast-tasks.md) — 使用 `/gsd-quick` 和 `/gsd-fast` 處理階段迴圈之外的臨時工作
- [配置模型配置檔案](how-to/configure-model-profiles.md) — 在高品質、均衡和經濟模型層級之間切換
- [設定跨 AI 審查](how-to/set-up-cross-ai-review.md) — 配置第二個 AI 對主代理生成的程式碼進行審查
- [使用工作流並行工作](how-to/work-in-parallel-with-workstreams.md) — 使用工作流同時執行獨立的工作線
- [使用工作空間隔離工作](how-to/isolate-work-with-workspaces.md) — 使用工作空間對實驗性或高風險變更進行沙箱隔離
- [除錯失敗的執行](how-to/debug-a-failed-execution.md) — 診斷並從中斷或不完整的階段執行中恢復
- [探索與草圖](how-to/spike-and-sketch.md) — 在提交計劃之前，使用 `/gsd-spike` 和 `/gsd-sketch` 進行探索性工作
- [設計 UI 階段](how-to/design-a-ui-phase.md) — 使用 UI 階段迴圈處理前端和視覺工作
- [從追蹤器 Issue 驅動 GSD](how-to/drive-gsd-from-a-tracker-issue.md) — 從 GitHub、Linear 或 Jira issue 啟動一個階段
- [從 GSD 2 遷移](how-to/migrate-from-gsd-2.md) — 將現有的 GSD 2 專案升級到 GSD Core
- [更新 GSD](how-to/update-gsd.md) — 重新執行安裝程式以獲取最新版本
- [恢復與故障排查](how-to/recover-and-troubleshoot.md) — 修復常見問題、重建上下文並解除安裝

---

## Reference

- [命令](COMMANDS.md) — 每個命令的標誌和示例
- [配置](CONFIGURATION.md) — 完整配置模式、模型配置檔案、Git 分支策略
- [CLI 工具](CLI-TOOLS.md) — `gsd-tools.cjs` 用於工作流和代理的程式設計式 API
- [功能特性](FEATURES.md) — 完整功能索引
- [清單](INVENTORY.md) — 已安裝的技能與介面對映
- [STATE.md 模式](reference/state-md.md) — `.planning/STATE.md` 的逐欄位參考
- [CONTEXT.md 模式](reference/context-md.md) — `.planning/phases/<N>/CONTEXT.md` 的逐欄位參考
- [PLAN.md 模式](reference/plan-md.md) — `.planning/phases/<N>/PLAN.md` 的逐欄位參考
- [規劃產物](reference/planning-artifacts.md) — 所有 `.planning/` 檔案及其作用

---

## Explanation

- [上下文工程](explanation/context-engineering.md) — 上下文腐化如何形成，以及 GSD Core 如何防止它
- [階段迴圈](explanation/the-phase-loop.md) — 討論 → 規劃 → 執行 → 驗證 → 交付迴圈的設計原理
- [多代理編排](explanation/multi-agent-orchestration.md) — 子代理的生成、範圍界定和協調方式
- [安全模型](explanation/security-model.md) — 信任邊界、許可權和安全自動化
- [架構](ARCHITECTURE.md) — 系統架構、代理模型和資料流
- [討論模式](workflow-discuss-mode.md) — `/gsd-discuss-phase` 的假設模式與訪談模式
- [上下文監控](context-monitor.md) — 上下文視窗監控鉤子架構
- [Issue 驅動編排](issue-driven-orchestration.md) — 使用現有原語從追蹤器 issue 驅動 GSD 的方案

---

## Related

- [根目錄 README](../README.md) — 首頁、快速開始和文件概覽
- [變更日誌](../../CHANGELOG.md) — 釋出歷史
