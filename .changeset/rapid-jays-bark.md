---
type: Added
pr: 0
---
**Config-gated provider escalation when a run hits a quota or rate limit** — an executor killed by a provider throttle stopped the phase and waited for a manual restart; escalating a tier did not help because the same throttled provider was still in play. Set `dynamic_routing.provider_escalation` to an ordered list of fallback model IDs and GSD now switches provider on a quota-exceeded failure, logs the swap (`sonnet → gpt-5`), honors the provider's `Retry-After`, caps the walk at `max_escalations`, and names every model tried once the list is spent. Opt-in — unset, quota failures keep today's manual recovery prompt. (#2296)
