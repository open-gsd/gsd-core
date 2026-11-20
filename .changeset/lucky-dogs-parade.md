---
type: Fixed
pr: 6353
---
**`capability set --runtime` and `/gsd-surface` keep the install manifest in step with the skills they re-stage** — after a capability update, the next gsd-core install hashed the new skill text against the entry it had recorded for the old text, reported the skill as locally modified and backed it up to `gsd-local-patches/`. A re-stage now re-records the files GSD still owned, keeping the manifest's file mode, and a skill you edited by hand is still reported and backed up. (#6331)
