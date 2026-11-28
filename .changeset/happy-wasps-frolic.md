---
type: Added
pr: 6652
---
**`/gsd-quick resume <slug>` keeps the task's own quick id** — the resumed run used to get a fresh id from the clock, and the lookup took the first directory whose name merely ended in the slug. `gsd-tools query init.quick --resume <slug>` now finds the one directory named `<quick_id>-<slug>` (or a legacy `YYYYMMDD-<slug>`) and returns that task's `quick_id`, `slug`, `task_dir` and `branch_name` without allocating an id or writing; a slug that names several task directories stops with the list instead of picking one. (#6530, first part)
