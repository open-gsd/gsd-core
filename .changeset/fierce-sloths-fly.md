---
type: Fixed
pr: 6077
---
**`config-get --default` now prints the JSON value it spells** — `--default '[]'` printed the string `"[]"` instead of an array, so `/gsd-code-review` stopped before spawning its reviewer in any project that never set `workflow.code_review_depth_overrides`; the same applied to numbers, booleans, objects and `null`. `--raw --default null` on a secret key now shows `(unset)` instead of `****`, and `planner.stall_detection_enabled --default false` now returns `false`. `config-set` and `config-get --default` no longer turn a blank value or hex text into a number: `' '`, `' 5'` and `0x10` are kept as text. (#6029)
