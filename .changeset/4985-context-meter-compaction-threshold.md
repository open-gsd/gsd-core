---
type: Fixed
pr: 5252
---
**Statusline context meter reads 100% where Claude Code auto-compacts, and the context monitor warns before it** — the meter now resolves the auto-compact window the way Claude Code does (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then the `autoCompactWindow` setting `/autocompact` saves, per model or top-level, then the model window), subtracts the 33k auto-compact buffer `/context` shows (lowered further by `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`), and measures the used tokens against that threshold. With `/autocompact 650k` on a 1M model it read 74% at the moment of compaction and the monitor stayed silent; it now reads 100% and the monitor has already gone CRITICAL. The statusline bridge's `remaining_percentage` / `used_pct` count down to the same threshold, and the bridge gains `used_tokens` / `threshold_tokens`, which the monitor's message quotes so it still matches `/context`.
