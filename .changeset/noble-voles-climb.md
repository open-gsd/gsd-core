---
type: Fixed
pr: 5076
---
**`gates.*` confirmation toggles now actually take effect** — the config schema previously rejected `gates.execute_next_plan`/`gates.confirm_transition`/`gates.confirm_milestone_scope` as unknown keys, and workflows only honored them under a nonexistent `mode: "custom"`, so the toggle was a no-op regardless of value; `config-set mode` now also rejects anything other than `interactive`/`yolo`. (#4974)
