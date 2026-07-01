---
type: Fixed
pr: 1869
---
Flat installs (command files laid out as `commands/gsd-<stem>.md` with no `commands/gsd/` source dir and no `skills/gsd-*/` dir) no longer report every skill-bearing capability as unsurfaced. `_resolveManifest` previously recognized only the nested-source and installed-skills layouts, so a flat install produced an empty skill manifest, collapsing the `full` profile to an empty surfaced set — validate-phase/Nyquist, secure-phase, ui-review, code-review and other capabilities silently read as disabled and their step hooks never fired despite config being enabled. A purely-additive flat-layout fallback now scans the parent commands dir, restoring correct surfacing.
