---
type: Fixed
pr: 0
---
**`~/.gsd/defaults.json` now merges per key inside a project** — a global default such as `model_profile` or `effort.agent_overrides` is honored whenever the project config does not set that key, instead of being dropped for the whole project because a `.planning/config.json` exists. A key the project sets still wins, a present non-object project section still blocks the global value, and the install-stamped `runtime` never fills in. `config-get`, capability gates, the omit gate, the install-time effort/model/tool merges and several single-file readers now resolve through one owner, so a value set in the root config or the global defaults is no longer ignored by a reader that looked at one file. The "global keys are ignored for model resolution" warning is removed because no listed key is inert any more.
