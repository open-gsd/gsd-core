---
type: Fixed
pr: 862
---
**Installer no longer leaks `gsd-cmd-rewrites-*` temp directories.** Each install that emitted slash commands left one `fs.mkdtempSync` directory under the system temp root; on `tmpfs` `/tmp` hosts these accumulated and consumed RAM-backed storage. `installRuntimeArtifacts()` now removes the temp copy in a `finally` once command files are copied.
