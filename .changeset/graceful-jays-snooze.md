---
type: Added
pr: 5725
---
**`/skill:gsd-debug` new, continue and `--diagnose` now run on Pi** — the Pi skill stopped with "needs nested dispatch" for every form that starts an investigation. It now runs the session manager's checkpoint loop in the top-level Pi session, dispatches only `gsd-debugger`, asks its questions as plain text and keeps its loop state in the debug file, so a session resumes with `continue <slug>` after Pi loses its context (#5638).
