# Adversarial TDD review seal fixtures (#5354)

Hostile `TDD-REVIEW-SEAL.json` files for the `tdd-review-checkpoint` gate
(`gsd-core/bin/lib/gate-tdd-review-checkpoint.cjs`, seal I/O in
`gsd-core/bin/lib/gate-tdd-review-seal.cjs`). `tests/gate-tdd-review-checkpoint-hardening.test.cjs`
reads every `*.json` here, writes it as the phase's seal, and expects the gate to report `unreadable`
and `--record` to leave the file byte for byte.

## Provenance (CONTRIBUTING.md, "Fixture provenance")

These files were not derived from `parseSeal` or the seal writer. Each one is a wrong-type value taken
from the generic parser-input checklist in CONTRIBUTING.md ("Scalars where arrays are expected, and
objects where strings are expected", "Empty arrays vs missing arrays"): the JSON top level is a scalar,
null or array; a member that should be an object is a string or an array; a required member is missing;
a member that should be a string is a number. The checklist predates the seal.

| file | shape |
| --- | --- |
| `plans-string.json` | `plans` is a string |
| `plans-array.json` | `plans` is an array |
| `top-null.json` | top level is `null` |
| `top-array.json` | top level is an array |
| `top-string.json` | top level is a string |
| `no-plans-member.json` | no `plans` member |
| `entry-string.json` | a plan entry is a string |
| `entry-numeric-red.json` | a plan entry has a numeric `red` |

## `readable/`

Seals that parse but name nothing the gate can verify (CONTRIBUTING.md parser input list: duplicate keys,
NUL or replacement characters). The gate stays readable and credits only what it can check.

| file | shape | expected row |
| --- | --- | --- |
| `duplicate-key.json` | `red` appears twice, neither a hash | `FAIL`, RED and GREEN missing |
| `nul-in-red.json` | `red` is 39 hex characters and a NUL | `FAIL`, RED missing (the valid `green` is credited) |
