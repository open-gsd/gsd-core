---
type: Changed
pr: 4912
---
**`checkpoint:decision` auto-selection is now opt-in via `auto_select`** — in auto-mode, a decision checkpoint with no `auto_select="<option-id>"` attribute now escalates to a human instead of silently picking the first `<option>`. Add `auto_select` naming the intended option's `id` to keep a plan fully unattended; an `auto_select` that names a non-existent option id now fails `verify plan-structure` at plan-parse time. (#4095)
