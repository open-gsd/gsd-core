---
type: Security
pr: 5714
---
**The secret-read guard reads a heredoc inside a command substitution the way bash does** — a heredoc tag holding a substitution (`<<E$(x)F`), a tag followed by a carriage return (a CRLF command), and a `)` on a heredoc body line under bash 3.2 (still `/bin/bash` on macOS) ended the `$( )` span in the wrong place, so the `cat .env` after it was scanned as data and allowed. A tag is now read as a bash word, and a command that opens a heredoc is scanned under bash 5's reading, bash 3.2's reading and the earlier tag reading, denied if any of them finds a read, so no command denied before is allowed now. (#5513)
