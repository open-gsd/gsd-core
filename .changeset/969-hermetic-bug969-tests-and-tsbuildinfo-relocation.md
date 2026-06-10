---
type: Fixed
pr: 0
---
**Fixed a test-infrastructure regression (#996) where bug-969 hardening tests deleted the shared `gsd-core/bin/lib/core.cjs` during concurrent runs and the build tsbuildinfo lived inside the copied install tree, intermittently failing CI with MODULE_NOT_FOUND/ENOENT.** The destructive tests now run hermetically against a temp project, and the tsbuildinfo moved out of `gsd-core/bin/`. (#969)
