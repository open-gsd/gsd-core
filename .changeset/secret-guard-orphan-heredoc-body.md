---
type: Fixed
pr: 6548
---
**The Bash secret-read guard reads the body of a heredoc opened in a `$( )` that closed on its line as data** — `echo $(cat <<EOF) x` followed by a body line with a lone quote and then `cat .env` was allowed, because the span reader dropped the heredoc still waiting for its body and the top-level tokenizer read the body as shell, where the quote swallowed the read; the waiting heredoc now goes to the tokenizer's pending list (also from `<( )`, a double-quoted `$( )`, and across a line continuation), so its body is consumed where bash reads it and the read after it is denied. (#5515)
