---
type: Fixed
pr: 0
---
**`/gsd-new-project` and `/gsd-new-milestone` now self-heal when the research synthesizer returns `SUMMARY.md` inline instead of writing it** — under some context loads the `gsd-research-synthesizer` agent hits an LLM false-refusal (fabricating a non-existent write restriction) and returns the SUMMARY.md content in its reply rather than writing `.planning/research/SUMMARY.md`. Prompt hardening (#240) reduced but did not eliminate this. Both workflows now verify the file exists after the synthesizer returns and, if it is missing but content came back inline, the orchestrator persists it before spawning `gsd-roadmapper` — so the roadmapper never fails with "SUMMARY.md not found". (#222)
