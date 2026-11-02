---
type: Changed
pr: 5839
---
**Reviewer lanes now cap their prompt by default and refuse an oversized one instead of trimming it** — an unconfigured install used to send every lane an unbounded prompt, and a configured cap silently trimmed it, so a reviewer that never saw part of the plan set returned a review that read like a clean pass. Lanes with a known default model (claude, codex, qwen, kimi-code) now cap at 65% of a declared context window (override with `review.context_window_tokens.<slug>`, or set a `review.max_prompt_tokens*` key; `0` disables). A lane over its cap does not run, reports `prompt_exceeds_context`, and is listed under `refused_reviewers` in REVIEWS.md instead of `trimmed_reviewers`; the code-review lane dispatch reports the same reason in place of `budget_exceeded`. (#4559)
