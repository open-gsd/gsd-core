---
type: Security
pr: 5285
---
**The secret-read guard reads bash's `$'…'` quoting** — a `\'` inside `$'…'` no longer hides the rest of the line (`echo $'x\'y'; cat .env`), and a name spelled with escapes is judged by the value bash and zsh each decode (`cat $'.e\x6ev'`, `cat $'.env\u'`), in words, `$( )` and heredoc tags. A `$'…'` word that never closes, or holds a literal NUL, is blocked. (#5255)
