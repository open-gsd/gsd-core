---
type: Fixed
pr: 6251
---
**`/gsd-code-review --files` accepts the space-separated form** — `--files a.py,b.py` now narrows the review to the files as typed instead of being silently dropped, and a bare `--files` without a usable value is refused naming both accepted forms.
