---
type: Fixed
pr: 5649
---
**The Bash secret-read and debugger-spawn guard now reads the command inside an `env -S` string** — `env -S 'cat .env'` and `env -S 'claude --agent gsd-debugger'` were allowed, because the string was skipped as the option's value. The guard now splits it the way GNU env does and checks the command it runs; a string that splits out of another split string more than three levels deep is denied as `split-string-too-deep`. The string is also still read as before, skipped as the option's value, and either reading's hit denies, so the change adds denials and removes none. (#5514)
