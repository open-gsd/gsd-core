---
type: Fixed
pr: 0
---
**`/gsd-map-codebase` Update mode now refreshes all date stamps** — the `**Analysis Date:**` line, the `*... analysis: ...*` footer, and the `<!-- refreshed: ... -->` header are set to the current date on every run, overwriting any prior date. Previously, Update runs only replaced `[YYYY-MM-DD]` placeholder tokens, which don't exist in already-generated files (they contain concrete dates from the prior run), so stamps silently retained the original mapping date. (#2279)
