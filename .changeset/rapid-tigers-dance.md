---
type: Fixed
pr: 710
---
**Codex install no longer corrupts launcher paths** — shell path segments like `${VAR}/gsd-core/` and `$(cmd)/gsd-local-patches` are no longer rewritten into a literal `$gsd-core` token during Codex markdown conversion (#704).
