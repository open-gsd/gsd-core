---
type: Fixed
pr: 613
---
**Fresh installs now ship `managed-hooks-registry.cjs` next to `gsd-check-update-worker.js`, so the background update checker no longer crashes silently (#606)** — the worker `require()`s that sibling, but it had been missing from the hooks copy allowlist, so on a clean install the worker threw `Cannot find module` in the background and the update cache was never written. The file is now in the allowlist, and a regression guard asserts that every same-directory `require()` target of a shipped hook is itself shipped. Thanks @baksohyeon for the clean-room reproduction.
