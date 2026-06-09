<div align="center">

# GSD Core

**Git. Ship. Done.**

[English](README.md) · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md) · **繁體中文** · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

**一套輕量級的元提示、上下文工程與規範驅動開發系統，適用於 Claude Code、OpenCode、Gemini CLI、Kilo、Codex、Copilot、Cursor、Windsurf 等 AI 程式設計工具。**

[![npm version](https://img.shields.io/npm/v/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![npm downloads](https://img.shields.io/npm/dm/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![Tests](https://img.shields.io/github/actions/workflow/status/open-gsd/gsd-core/test.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/open-gsd/gsd-core/actions/workflows/test.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/mYgfVNfA2r)
[![GitHub stars](https://img.shields.io/github/stars/open-gsd/gsd-core?style=for-the-badge&logo=github&color=181717)](https://github.com/open-gsd/gsd-core)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## 什麼是 GSD Core

GSD Core 是一套上下文工程與規範驅動開發框架，能夠引導 AI 程式設計智慧體（Claude Code、Codex、Gemini CLI、Copilot、Cursor 等）按照嚴格的階段迴圈推進工作。它解決了[上下文腐化](docs/zh-TW/explanation/context-engineering.md)問題——即隨著 AI 填滿上下文視窗而逐漸累積的品質下降——通過在全新上下文的子智慧體中執行所有繁重的研究、規劃和執行工作，同時保持主會話的精簡。

---

## 工作原理

每個里程碑重複相同的五步迴圈，每次推進一個階段：

1. **討論（Discuss）** — 在規劃任何內容之前，先捕獲實現決策
2. **規劃（Plan）** — 研究、分解，並驗證計劃能夠適配全新的上下文視窗
3. **執行（Execute）** — 以並行波次執行計劃；每個執行器以乾淨的 20 萬 token 上下文啟動
4. **驗證（Verify）** — 檢查已構建的內容；在宣告完成前診斷並修復問題
5. **交付（Ship）** — 建立 PR，歸檔階段，對下一個階段重複上述流程

---

## 快速開始

```bash
npx @opengsd/gsd-core@latest
```

安裝程式會提示選擇執行時（Claude Code、OpenCode、Gemini CLI、Kilo、Codex、Copilot、Cursor、Windsurf 等）以及是全域性安裝還是本地安裝。跨執行時相容性需要使用安裝程式——請勿直接從 `agents/` 或 `commands/` 目錄複製檔案。

使用其他執行時或沒有 Node.js？請參閱[在你的執行時上安裝](docs/zh-TW/how-to/install-on-your-runtime.md)。

安裝完成後，啟動你的第一個專案：

```bash
/gsd-new-project
```

初次使用？請按照[你的第一個專案](docs/zh-TW/tutorials/your-first-project.md)進行引導式操作，從安裝到完成第一個交付階段。

---

## 文件

**教程** — 邊做邊學：
- [你的第一個專案](docs/zh-TW/tutorials/your-first-project.md)
- [接入現有程式碼庫](docs/zh-TW/tutorials/onboarding-an-existing-codebase.md)

**操作指南** — 面向任務的實用方法：
- [在你的執行時上安裝](docs/zh-TW/how-to/install-on-your-runtime.md)
- [規劃一個階段](docs/zh-TW/how-to/plan-a-phase.md)
- [驗證與交付](docs/zh-TW/how-to/verify-and-ship.md)
- … [檢視所有操作指南](docs/zh-TW/README.md#how-to-guides)

**參考文件** — 權威資訊：
- [命令](docs/zh-TW/COMMANDS.md)
- [配置](docs/zh-TW/CONFIGURATION.md)
- [CLI 工具](docs/zh-TW/CLI-TOOLS.md)

**概念說明** — 設計理念與決策：
- [上下文工程](docs/zh-TW/explanation/context-engineering.md)
- [階段迴圈](docs/zh-TW/explanation/the-phase-loop.md)
- [架構](docs/zh-TW/ARCHITECTURE.md)

完整索引：[docs/zh-TW/README.md](docs/zh-TW/README.md)。其他語言：[日本語](README.ja-JP.md) · [한국어](README.ko-KR.md) · [Português](README.pt-BR.md) · [English](README.md) · [简体中文](README.zh-CN.md)。

---

## 為什麼有效

大多數 AI 程式設計方案在規模化時都會失敗，原因在於上下文膨脹會悄無聲息地降低輸出品質，各會話之間沒有共享記憶，也沒有任何機制來驗證程式碼是否真正可用。GSD Core 解決了這三個問題：繁重的工作在全新的子智慧體中執行，`STATE.md` 和 `CONTEXT.md` 等結構化工件能夠跨越會話邊界保持存續，驗證步驟會檢查已構建的內容並在宣告階段完成前生成修復計劃。完整的設計思路請參閱 [docs/zh-TW/explanation/context-engineering.md](docs/zh-TW/explanation/context-engineering.md)。

遇到問題？請參閱 [docs/zh-TW/how-to/recover-and-troubleshoot.md](docs/zh-TW/how-to/recover-and-troubleshoot.md)。

---

## 社群

| 專案 | 平臺 |
|---------|----------|
| [gsd-opencode](https://github.com/rokicool/gsd-opencode) | 原始 OpenCode 移植版 |
| [Discord](https://discord.gg/mYgfVNfA2r) | 社群支援 |

---

## Star History

<a href="https://star-history.com/#open-gsd/gsd-core&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
 </picture>
</a>

---

## 許可證

MIT 許可證。詳情請參閱 [LICENSE](LICENSE)。

---

<div align="center">

**Claude Code 功能強大。GSD Core 讓它更可靠。**

</div>
