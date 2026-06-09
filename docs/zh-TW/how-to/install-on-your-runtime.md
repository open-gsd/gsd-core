# 如何在您的執行時上安裝 GSD Core

將 GSD Core（`@opengsd/gsd-core`）安裝到您日常使用的 AI 編碼執行時中。本指南提供各支援執行時的標準安裝路徑，以及適用於未安裝 Node.js 的機器的手動安裝路徑。

**所需條件：** Node.js 18+ 及 npm（或 npx）。如果您沒有 Node.js，請跳轉至[不使用 Node.js 安裝](#不使用-nodejs-安裝)。

---

## 為什麼需要安裝程式

GSD Core 以 Claude Code 原生 frontmatter 格式分發代理和命令檔案。每個支援的執行時需要不同的 schema、目錄結構和命令呼叫語法。安裝程式負責執行必要的轉換——例如，為 OpenCode 轉換工具列表和顏色值、為 Codex 寫入 TOML 代理條目，以及將所有命令體從連字元格式（`/gsd-update`）重寫為冒號格式（`/gsd:update`）以適配 Gemini CLI。

**請勿直接從 `agents/` 或 `commands/` 複製檔案。** 這樣做會繞過轉換過程，導致 schema 驗證錯誤或命令缺失。

---

## 標準安裝

在任意目錄執行安裝程式。它會提示您選擇執行時，以及是全域性安裝（所有專案）還是本地安裝（僅此專案）。

```bash
npx @opengsd/gsd-core@latest
```

這是全新安裝或切換執行時後重新執行安裝程式所需的唯一命令。

---

## 各執行時安裝說明

### Claude Code

```bash
npx @opengsd/gsd-core@latest --claude --global
```

技能檔案存放於 `~/.claude/`。下次 Claude Code 會話中，命令將以 `/gsd-*` 斜槓命令的形式出現。重啟 Claude Code 以載入它們。

**覆蓋安裝目錄：**

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt npx @opengsd/gsd-core@latest --claude --global
```

---

### Gemini CLI

```bash
npx @opengsd/gsd-core@latest --gemini --global
```

技能檔案存放於 `~/.gemini/`。安裝程式將所有命令體重寫為 Gemini 的冒號名稱空間格式（`/gsd:update`、`/gsd:config` 等）。安裝後重啟 Gemini CLI。

**覆蓋安裝目錄：**

```bash
GEMINI_CONFIG_DIR=~/.gemini-alt npx @opengsd/gsd-core@latest --gemini --global
```

---

### OpenCode

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

技能檔案存放於 `~/.config/opencode/`（XDG）或 `~/.opencode/`。安裝程式將代理 frontmatter 轉換為 OpenCode 的 schema——移除 `tools:` 欄位並將顏色值轉換為十六進位制格式。如需瞭解具體變更內容，請參閱[不使用 Node.js 安裝 — OpenCode 轉換](#opencode--必要轉換)。

**覆蓋安裝目錄：**

```bash
OPENCODE_CONFIG_DIR=~/.config/opencode-alt npx @opengsd/gsd-core@latest --opencode --global
```

---

### Kilo

```bash
npx @opengsd/gsd-core@latest --kilo --global
```

技能檔案存放於 `~/.config/kilo/`（XDG）或 `~/.kilo/`。使用與 OpenCode 相同的平鋪 Markdown 命令格式。

**覆蓋安裝目錄：**

```bash
KILO_CONFIG_DIR=~/.config/kilo-alt npx @opengsd/gsd-core@latest --kilo --global
```

---

### Codex

```bash
npx @opengsd/gsd-core@latest --codex --global
```

技能檔案存放於 `~/.codex/skills/gsd-*/SKILL.md`。代理以每個代理獨立的 TOML 條目寫入 `config.toml`。安裝後重啟 Codex（或執行 `codex --reload`）。

**最低支援版本：** Codex CLI 0.130.0。更早版本額外掃描技能根目錄，可能導致重複列出條目。

---

### GitHub Copilot

```bash
npx @opengsd/gsd-core@latest --copilot --global
```

技能檔案存放於 `~/.copilot/`。GSD 以代理 `.md` 檔案和倉庫指令檔案的形式安裝。

**覆蓋安裝目錄：**

```bash
COPILOT_CONFIG_DIR=~/.copilot-alt npx @opengsd/gsd-core@latest --copilot --global
```

---

### Cursor

```bash
npx @opengsd/gsd-core@latest --cursor --global
```

技能檔案存放於 `~/.cursor/`。GSD 安裝技能、代理和規則引用。

**覆蓋安裝目錄：**

```bash
CURSOR_CONFIG_DIR=~/.cursor-alt npx @opengsd/gsd-core@latest --cursor --global
```

---

### Windsurf

```bash
npx @opengsd/gsd-core@latest --windsurf --global
```

技能檔案存放於 `~/.codeium/windsurf/`。GSD 安裝技能、代理和工作區規則。

**覆蓋安裝目錄：**

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-alt npx @opengsd/gsd-core@latest --windsurf --global
```

---

### Cline

Cline 使用基於規則的整合方式——GSD 以 `.clinerules` 形式安裝，而非斜槓命令。

```bash
# 全域性安裝（所有專案）
npx @opengsd/gsd-core@latest --cline --global

# 本地安裝（僅此專案）
npx @opengsd/gsd-core@latest --cline --local
```

全域性安裝寫入 `~/.cline/`。本地安裝寫入 `./.cline/`。規則由 Cline 自動載入——不註冊自定義斜槓命令。

---

### CodeBuddy

```bash
npx @opengsd/gsd-core@latest --codebuddy --global
```

技能檔案存放於 `~/.codebuddy/skills/gsd-*/SKILL.md`。

---

### Qwen Code

Qwen Code 使用與 Claude Code 2.1.88+ 相同的開放技能標準。

```bash
npx @opengsd/gsd-core@latest --qwen --global
```

技能檔案存放於 `~/.qwen/skills/gsd-*/SKILL.md`。

**覆蓋安裝目錄：**

```bash
QWEN_CONFIG_DIR=~/.qwen-alt npx @opengsd/gsd-core@latest --qwen --global
```

---

### Augment Code

```bash
npx @opengsd/gsd-core@latest --augment --global
```

技能檔案存放於 `~/.augment/`。GSD 安裝技能和代理，不擁有 hook 或狀態列所有權。

---

### Antigravity

```bash
npx @opengsd/gsd-core@latest --antigravity --global
```

安裝程式自動檢測 Antigravity 配置目錄（`~/.gemini/antigravity`、`~/.gemini/antigravity-ide` 或 `~/.gemini/antigravity-cli`）。使用與 Gemini 相容的設定策略。

**覆蓋安裝目錄：**

```bash
ANTIGRAVITY_CONFIG_DIR=~/.gemini/antigravity-alt npx @opengsd/gsd-core@latest --antigravity --global
```

---

### Trae

```bash
npx @opengsd/gsd-core@latest --trae --global
```

技能檔案存放於 `~/.trae/`。GSD 安裝技能、代理和規則引用。

---

## 本地安裝與全域性安裝

上述所有示例均使用 `--global`，即為您的使用者賬戶全域性安裝 GSD。若要將安裝範圍限定到單個專案，請將 `--global` 替換為 `--local`：

```bash
npx @opengsd/gsd-core@latest --claude --local
```

本地安裝寫入專案根目錄下的 `.claude/` 目錄。當全域性安裝和本地安裝同時存在時，本地安裝的設定優先於全域性設定。

---

## 安裝預釋出版（Next / Nightly / Insiders / Preview）

執行時的預釋出版（Windsurf Next、Cursor Nightly、VS Code Insiders、Codex 預覽通道等）從同級配置目錄讀取配置。在執行安裝程式前設定對應的 `*_CONFIG_DIR` 環境變數：

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

在安裝程式提示中選擇對應的穩定版執行時。GSD 不將預釋出版作為獨立命名執行時列舉——它們通過此環境變數機制提供盡力支援，不在釋出 CI 中單獨測試。

---

## 不使用 Node.js 安裝

如果您無法執行 `npx`（例如在沒有 Node.js 的 Windows 機器上），有兩種方案可選。

**方案 A——使用有 Node.js 的機器。** 任何有 Node.js 的機器均可：WSL、Linux 虛擬機器、CI runner 或 Docker 容器。在那臺機器上執行安裝程式，然後將輸出目錄複製到目標機器。以 OpenCode 為例：

```bash
npx @opengsd/gsd-core@latest --opencode --global
# 然後將 ~/.config/opencode/agents/ 複製到 Windows 機器
```

**方案 B——手動轉換原始檔。** 代理原始檔位於 GSD Core 倉庫的 `agents/` 目錄下，格式為 Claude Code 原生 frontmatter 格式。每個執行時期望不同的結構。有關各執行時的具體欄位轉換說明，請參閱使用者指南中的[手動安裝 / 無 Node.js 設定](../USER-GUIDE.md#manual-install--no-nodejs-setup)，其中詳細介紹了 OpenCode 的轉換內容，並指向安裝程式中其他執行時對應的 `convert*Frontmatter` 函式。

---

## 安裝後

重啟您的執行時以載入新命令和代理。然後啟動您的第一個專案：

```bash
/gsd-new-project
```

如果重啟後找不到該命令，請確認安裝目錄與執行時預期的配置路徑匹配。上方的預釋出版章節介紹了最常見的路徑不匹配情況。

---

## 相關連結

- [您的第一個專案](../tutorials/your-first-project.md)
- [更新 GSD Core](update-gsd.md)
- [配置](../CONFIGURATION.md)
- [文件索引](../README.md)
