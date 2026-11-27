---
type: Fixed
pr: 0
---
**The graphify and intel capability-gate rule now sits in their `graphify.enabled` and `intel.enabled` configuration rows, and `docs/USER-GUIDE.md` links to it instead of carrying a second copy** — the installed, surfaced and config-enabled conditions and the `{ disabled: true }` troubleshooting step are stated where a reader looks up the key, and the compact-content subsection shrinks to a summary linking the configuration row and ADR-4139. (#6841)
