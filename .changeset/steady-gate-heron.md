---
type: Fixed
pr: 5396
---

**Gate commands preserve phase directory names as data** — quotes, backticks and shell substitutions in phase context no longer rewrite command text. Breaking migration: capability manifests must replace `${PHASE_NUMBER}`, `${PHASE_DIR}` and `${PHASE_REQ_IDS}` with quoted `$GSD_GATE_PHASE_NUMBER`, `$GSD_GATE_PHASE_DIR` and `$GSD_GATE_PHASE_REQ_IDS` environment expansions; all bare, braced, length and indirect expansions of these reserved names are rejected, including manifest-owned variables with a migration diagnostic. Migrate before upgrading: a blocking gate with `onError: "skip"` otherwise warns and temporarily stops enforcing its block. The retired evaluator interpolation exports are removed, and injected bounded-shell dependencies now receive context through an `env` map.
