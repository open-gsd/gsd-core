---
type: Fixed
pr: 4875
---
**Installer stops warning that hooks may not load when they already load as CommonJS** — installing over an existing hooks/package.json that declares "type": "commonjs" (any hand-written or formatter-touched file) printed "GSD hooks may not resolve as CommonJS"; the warning now states will-not-load only for the case that is true, a declared "type": "module", matching the plugin-path wording. (#4759)
