---
type: Added
pr: 1930
---
<!-- docs-exempt: Phase 5 (#1682) Slice 1b/c; consolidated Phase 5 docs land with phase completion. -->
**OpenCode plugin handles `session.idle` + the `opencode-subset` hook dialect is implemented** — the GSD OpenCode plugin now recognizes `session.idle` (↔ Claude `Stop` lifecycle point), completing the compaction/idle pair (#1914 shipped compaction). The reserved `opencode-subset` dialect gains a consumer — `hookEventSurfaceFor()` in `host-integration.cts` — describing OpenCode's session/tool/file event subset (no workflow-phase events; the engine owns phase sequencing, ADR-1239 §OpenCode binding). Adds a Claude-parity test asserting the plugin covers the full declared subset. (#1682)
