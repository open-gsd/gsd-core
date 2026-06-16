---
type: Fixed
pr: 1122
---
**`/gsd:review` no longer produces a silent empty Codex review on codex-cli < 0.137** — the `codex exec` invocation passed `--dangerously-bypass-hook-trust` (added in codex 0.137.0) unconditionally and discarded stderr, so on older CLIs codex exited with `unexpected argument` before reading the prompt and the empty output was treated as a completed review. The flag is now capability-probed (`codex exec --help | grep`) and applied via `$CODEX_BYPASS_FLAG` only when supported, codex stderr is captured to a `.err` file instead of `/dev/null`, and an empty Codex output is replaced with a diagnostic so a broken reviewer is surfaced rather than silently skipped. (#1115)
