---
type: Added
pr: 2258
---
Opt-in bracket phase-ID core grammar in the ADR-2121 canonical owner (`src/phase-id.cts`): `parsePhaseId`/`renderPhaseId`/`toDir` + `PhaseId` with generative round-trip properties, behind `phase_id_convention: 'bracket'`. Legacy `null`/`milestone-prefixed` paths byte-untouched (epic #612 PR-1).

<!-- docs-exempt: internal core grammar behind the phase_id_convention flag; nothing user-visible until the epic's display/injection slices (PR-5/PR-6), which carry the docs/ updates; governing ADR already merged at docs/adr/612-bracket-phase-id-convention.md (#2181) -->

