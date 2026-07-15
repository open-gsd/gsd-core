---
type: Fixed
pr: 2300
---
**`/gsd-debug` now auto-resumes instead of stopping mid-investigation** — when the debug session-manager's own turn ended before the investigation was complete, the orchestrator treated the intermediate progress summary as completion and returned control to the user. It now recognizes a non-terminal `CONTINUE_REQUIRED` return, auto-resumes from the on-disk checkpoint, and only stops for genuine terminal conditions (with a no-progress anti-loop guard). (#2257)
