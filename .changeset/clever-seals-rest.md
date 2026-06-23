---
type: Changed
pr: 1438
---
**Thread `isGlobal` install scope through the descriptor-driven `convertedAgentsKind` / `stageAgentsForRuntimeWithConverter` plumbing** — a prerequisite for the ADR-1235 agent-conversion cutover. No runtime declares a converted `agents` kind yet; the `capability.json` wiring is deferred to a follow-up that first ships the ADR-1235 §0 byte-for-byte parity harness (so the `/gsd:surface` / `--materialize` consumer can mirror the legacy agent pipeline before the kind goes live). The legacy `bin/install.js` agent loop remains authoritative, so installed agent output is unchanged. (#1173)

<!-- docs-exempt: internal install-path plumbing only (ADR-1235 cutover prerequisite); no runtime declares the converted agents kind, the legacy loop remains authoritative, and installed agent output is unchanged — no user-facing command/config/behavior surface. -->
