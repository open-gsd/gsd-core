---
type: Added
pr: 5836
---
**Review reapplied patches edit by edit with `/gsd-update --reapply --interactive[=exceptions|all]`** — an update can make a customization redundant without any merge conflict (upstream adopts it in other words, rewrites the lines around it, or deletes the section it hung off), and `--reapply` re-grafted it every time; now each edit is shown beside the stock text with a recommendation, and you keep, retire, or rewrite it, with retirements bound to the exact text you saw. (#4435)
