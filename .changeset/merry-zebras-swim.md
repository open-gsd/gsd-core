---
type: Fixed
pr: 0
---
**`check tdd-red-evidence` accepts a real node:test RED from `assert.throws`/`assert.rejects` with a RegExp** — node:test repeats `error` and `stack` in that test's diagnostic block; strict YAML rejected the duplicates and the whole report was refused as `invalid_record`. A diagnostic block whose only defect is repeated keys is now recovered (fail-closed: interruptions, a repeated `failureType`, any other YAML error, anchors and truncated blocks still refuse). (#5819)
