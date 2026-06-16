---
type: Changed
pr: 1320
---
**`verify plan-structure` warns on cross-task region-scope conflicts (#968)** — when a plan task's file-wide negative grep (`! grep -Eq 'PAT' file` / `grep -c 'PAT' file == 0`) bans a construct a sibling task legitimately requires elsewhere in the same file, plan validation now surfaces a warning pointing to the new region/function-scoped negative-gate idiom (documented in the gsd-planner guidance and the planner-antipatterns reference, with a worked banned-in-X / required-in-Y example). Warn-only: it never errors and never changes `valid`. (#1320)
