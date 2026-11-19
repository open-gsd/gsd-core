---
type: Fixed
pr: 0
---
**Five timeout tests no longer leave their stalling `sleep` running after they pass** — the test fixtures planted `sleep N` under a shell (or under `git`), so the timeout killed the shell and the `sleep` was reparented and ran out its 1 to 12 seconds; each stall is now `exec`'d so the killed process is the stall, the git-hook test terminates the hook-started stalls itself, and each test asserts nothing it started is still running (on POSIX hosts, where `ps` can check it). (#6086)
