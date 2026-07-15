---
type: Security
pr: 2299
---
**`query config-get` no longer leaks secret values or walks the prototype chain** — the `--default` fallback path printed secret-named keys (e.g. `brave_search`) in plaintext instead of masking them, and dotted-key traversal used raw property access so `config-get __proto__`/`constructor` resolved to JavaScript internals at exit 0 instead of erroring. Both absent-key resolution and traversal are now masked and own-property-gated. (#2256)
