---
id: 4014
title: Unreadable-Directory Scope Signal
group: v1.7.0 Features
---

**Purpose:** ADR-3473 §8.4 ("failure is a value") applies to filesystem listings. #3885 (B5)
added a `context_read_error` / `phase_dir_read_error` string, but the `has_context` /
`hasContext` boolean stayed `false` either way. This adds a typed signal that reuses
ADR-3180's frozen `SCOPE` enum. The reasoning is in
[Why failures are surfaced, not absorbed](../explanation/why-failures-are-surfaced-not-absorbed.md#a-typed-scope-signal-for-unreadable-directories-4014).

**Behavior:**
- `findContextMdIn` (`src/planning-workspace.cts`), called with a directory path, returns
  `{ file, files, scope }` and never throws. An unreadable directory reports
  `scope: 'unreadable'`; an absent one (`ENOENT`) reports `scope: 'complete'`. The
  array-input call form is unchanged.
- Five call sites gain an additive `scope` field, none renamed or removed:
  `roadmap analyze`'s `AnalyzePhase.context_scope`, `gap-checker`'s `phase_dir_scope`, and
  `init`'s `context_scope` on `init plan-phase`, `init phase-op` and `init manager`.
- `getPhaseFileStats` (`src/core-utils.cts`) no longer lets its failed read be masked by an
  already-successful `scanPhasePlans` scope on the same directory.

**Known limits:**
- `context_read_error` / `phase_dir_read_error` is now a fixed "Could not read phase
  directory `<path>`" without the OS errno text.
- `init.cts`'s three call sites still run their own `fs.readdirSync` on the same path after
  `findContextMdIn`: an additive-only choice, not a performance optimization.
