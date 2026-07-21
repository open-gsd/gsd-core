---
type: Fixed
pr: 2473
---
**`verify plan-structure` no longer false-flags checkpoint tasks for missing `<action>`/`<verify>`/`<done>`** — every `<task type="checkpoint:*">` was reported as a structural error because the verifier unconditionally required the auto-task fields. It now branches on the task's `type` attribute: `checkpoint:human-verify` requires its canonical triple (`<what-built>`/`<how-to-verify>`/`<resume-signal>`), `checkpoint:decision` requires `<decision>`/`<options>`/`<resume-signal>`, `checkpoint:human-action` requires `<action>`/`<instructions>`/`<verification>`/`<resume-signal>` (per `gsd-core/references/checkpoints.md`), and unknown `checkpoint:*` subtypes require only the universal `<resume-signal>`. Non-checkpoint tasks keep the historical `<action>`/`<verify>`/`<done>`/`<files>` requirements unchanged.
