---
type: Fixed
pr: 5874
---
**The secret-read guard reads past sudo's `-a`/`-c` and doas's `-a` values again** — `sudo -c ls cat .env`, `sudo --auth-type echo cat .env` and `doas -a ls cat .env` are denied again, as they were in 1.18.0; the wrapper table now lists those value-taking options from sudo(8) and doas(1). (#5852)
