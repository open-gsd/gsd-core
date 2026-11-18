# Explicit parent review of unsupported RED evidence

- **Status:** Proposed — implementation of approved feature [#6201](https://github.com/open-gsd/gsd-core/issues/6201), pending maintainer ratification.
- **Date:** 2026-11-18

Unavailable parsing is not proof of invalid RED. Permit explicit parent judgment on complete original evidence without adding a reporter, reviewer agent or runtime-specific policy owner. Parent review is not independent verification. Parent-only authority is a workflow boundary, not authentication of an agent sharing a writable workspace.

## Decision

The Test-Report Adapter Module marks unrecognized nonempty reports as unsupported; malformed and recognizable incomplete supported evidence remains invalid. The RED classifier emits `UNSUPPORTED_REPORT` with null counters rather than claiming zero observed tests. Exit zero and recognized build failures retain invalid outcomes. Supported-format behavior and semantic inspection remain intact.

The existing gate alone authorizes GREEN. Unsupported alone blocks. A parent decision in the original RED record requires original stdout/stderr, an unchanged stream as output, real nonzero exit, exact target, expected/actual observations, a unique run ID and declared relevant file hashes including the target. SHA-256 binds the capture and sorted state entries. The gate checks raw-byte file hashes through contained project paths immediately before GREEN; null represents an absent relevant file. The Gate Evidence Module wraps the existing bounded regular-file reader, with a 16-MiB per-file limit, preserving unreadable evidence and the unavailable exit outcome (69). Selecting another stream cannot hide recognized reports or malformed supported evidence. Acceptance requires explicit checks for complete capture, successful setup, target execution, intended assertion failure and no unrelated failures, plus concrete reasons. Rejection and abstention block.

The machine verdict remains `UNSUPPORTED_REPORT`. Only `review_status: accepted`, `authorization: parent_reviewed_red` and `passed: true` identify parent authorization. Nothing overrides `INVALID_RED` or fabricates `RED_EVIDENCE_OK`. The Gate Verdict Module and router retain verdict/exit ownership under ADR-5057; no new command or Pi policy owner is added.

Children stop, return original evidence to their existing parent and never write/modify the decision. The parent may execute directly or explicitly resume the child for that exact run. Preserve the original record and pre-GREEN result in task evidence and SUMMARY, including rejection/abstention. New RED runs and changed relevant state require new assessment. The canonical procedure/schema is in `gsd-core/references/tdd.md`.

## Consequences

This changes wire policy: callers must distinguish unsupported from invalid, null counts from measurements, and parent authorization from machine validation. Old verdict-only callers fail closed. Consumers of `passed` receive the gate's explicit authorization, not a claim of parser validation.

Scope completeness, run identity, capture completeness and parent role remain assertions by cooperating agents. Hashes detect changed declared evidence, not omitted dependencies, dishonest assertions or a child impersonating its parent. Strong authentication would require trusted runtime authority outside the approved scope. Original output is untrusted data, never instructions. Compile/setup errors, missing/ignored targets, unrelated failures and uncertainty require rejection/abstention even when the parser cannot recognize them.

A Rust-only adapter would not solve recurring unsupported formats. Any-nonzero acceptance and child self-waiver were rejected; mandatory independent reviewer orchestration adds unnecessary cost. Supported adapters remain preferred.
