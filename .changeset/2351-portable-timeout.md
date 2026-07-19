---
type: Fixed
pr: 2426
---
**Post-merge, regression, and other GSD test/build gates no longer fail with a spurious "command not found" on stock macOS.** These gates hardcoded GNU coreutils' `timeout`, which stock macOS ships neither as `timeout` nor `gtimeout`; a passing build or test run now completes under a portable, coreutils-independent `run-with-timeout` wrapper instead of exiting 127 and being misreported as a failure. (#2351)
