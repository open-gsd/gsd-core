# 階段引數解析

為操作階段的命令解析和規範化階段引數。

## 提取

從 `$ARGUMENTS` 中：
- 提取階段編號（第一個數字引數）
- 提取標誌（以 `--` 為字首）
- 剩餘文本為描述（用於 insert/add 命令）

## 使用 gsd-tools

`find-phase` 命令一步完成規範化和驗證：

```bash
PHASE_INFO=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" find-phase "${PHASE}")
```

返回 JSON 包含：
- `found`: true/false
- `directory`: 階段目錄的完整路徑
- `phase_number`: 規範化的編號（如 "06"、"06.1"）
- `phase_name`: 名稱部分（如 "foundation"）
- `plans`: PLAN.md 檔案陣列
- `summaries`: SUMMARY.md 檔案陣列

## 手動規範化（遺留）

將整數階段補零到 2 位。保留小數字尾。

```bash
# 規範化階段編號
if [[ "$PHASE" =~ ^[0-9]+$ ]]; then
  # 整數: 8 → 08
  PHASE=$(printf "%02d" "$PHASE")
elif [[ "$PHASE" =~ ^([0-9]+)\.([0-9]+)$ ]]; then
  # 小數: 2.1 → 02.1
  PHASE=$(printf "%02d.%s" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}")
fi
```

## 驗證

使用 `roadmap get-phase` 驗證階段存在：

```bash
PHASE_CHECK=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" roadmap get-phase "${PHASE}")
if [ "$(printf '%s\n' "$PHASE_CHECK" | jq -r '.found')" = "false" ]; then
  echo "ERROR: Phase ${PHASE} not found in roadmap"
  exit 1
fi
```

## 目錄查詢

使用 `find-phase` 進行目錄查詢：

```bash
PHASE_DIR=$(node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" find-phase "${PHASE}" --raw)
```