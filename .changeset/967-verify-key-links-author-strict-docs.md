---
type: Fixed
pr: 0
---
**`verify key-links` docs now correctly state `from:`/`to:` are relative file paths** — the reference implied component/endpoint values the verifier never supported, so locator-style links failed with a misleading 'Source file not found' and the author's `pattern:` was never evaluated. (#967)
