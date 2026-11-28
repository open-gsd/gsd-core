# About the code-review pipeline's design choices

Why the review-depth, disposition-ledger and record-artifact rules are shaped the way they are. The behavior itself is described in [Code Review Workflow](../USER-GUIDE.md#code-review-workflow); the flags and lanes are in [CLI tools](../CLI-TOOLS.md).

## Depth escalation is whole-review, not per-file

Depth is a single scalar handed to the reviewer agent — the strongest matching tier across the whole rule set applies to every file in the review. The reason: a sensitive file must never be reviewed shallowly because it happened to share a review with an unrelated one. A per-file depth would make the review's quality depend on how changes were batched.

## Directory prefixes only, no globs

v1 matches `workflow.code_review_depth_overrides` rules by whole-segment directory prefix and deliberately does not accept glob syntax. No glob engine (`minimatch`, `picomatch`, `fast-glob`) exists in this project and none was added for the feature. A path containing `*` or `?` is a configuration error rather than a silent near-miss, because accepting it as sugar for a prefix would make unsupported patterns look armed when they match nothing. Every use case in the originating issue is expressible as a directory prefix.

## Why the ledger replaces an `open` row silently

The disposition ledger keys rows on the finding ID; two rows under one ID is an ambiguity, not a record, so a new decision displaces the prior row and the drop is reported on the console. A prior row still sitting at `open` is replaced silently: `open` means nobody had decided anything, so there is no decision to lose. Preserving a recorded decision in the file was tried and withdrawn — it needed a second identity scheme and produced a fresh defect on each of three review passes. Recovery for a displaced recorded decision is the ledger's own git history where `commit_docs` is on.

## The carried-marker exception

A reason ending in the literal phrase *(not in the current review)* loses that trailing phrase on carry-over, because it is indistinguishable from the marker the gate itself appends. The alternative is worse: a stored marker never leaves, so a carried finding that later reappears would keep claiming it is absent from the review that reports it.

## Why the record is a sibling file, not a REVIEW.md section

`--auto`'s re-review loop rewrites REVIEW.md on every iteration — a ledger kept inside it would not survive the next pass — and REVIEW.md has a single writer (`gsd-code-reviewer`) that the disposition gate is not. The gate reports and records; it remains advisory and never blocks phase completion.

---

## Related

- [Code Review Workflow](../USER-GUIDE.md#code-review-workflow)
- [Review dispositions ledger](../adr/3806-review-dispositions-ledger.md)
- [Multi-agent orchestration](multi-agent-orchestration.md)
- [Security model](security-model.md)
