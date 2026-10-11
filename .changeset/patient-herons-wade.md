---
type: Fixed
pr: 5309
---
**The secret-read guard no longer ends a `$( )` at a `case` pattern's `)`** — `echo "$(case x in x) cat .env;; esac)"` was allowed, because the scan closed the substitution at the pattern and never read the arm; a secret read in a `case` arm inside `$( )` or `<( )` is now denied. The same scan no longer ends a substitution at a `)` inside a `#` comment or a `${ }`, and no longer takes the lines after a here-string (`<<<`) for a heredoc body. bash 3.2 does end a substitution at that paren and runs what follows it, so a command is also scanned the way it was before: everything the guard denied is still denied. (#5267)
