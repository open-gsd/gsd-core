---
type: Security
pr: 5285
---
**The secret-read guard reads bash's `$'…'` quoting** — a `\'` inside `$'…'` no longer hides the rest of the line (`echo $'x\'y'; cat .env`), and a name spelled with escapes is judged by the value bash and zsh each decode (`cat $'.e\x6ev'`, `cat $'.env\u'`), in words, `$( )` and heredoc tags. Such a command is also read the way dash reads it, with `$'` as a `$` and a plain quote, so `echo $${$'\''}'; cat .env` is blocked too. A `$'…'` word that never closes or holds a literal NUL is blocked, and so is a command nested too deeply, or needing too much work, to be checked (`command-too-complex`). (#5255)
