---
type: Fixed
pr: 2109
---
**`/gsd-review`'s Antigravity CLI reviewer no longer fails silently on large prompts, unavailable pinned models, or pre-session stalls** — the `agy` invocation now uses a file-reference prompt to avoid exec arg-list overflow, is wrapped in an external wall-clock `timeout` paired with `--print-timeout` because `--print-timeout` cannot fire before `agy` creates a session, passes `--model` from `review.models.agy` when set as an escape hatch for a 404'd pinned model, and its empty-output stub now surfaces an `agy` cli.log diagnostic instead of a bare generic message. Supersedes the #687 "no external killer / inline `$(cat)`" contract, which predated `agy` gaining `--model` and predated its own guidance to pair `--print-timeout` with a terminal timeout. (#2073)
