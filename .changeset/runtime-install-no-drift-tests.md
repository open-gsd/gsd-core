---
type: Changed
pr: 867
---
Added no-drift guard tests (`tests/issue-57-runtime-install-no-drift.test.cjs`) that protect the Runtime Install Policy Module boundary (ADR-58) and the explicit Runtime Config Adapter Registry (#60). They fail loudly when supported-runtime metadata is added to an installer call site (`allRuntimes`, the interactive `runtimeMap` menu) without a matching registry adapter entry, or when config-mutation dispatch escapes the registry's declared install surfaces — catching reintroduction of the scattered per-runtime branching those seams removed.
<!-- docs-exempt: test-only — adds architecture-guard tests, no user-facing behavior, command, or config change -->
