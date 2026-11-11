---
type: Changed
pr: 6098
---
**gsd-tools starts faster for commands that need little of it** — it loaded about 220 of its library modules on every call, whatever the command; it now loads each module the first time a command uses it, so a call like `runtime-identity` loads a few dozen. What each command does, prints and writes, and its exit code, are unchanged; a stack trace from an unexpected error shows one more frame. (#5865)
