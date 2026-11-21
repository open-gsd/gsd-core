---
type: Fixed
pr: 5649
---
**The Bash secret-read and debugger-spawn guard now reads the command inside an `env -S` string** — `env -S 'cat .env'` and `env -S 'claude --agent gsd-debugger'` were allowed, because the string was skipped as the option's value; they are now denied however GNU, macOS/FreeBSD or uutils env splits the string, including with an unset `${NAME}` in it, and a string nested more than three levels deep is denied as `split-string-too-deep`. A shell reserved word in front of `env -S` still hides the string from the guard (`if true; then env -S 'cat .env'; fi`, `! env -S 'cat .env'`; #6138). (#5514)
