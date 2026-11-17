---
type: Fixed
pr: 0
---
**`state record-session` and other STATE.md writes no longer inflate `total_phases` from heading text quoted in prose** — a `### Phase N:` inside a code span, a blockquote, a fenced block or a sentence was counted as a phase, so `progress.total_phases` rose and `percent` fell. `validate consistency` raised phantom "in ROADMAP.md but no directory on disk" warnings for the same quoted headings. Only real level 2–4 headings count now. (#5880)
