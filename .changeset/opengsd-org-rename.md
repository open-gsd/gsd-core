---
"@opengsd/get-shit-done-redux": major
"@opengsd/gsd-sdk": major
---

Rebrand: rename npm packages to the new @opengsd scope and publish 2.0.0.

- `get-shit-done-redux` → `@opengsd/get-shit-done-redux`
- `@gsd-redux/sdk` → `@opengsd/gsd-sdk`
- Final published version: **2.0.0** (both packages receive a major bump)

The CLI binary names (`get-shit-done-redux`, `gsd-sdk`, `gsd-tools`) are unchanged. Users will need to update install commands:
- Before: `npm install -g get-shit-done-redux`
- After: `npm install -g @opengsd/get-shit-done-redux`
