---
type: Changed
pr: 2294
---
**Phase plans now lead with a verified end-to-end "tracer" slice by default** — every plan starts with one thin, production-quality slice wired through every layer, which the executor verifies before building out the remaining tasks, so an architectural dead-end surfaces after one commit instead of after ten. Pass `--no-tracer` to restore the previous horizontal-layer default; `--mvp` now layers user-story framing and the Walking Skeleton on top of the tracer-first ordering. (#1945)
