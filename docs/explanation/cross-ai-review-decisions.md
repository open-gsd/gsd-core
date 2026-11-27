# Cross-AI review design decisions

Two decisions about how `/gsd-review` runs independent reviewer lanes: a lane that cannot fit the prompt refuses rather than trims, and each review records the model that produced it. What the lanes do is in [feature 42 of the feature reference](../FEATURES.md#42-cross-ai-peer-review); the setup is in [Set up cross-AI review](../how-to/set-up-cross-ai-review.md).

## Why a lane refuses instead of trimming (#4559)

past a model's context window nothing errors. The model compacts and answers confidently about material it never read, so the lane returns a review that reads exactly like one with no concerns. Trimming to a cap swapped that silent overflow for a silent truncation, and the trim note told the model to treat missing context as out of scope. A refused lane is reported as a lane that did not run, naming its cap and the key to raise, so you can split the review or pick a larger model. Defaults come from a window each lane declares, not from a model catalog: GSD carries no network lookup or per-model table to maintain, and a lane whose model GSD cannot know stays uncapped rather than guessed.

## Why the review records which model produced it (#2295)

`reviewers:` in the frontmatter recorded which CLIs ran, but not which model each one resolved to. Without a pin, the model is whatever the CLI's own config or internal default happens to pick, so a "Codex vs Antigravity" comparison could quietly be a frontier model against a cheap-tier default with nothing in the record to say so — and a CLI update, or an unrelated config edit, could silently make past and future reviews incomparable.
