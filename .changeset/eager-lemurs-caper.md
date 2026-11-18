---
type: Fixed
pr: 6291
---
**`state record-session` and other STATE.md writes no longer inflate `total_phases` from heading text quoted in prose** — a `### Phase N:` inside a code span, a blockquote, a fenced block or a sentence was counted as a phase, so `progress.total_phases` rose and `percent` fell. `validate consistency` raised phantom "in ROADMAP.md but no directory on disk" warnings for the same quoted headings. Only real level 2–4 ATX headings count now, so a `##### Phase N:` line, `###Phase N:` with no space, and a four-space-indented `### Phase N:` (an indented code block) are no longer read as phases. (#5880)
