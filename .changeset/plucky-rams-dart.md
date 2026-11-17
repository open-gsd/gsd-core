---
type: Fixed
pr: 6251
---
**`/gsd-code-review --files` and `--depth` accept the space-separated form** — `--files a.py,b.py` now narrows the review to the files as typed instead of being silently dropped, `--depth deep` is honored the same way, and a bare flag without a usable value is refused naming both accepted forms.
