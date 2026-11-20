---
type: Fixed
pr: 6192
---
**`state milestone-switch` keeps custom STATE.md frontmatter keys, and neither it nor `milestone complete` silently deletes operator lines from `## Current Position`** — milestone-switch rebuilt the frontmatter from a fixed key list, so a custom key such as `team_owner` was lost; both commands replaced the whole Current Position body with the four template lines, so lines like `Blocked on:` or `Carry-over:` vanished without a trace. Unknown frontmatter keys now survive the switch, and every non-template Current Position line is moved, once and in order, under `## Accumulated Context` (created when absent) and listed in the JSON result as `moved_current_position_lines` (absent when nothing moved). The reset of the four template fields is unchanged. (#6174)
