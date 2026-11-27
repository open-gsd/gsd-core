---
type: Changed
pr: 6549
---
**Plan execution loads only the STATE.md sections it uses** — the `gsd-executor` agent and inline `execute-plan.md` execution now read Current Position, Decisions and Blockers through `state.get` (one shared block in `references/executor-state-sections.md`) instead of loading the whole STATE.md, and no executor spawn prompt lists STATE.md as required reading any more. A large Quick Tasks table no longer rides into every executor's context. A task that names STATE.md, or a section other than those three, still reads the file; `state.load`'s output is unchanged. (#6388)
