---
type: Fixed
pr: 191
---
Retired the legacy SDK package seam by deleting `sdk/`, removing the `gsd-sdk` shim/bin publishing path, and moving required shared manifests to `gsd-core/bin/shared` for runtime/install compatibility.
