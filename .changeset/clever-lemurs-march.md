---
type: Fixed
pr: 2054
---
**Third-party capability skills now surface correctly after install** — a skills-only `role: feature` capability installed `active` but its skills never reached the runtime surface, `capability enable`/`set` rejected it as `unknown capability`, and `capability list` disagreed with `capability state`. `resolveSurface` now unions the composed registry's `capabilityClusters` into the surfaced skill set (no on-disk linking), the writer validates against the composed overlay-aware registry, and `capability list` carries a `surfaced` field matching `capability state`.
