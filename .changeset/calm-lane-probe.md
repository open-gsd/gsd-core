---
type: Changed
pr: 5278
---
**`/gsd-review` local-lane detection reads hosts from the lane descriptor (#5266)** — `review-lane availability` replaces three inline probes; results are unchanged (any HTTP reply, e.g. 401 behind an API key, reads `available`; redirects are not followed). Selected local-lane runs likewise treat a non-2xx `/v1/models` reply as reachable.
