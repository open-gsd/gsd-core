---
type: Fixed
pr: 1211
---
**Context meter no longer sticks at 100%** — the statusline reserved-buffer math was inverted, pinning usage at 100% whenever CLAUDE_CODE_AUTO_COMPACT_WINDOW equalled the total window. (#1194)
