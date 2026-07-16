---
type: Fixed
pr: 2325
---
**`/gsd:plan-review-convergence` can now use the Antigravity CLI reviewer** — its reviewer-flag whitelist predated the 1.7.0 Antigravity adapter and silently dropped `--agy`/`--antigravity`, so convergence fell back to `--codex` only and the working adapter was unreachable (especially after Gemini CLI's upstream shutdown). Both flags are now recognized and passed through to `/gsd-review` unchanged. (#2293)
