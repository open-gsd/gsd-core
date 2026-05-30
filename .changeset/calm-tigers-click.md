---
type: Fixed
pr: 515
---
Remove dead SDK-shim verification subsystem (installSdkIfNeeded and 17 transitively-called functions) from bin/install.js. Post-ADR-0174 sdk/ no longer ships; the subsystem had no live callers and could produce misleading 'tarball is missing sdk/dist/' errors. detectStaleStandaloneSdk and formatStaleStandaloneSdkWarning are kept (handle real stale-global-SDK condition).
