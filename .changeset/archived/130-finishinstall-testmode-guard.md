---
type: Fixed
pr: 130
---
Test-mode installs no longer write the opencode config file — `finishInstall` now skips `configureOpencodePermissions` when `GSD_TEST_MODE=1`.
