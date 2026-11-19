---
type: Fixed
pr: 6345
---
**The secret-read guard scans the script behind `bash -c --`** — `bash -c -- 'cat .env'` and a debugger launch behind `-c --` are now blocked instead of allowed; every other invocation shape behaves exactly as before.
