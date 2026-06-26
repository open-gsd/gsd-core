---
type: Changed
pr: 1764
---
**Internal: agent install for cursor/windsurf/augment/trae/codebuddy now flows through the descriptor path** — ADR-1235 step 1 routes the trivial-converter runtime group's agents off the inline install() loop onto the descriptor-driven `installRuntimeArtifacts` path, applying the cross-cutting steps uniformly (pre-converter, no workflow-stamp). Agent output is byte-identical for all 16 runtimes (golden-parity asserted, global + local verified); no user-facing change.

<!-- docs-exempt: internal refactor, no user-facing surface -->
