---
type: Fixed
pr: 2457
---
**`response_language` now reaches orchestrator-owned prompts across most workflows and the UAT verification checkpoint frame** — previously only subagent prompts honored a configured `response_language`; the orchestrator's own questions (verify-work, new-project, new-milestone, quick, manager, and others) and the hardcoded English UAT checkpoint banner stayed in English regardless of configuration. Both now render in the configured language, with output byte-identical to before when unset. (#2402)
