---
type: Fixed
pr: 5396
---

**Gate commands preserve phase directory names as data** — quotes, backticks and shell substitutions in phase context no longer rewrite command text. Breaking migration: capability manifests must replace `${PHASE_NUMBER}`, `${PHASE_DIR}` and `${PHASE_REQ_IDS}` with quoted `$GSD_GATE_PHASE_NUMBER`, `$GSD_GATE_PHASE_DIR` and `$GSD_GATE_PHASE_REQ_IDS` environment expansions; literal bare, braced, other braced parameter, length and indirect spellings of these names are rejected with a migration diagnostic, including manifest-owned variables of those names. Arithmetic and backslash-newline references must also be migrated; the literal spelling guard does not recognize them. Migrate before upgrading: a blocking gate with `onError: "skip"` otherwise warns and temporarily stops enforcing its block. The retired evaluator interpolation exports are removed, and injected bounded-shell dependencies now receive context through an `env` map.
