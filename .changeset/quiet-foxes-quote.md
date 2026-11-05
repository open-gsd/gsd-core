---
type: Security
pr: 5285
---
**Shell quoting could hide a secret read from the secret-read guard** — `echo $'x\'y'; cat .env` and `cat $'.e\x6ev'` are now blocked. The guard reads `$'…'` under bash, zsh and dash, judges a word by its decoded value, and closes four shapes it allowed: a brace as a heredoc tag, a quote in zsh's arithmetic, `$[ ]` inside `${…}`, and a line continuation inside `${…}` under dash. Nothing it blocked before is allowed. A command it cannot finish scanning is blocked as `command-too-complex`. (#5255)
