---
type: Fixed
pr: 0
---
**`validate health` no longer false-flags the `adaptive` model profile, and now warns when a `models.<phase_type>` tier is invalid** — health reported `W004 invalid model_profile "adaptive"` for a profile that has been valid since v1.40, and a typo like `"planning": "opuss"` was accepted in silence while the resolver quietly ignored it. Health now sources its profile list from the model catalog and emits `W022` for unknown phase types and invalid tier values.
