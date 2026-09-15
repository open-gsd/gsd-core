---
type: Security
pr: 4723
---
**An exported `CONFIG_STATUS`, `CMD_STATUS`, or `CLASSIFY_STATUS` no longer disables the commit-message gate** — the hook captured each subprocess status with `|| VAR=\$?`, which assigns only when the subprocess fails, so on success the variable kept any value inherited from the environment. A CI wrapper, a `.envrc`, or another hook that exported one of those names made the validator report "validator disabled for this call" and accept a non-conforming commit. The statuses are now initialised before use; a genuine subprocess failure still passes the commit through, as before. (#4429)
