---
type: Security
pr: 5285
---
**The secret-read guard reads bash's `$'…'` quoting** — a `\'` inside `$'…'` no longer hides the rest of the line (`echo $'x\'y'; cat .env`), and a name spelled with escapes is judged by the value bash and zsh each decode (`cat $'.e\x6ev'`, `cat $'.env\u'`), in words, `$( )` and heredoc tags, and in such a command a `${…}` is read on past the quotes and substitutions inside it, with the commands of any `$( )`, `<( )` or backticks inside it checked (`echo ${x#'$'}; cat $'.env'`), and nothing the guard blocked before this change is allowed. Such a command is also read the way dash reads it, with `$'` as a `$` and a plain quote, so `echo $${$'\''}'; cat .env` is blocked too. A `$'…'` word that never closes or holds a literal NUL is blocked, and so is a command nested deep enough to overflow the parser, or needing more work than the scan allows (`command-too-complex`). (#5255)
