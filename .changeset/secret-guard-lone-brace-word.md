---
type: Fixed
pr: 6543
---
**The Bash secret-read guard judges the operand after a lone `{` or `}`** — `cat { .env`, `cat } .env` and `grep KEY { .env` were allowed because the tokenizer took any `{` or `}` that began a word for a group separator, so the word after it was read as a new command name and never checked as a file operand; a brace now opens or closes a group only where a command may start (the start of a segment, past `then`, `do`, `else`, `!`, redirections and assignments, after an `if`/`while`/`until` condition or a `function`, `coproc`, `time`, `for`, `repeat`, `select` or `always` head, or a closer such as `esac`, which zsh also gives a `{` body), and is an ordinary word among a command's arguments, as bash, dash and zsh read it; a `}` that closes an open group is always a separator (zsh closes `{ echo x } always { … }` there); anything unclear stays a group. Real groups such as `{ cat .env; }` and a brace heredoc tag are scanned as before. (#6438)
