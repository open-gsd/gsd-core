---
type: Fixed
pr: 322
---
**`/gsd-surface` now accepts parsed manifest JSON input safely** — surface resolution normalizes manifest inputs before profile closure and list/apply operations so list/status/enable/disable no longer crash with `manifest.get is not a function`.
