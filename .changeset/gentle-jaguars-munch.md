---
type: Fixed
pr: 1661
---
**`gsd install`/upgrade now recovers a malformed `~/.gsd/defaults.json` instead of leaving it broken** — a `defaults.json` containing a valid-JSON-but-non-object value (`null`, `[]`, a number, or a string) bypassed the parse `catch` and flowed through unrecovered: `null` threw a TypeError (swallowed by the outer guard, logging a confusing "Could not write" warning and leaving the file as `null`), while `[]`/`42`/`"str"` silently kept their broken shape on every install. The non-Claude finishInstall step now resets any non-object parse result to a fresh `{}` before reading/writing it, so the file is repaired and `resolve_model_ids` defaults normally.
