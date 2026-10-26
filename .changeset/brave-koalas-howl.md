---
type: Fixed
pr: 5685
---
**The secret-read guard no longer loses a nested shell behind a wrapper with flags** — `timeout 5 bash -c 'cat .env'`, `nice -n 5 …`, `env -i …`, `stdbuf -oL …` and `exec …` are now denied like the flagless forms. (#5627)
