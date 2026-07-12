---
type: Fixed
pr: 2213
---
**Fixed unresolvable bare `require('gsd-core/...')` in `gsd-surface` command doc** — the four `require()` examples now derive the engine path from `runtimeConfigDir` (resolvable at runtime), and the reinstall hint corrects `npm i -g gsd-core` to `npm i -g @opengsd/gsd-core`. (#2116)
