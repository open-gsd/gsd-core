---
type: Fixed
pr: 5493
---
**Typed command arguments no longer run as shell inside workflow snippets** — a quote, `$(...)`, backtick or newline in an argument could end the quoting in about 58 workflows and execute; each snippet now reads the text from a quoted heredoc capture.
