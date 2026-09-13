---
type: Fixed
pr: 4643
---
**Windows path-confinement is now actually verified** — the external-descriptor write-confinement check resolved paths through the ambient `path` module, so its Windows semantics (drive letters, UNC paths, separator handling) were only ever exercised when the suite happened to run on Windows, and never with Windows-specific inputs. A Windows-only escape was therefore unverified on every platform. The check now accepts an optional path implementation, and drive-letter, UNC, traversal and prefix-boundary escapes are covered deterministically. (#4641)
