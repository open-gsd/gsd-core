---
type: Fixed
pr: 0
---
**`roadmap upgrade` rollback no longer overwrites a file another writer changed** — when a migration failed, rollback restored every snapshot unconditionally, silently destroying an edit another writer saved to ROADMAP.md, STATE.md, PROJECT.md, config.json or a rewritten phase file in the meantime; it now restores a file only while it still holds what the migration wrote, leaves any other file as found, and names each one in the failure message. A file the migration created is removed only if it still holds what the migration wrote. (#6351)
