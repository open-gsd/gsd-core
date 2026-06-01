---
type: Changed
---
**Spawn announcements now include a liveness note** — every `◆ Spawning …` line and subagent dispatch instruction across all 26+ GSD workflows now carries the canonical phrase `runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze`. Silent subagents are visually identical to frozen sessions; this inline note sets the expectation so users wait instead of interrupting. Documented in `references/ui-brand.md § Spawning Indicators`, enforced by `tests/spawn-liveness-banner.test.cjs`, and explained in `docs/USER-GUIDE.md § Troubleshooting`.
