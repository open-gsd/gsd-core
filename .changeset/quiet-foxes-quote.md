---
type: Security
pr: 0
---
**The secret-read guard no longer loses the rest of a command line to bash's `$'…'` quoting** — inside `$'…'` a backslash escapes the next character, so `echo $'x\'y'; cat .env` hid the read behind a quote the guard believed was still open, and `cat $'.e\x6ev'` spelled the protected name with an escape the guard never decoded. The guard now ends a `$'…'` word where bash and zsh end it and judges the word by its decoded value, in plain words, inside `$( )` and in heredoc tags, and reads bash's `$"…"` as `"…"`. dash reads the same text as `$` plus a plain quote, so a command using either form is checked under both readings and blocked on either. A `$'…'` word that never closes, or that has no single value to check, is blocked with its own code (`ansi-c-unterminated`, `ansi-c-undecodable`). (#5255)
