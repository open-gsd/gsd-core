---
type: Fixed
pr: 0
---
**Plugin installs and updates ship a built runtime library** — after `claude plugin install` or `claude plugin update`, `gsd-tools` no longer starts with an unbuilt `gsd-core/bin/lib` that the self-heal cannot compile without `typescript`; the marketplace entry now installs a prebuilt `plugin` branch that each stable release publishes (#5796).
