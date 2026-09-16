---
type: Fixed
pr: 4775
---
**run-with-timeout now kills the whole process tree on Windows** — a timed-out command's descendants (e.g. a model CLI wrapped via workflow.cross_ai_command) no longer survive the timeout and keep running unbounded; POSIX behavior is unchanged. (#4601)
