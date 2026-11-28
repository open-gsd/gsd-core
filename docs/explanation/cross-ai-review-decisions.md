# Cross-AI review design decisions

Two decisions about how `/gsd-review` runs independent reviewer lanes: a lane that cannot fit the prompt refuses rather than trims, and each review records the model that produced it. What the lanes do is in [feature 42 of the feature reference](../FEATURES.md#42-cross-ai-peer-review); the setup is in [Set up cross-AI review](../how-to/set-up-cross-ai-review.md).

## Why a lane refuses instead of trimming (#4559)

past a model's context window nothing errors. The model compacts and answers confidently about material it never read, so the lane returns a review that reads exactly like one with no concerns. Trimming to a cap swapped that silent overflow for a silent truncation, and the trim note told the model to treat missing context as out of scope. A refused lane is reported as a lane that did not run, naming its cap and the key to raise, so you can split the review or pick a larger model. Defaults come from a window each lane declares, not from a model catalog: GSD carries no network lookup or per-model table to maintain, and a lane whose model GSD cannot know stays uncapped rather than guessed.

## Why the review records which model produced it (#2295)

`reviewers:` in the frontmatter recorded which CLIs ran, but not which model each one resolved to. Without a pin, the model is whatever the CLI's own config or internal default happens to pick, so a "Codex vs Antigravity" comparison could quietly be a frontier model against a cheap-tier default with nothing in the record to say so — and a CLI update, or an unrelated config edit, could silently make past and future reviews incomparable.

The fix records the model *and its provenance*. Provenance is what makes the value trustworthy: `pinned` (from `review.models.<slug>`) is certain, while `banner` and `transcript` are recovered from third-party CLI output this project does not own — a startup banner or an undocumented session log.

That third-party dependence is a real trade-off, held honestly rather than papered over: the `banner` and `transcript` arms read formats GSD does not control, so they are best-effort by design and degrade to `unknown` rather than guessing or failing the run. A recorded `unknown` is a real answer — a wrong model name attributed to a review would be worse than none.

## Why review effort is a property of the review (#4255)

Before #4255 there was no review-specific source at all: every lane's level came from the
`gsd-plan-checker` agent's installed frontmatter — `low` under every shipped model profile — so a
prompt-fed, source-grounded review ran at the level chosen for a fast structural verifier, and a
large plan set could come back as an empty lane. Effort is now a property of the review.

## Why the lane budget is an estimate

Prompt size is estimated at four characters per token. Real tokenizers count source code more densely than that, and the 35% headroom absorbs the difference. The declared windows are the smallest that each CLI's default model can resolve to, so a plan or pinned model with a larger window raises `review.context_window_tokens.<slug>`.
