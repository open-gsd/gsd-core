---
type: Fixed
pr: 6553
---
**The Bash secret-read guard reads the default of a `${…}` word as a name the command can read** — `cat ${x:-$'.env'}`, `cat ${x-$'.e\x6ev'}`, `cat ${x:+a}$'.env'` and (zsh) `cat .env${}` were allowed because the text inside `${…}` was never scanned, although the shell runs `cat .env`; a word holding `${name<op>WORD}` (`-`, `:-`, `=`, `:=`, `?`, `:?`, `+`, `:+`) or an empty `${}` is now also judged with each expansion replaced by its quote-removed WORD and by nothing, since the variable is unknown. (#6132)
