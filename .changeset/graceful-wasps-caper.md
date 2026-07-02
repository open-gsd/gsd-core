---
type: Fixed
pr: 1927
---
**bug-1367 install test no longer fails on Windows CI when hooks/dist isn't pre-built** — the test ran install.js without building its hooks/dist precondition (a gitignored build artifact the unit lane doesn't build), so on a lane without pre-built hooks the installer hit "Failed to install hooks: directory is empty" and the before-hook threw. The test now builds hooks in its own before() (mirroring golden-install-parity). (#1926)
