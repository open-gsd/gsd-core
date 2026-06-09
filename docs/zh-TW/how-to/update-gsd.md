# 如何更新 GSD Core

將現有的 GSD Core 安裝更新到最新版本，在確認前預覽變更日誌，並恢復可能被更新覆蓋的本地自定義配置。

**所需條件：** 與 GSD 安裝時相同的執行時環境。更新命令在後臺重新執行安裝程式，因此需要 Node.js 和 npx（與最初安裝時的要求相同）。

---

## 標準更新流程

在 AI 執行時內，執行：

```bash
/gsd-update
```

GSD 將執行以下操作：

1. 檢測已安裝的版本和安裝範圍（全域性或本地）。
2. 通過 npm 檢查 `@opengsd/gsd-core` 的最新版本。
3. 獲取變更日誌，並顯示您已安裝版本與最新版本之間的變更內容。
4. 在執行任何操作前請求確認。
5. 將 GSD 管理目錄中發現的使用者新增檔案備份至 `gsd-user-files-backup/`。
6. 執行安裝程式（`npx @opengsd/gsd-core@latest --<runtime> --<scope>`）。
7. 清除更新檢查快取，使狀態列指示器重置。
8. 報告本地修改的 GSD 檔案是否已備份至 `gsd-local-patches/`。

更新完成後請重啟執行時，以載入新的命令和代理。

---

## 命令標誌

| 標誌 | 功能說明 |
|------|--------------|
| `--sync` | 更新後，從 GSD 登錄檔同步技能 |
| `--reapply` | 更新後，將 `gsd-local-patches/` 中本地修改的 GSD 檔案合併回來 |

```bash
/gsd-update --sync        # Update and sync skills
/gsd-update --reapply     # Update and reapply local patches
```

---

## 更新前檢視變更日誌

`/gsd-update` 在請求確認*之前*，始終會顯示您已安裝版本與最新版本之間的變更日誌差異。您無需另行訪問 GitHub。輸出內容如下所示：

```text
## GSD Update Available

Installed: 1.39.0
Latest:    1.41.0

### What's New
────────────────────────────────────────────────────────────
[changelog entries for 1.40.0 and 1.41.0]
────────────────────────────────────────────────────────────

Proceed with update? [Yes, update now / No, cancel]
```

如果無法獲取變更日誌（無網路訪問、npm 中斷），更新在確認後仍會繼續進行——不會因變更日誌不可用而被阻斷。

---

## 恢復本地自定義配置

### 您在 GSD 管理目錄中新增的檔案

如果您在 GSD 管理的目錄中放置了自定義檔案（例如，以 `gsd-` 為字首的自定義代理，或 `commands/gsd/` 中的額外檔案），安裝程式會在清除這些目錄前檢測到它們，並將其複製到 `gsd-user-files-backup/`。更新完成後，請從該備份位置手動恢復這些檔案。

您放置在 GSD 管理目錄之外的檔案——不以 `gsd-` 為字首的自定義代理、`commands/gsd/` 之外的自定義命令、您的 `CLAUDE.md` 檔案以及自定義鉤子——安裝程式不會對其進行任何操作。

### 您直接修改的 GSD 檔案

如果您編輯了 GSD 安裝的某個檔案（例如，調整了某個代理的系統提示），安裝程式會通過與清單的雜湊比對檢測到該修改，將檔案備份至 `gsd-local-patches/`，然後用新版本替換它。更新完成後，執行：

```bash
/gsd-update --reapply
```

此命令會將您在 `gsd-local-patches/` 中的修改合併回新安裝的檔案中。

如果您在之前的更新後跳過了 `--reapply`，現在想應用補丁，執行：

```bash
/gsd-update --reapply
```

單獨執行 `--reapply` 而不觸發新下載是安全的——如果您已是最新版本，GSD 會跳過安裝步驟，直接執行補丁重新應用。

---

## 當 npm 不可用時

如果 `npx @opengsd/gsd-core@latest` 因 npm 中斷、網路限制，或因您正在使用原始碼倉庫而失敗，請使用 [docs/manual-update.md](../../manual-update.md) 中的手動更新流程。該文件涵蓋拉取最新提交、構建鉤子分發包以及直接執行 `node bin/install.js` 的步驟。

---

## 如果您已是最新版本

`/gsd-update` 會提前退出並顯示確認訊息——無需下載、無需安裝、無需重啟。

---

## 安裝程式遷移

每個 GSD 版本可能包含安裝程式遷移，用於重新命名、移動或停用管理檔案。遷移層會在寫入新包內容之前自動執行。會影響您已修改檔案的遷移操作將提示確認，而不是靜默執行。有關完整設計和執行時配置合約登錄檔，請參閱 [docs/installer-migrations.md](../../installer-migrations.md)。

---

## 相關內容

- [在您的執行時上安裝](install-on-your-runtime.md)
- [命令參考](../COMMANDS.md)
- [手動更新](../../manual-update.md)
- [安裝程式遷移](../../installer-migrations.md)
- [文件索引](../README.md)
