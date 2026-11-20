---
type: Fixed
pr: 6379
---
**Hermes dispatch calls now deliver the role prompt as the task's `context`** — the installed workflows named `gsd_role` and `gsd_role_prompt`, which Hermes's `delegate_task` does not accept, and never said where the role prompt goes, so orchestrators told the child to read the role file as tool output (windowed, truncated, compacted) and the child lost the plan; each call now carries only `goal`, `context` and `role`, with the role prompt's full contents in `context` and the plan as the child's own first read. (#6066)
