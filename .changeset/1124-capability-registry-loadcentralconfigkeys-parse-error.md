---
type: Changed
pr: 1131
---
<!-- docs-exempt: internal generator robustness — the central config-schema collision gate is build-time tooling with no user-facing config surface -->
**`loadCentralConfigKeys` now fails loud on a malformed central config-schema instead of silently returning an empty Set** — `ENOENT` (the schema legitimately absent) still returns an empty Set silently, but a JSON parse error or any other read failure now writes a prominent `stderr` warning naming the schema file and throws `ExitError(1)`. Previously a single `catch (_)` swallowed parse errors too, so a merge-conflict marker or truncated write in `config-schema.manifest.json` made every capability config key look non-central — the config-key collision / `pending-migration` gate fired zero warnings and `--check` passed clean, defeating the gate invisibly. (#1124)
