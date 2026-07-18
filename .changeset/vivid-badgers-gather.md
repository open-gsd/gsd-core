---
type: Fixed
pr: 2399
---
**Build/test gates no longer report a false failure on repos with no detectable build/test tooling** — the post-merge, regression, verify-phase, and audit-fix gates read `config-get workflow.build_command`/`workflow.test_command` without `--raw`, so an unset key returned the literal 2-byte string `""` rather than empty output. The `[ -z "$CMD" ]` guard then saw a non-empty value, skipped the Makefile/Cargo/go.mod/package.json auto-detection cascade, and executed the literal `""` as a command → exit 127, misread as a build/test failure (docs-only or planning-only repos, or any repo before its first build file). All of these reads now pass `--raw`, restoring the intended "no command detected — skip" no-op. (#2350)
