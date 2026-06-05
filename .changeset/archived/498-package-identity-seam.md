---
type: Fixed
pr: 498
---
The SessionStart update check now reports available updates again: the worker previously resolved the package name via `require('package.json').name`, which is `undefined` in the installed tree, so `npm view` always failed. Package coordinates now come from a single build-time Package Identity seam derived from package.json.
