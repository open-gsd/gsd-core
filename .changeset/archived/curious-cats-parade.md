---
type: Fixed
pr: 317
---
context-monitor hook no longer performs a redundant stat syscall before each file read on the PostToolUse hot path
