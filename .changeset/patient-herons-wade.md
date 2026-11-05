---
type: Fixed
pr: 0
---
**The secret-read guard no longer ends a `$( )` at a `case` pattern's `)`** — `echo "$(case x in x) cat .env;; esac)"` was allowed, because the scan closed the substitution at the pattern and never read the arm. The guard now makes one more scan of a command that holds a substitution, following bash 5's grammar, so a secret read in a `case` arm inside `$( )` or `<( )` is denied, as is one after a `)` in a `#` comment or an unquoted `${ }` there. That scan does not read `$'…'` quoting, a span opening `$((`, a `${ }` inside a string, an operator or heredoc line split by a line continuation, or a plain nest over 1,000 deep. It runs after the scans the guard always made, which are unchanged, so it only adds denials, except near the stack limit at about 2,700 nested heredoc tags, where the verdict already varies from run to run. The check that denies a Bash spawn of `gsd-debugger` gets the same extra scan. (#5267)
