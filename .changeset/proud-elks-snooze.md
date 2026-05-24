---
type: Fixed
pr: 13
---
**`gsd-sdk query --pick` now emits raw string scalars (CJS parity restored)** — the SDK dispatch formatter previously JSON-stringified picked values, which wrapped string outputs in literal quotes and broke shell capture/path composition. The pick formatter now returns raw string scalars with newline while preserving JSON output for non-string picks. (#13)
