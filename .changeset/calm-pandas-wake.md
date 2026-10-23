---
type: Fixed
pr: 5582
---
**`/gsd-code-review --fix` no longer rolls back correct TypeScript fixes on a false `tsc` error** — the fixer's Tier-2 check passed the edited file to `tsc` positionally, which ignores `tsconfig.json` (no `jsx`, `paths`, `lib`), so every `.tsx` or alias-importing file failed in the file it had just edited. It now uses the project's own typecheck or a `tsconfig` verified to include the file, filtered to that file, and falls back to the re-read tier when none does. (#5213)
