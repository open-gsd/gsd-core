# 小數階段計算

為緊急插入計算下一個小數階段編號。

## 使用 gsd-tools.cjs query

```bash
# 獲取階段 6 之後的下一個小數階段
gsd-tools.cjs query phase.next-decimal 6
```

輸出：
```json
{
  "found": true,
  "base_phase": "06",
  "next": "06.1",
  "existing": []
}
```

已有小數時：
```json
{
  "found": true,
  "base_phase": "06",
  "next": "06.3",
  "existing": ["06.1", "06.2"]
}
```

## 提取值

```bash
DECIMAL_PHASE=$(gsd-tools.cjs query phase.next-decimal "${AFTER_PHASE}" --pick next)
BASE_PHASE=$(gsd-tools.cjs query phase.next-decimal "${AFTER_PHASE}" --pick base_phase)
```

或使用 --raw 標誌：
```bash
DECIMAL_PHASE=$(gsd-tools.cjs query phase.next-decimal "${AFTER_PHASE}" --raw)
# 返回: 06.1
```

## 示例

| 已有階段 | 下一個階段 |
|----------|------------|
| 僅 06 | 06.1 |
| 06, 06.1 | 06.2 |
| 06, 06.1, 06.2 | 06.3 |
| 06, 06.1, 06.3（有空缺）| 06.4 |

## 目錄命名

小數階段目錄使用完整的小數編號：

```bash
SLUG=$(gsd-tools.cjs query generate-slug "$DESCRIPTION" --raw)
PHASE_DIR=".planning/phases/${DECIMAL_PHASE}-${SLUG}"
mkdir -p "$PHASE_DIR"
```

示例：`.planning/phases/06.1-fix-critical-auth-bug/`
