---
type: Fixed
pr: 1534
---
Add prototype-pollution guard to the workstream/root config merge (_deepMergeConfig) so a config.json with a __proto__/constructor/prototype key can no longer spoof unset config flags.
