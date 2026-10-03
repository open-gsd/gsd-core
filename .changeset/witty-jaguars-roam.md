---
type: Fixed
pr: 5023
---
**`audit.enabled: true` in `.planning/config.json` now turns on the dispatch audit trail** — the documented config opt-in was inert: both live dispatch seams checked only the `GSD_AUDIT` environment variable, so the key wrote no `.planning/.gsd-trace.jsonl` and emitted no structured stderr error line, and `config-set audit.enabled true` was refused as an unknown key (a hand-edited `audit` section also drew an "unknown config key(s)" warning). The key now enables the trail exactly like `GSD_AUDIT=1` — either source turns it on, neither turns the other off — and `config-set` / `config-get` accept and round-trip it (booleans only). With the key absent or false and `GSD_AUDIT` unset, dispatch output, including the `--json-errors` envelope, is unchanged. An unreadable or malformed config file sets nothing: under `GSD_WORKSTREAM` a broken workstream config inherits the root config's value, and otherwise `GSD_AUDIT` alone decides. (#4975)
