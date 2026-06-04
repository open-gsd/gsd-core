---
type: Fixed
pr: 675
---
**`npx @opengsd/gsd-core` upgrades no longer abort with "applied migration checksum changed"** — an already-applied installer migration whose recorded checksum drifted (e.g. a shipped body was edited) is now detected and reconciled automatically on the next install, instead of hard-failing the upgrade. Replaces the published-checksum allowlist with general self-healing recovery plus a CI baseline lock.
