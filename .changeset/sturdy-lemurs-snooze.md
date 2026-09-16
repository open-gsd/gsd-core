---
type: Fixed
pr: 4804
---
**The UI consideration probe reads an optional `text_en` field** — in a `response_language` project every UI element used to classify to zero categories and land in `unclassified`, dropping the whole state-coverage axis; a faithful English translation per element now classifies exactly like its English equivalent. Mirrors the edge probe's #3717 remedy; an empty or whitespace `text_en` fails closed. (#4657)
