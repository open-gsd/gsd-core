---
type: Fixed
pr: 6450
---
**The audit-uat scope text names the archived phases it scans** — the skill and command declared only the live `phases/` globs, so an operator read the audit as live-phases-only while it also walks the milestone archives (flat `v*-phases` and `ws-*` shapes) under the active scope's root and under every workstream; both scope blocks now name them, and a test seeds every layout and fails if the scan reaches one the text does not name. (#6232)
