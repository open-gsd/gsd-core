---
type: Fixed
pr: 6297
---
**The statusline context meter now reads a `k`/`M` suffix on `CLAUDE_CODE_AUTO_COMPACT_WINDOW`** — `500k` was parsed as 500 and clamped to the 100k minimum, so the meter hit 100% at 67,000 tokens instead of 467,000 and the context monitor's warnings fired early. A case-insensitive `k` (x1,000) or `M` (x1,000,000) on an integer or decimal now resolves the way Claude Code reads it, then the existing 100k–1M clamp applies; plain digits, grouped digits and other values behave as before. (#6131)
