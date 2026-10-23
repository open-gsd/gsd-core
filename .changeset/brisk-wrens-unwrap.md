---
type: Fixed
pr: 5649
---
**The debugger-spawn guard now catches `claude --agent gsd-debugger` behind a wrapper that is given options** — `timeout -k 5 10`, `env -i`, `env -u HOME`, `nice -n 5`, `sudo -u me`, `sudo -E` and the like were read as if the option were the command, so the launch was allowed. The guard now skips the options of `sudo`, `doas`, `env`, `nice`, `nohup`, `time`, `command` and `timeout`, including the ones that take a value, and reads the command inside `env -S '…'`. (#5514)
