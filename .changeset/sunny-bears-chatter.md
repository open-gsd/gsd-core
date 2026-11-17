---
type: Fixed
pr: 5407
---
**Git-source capability installs are no longer staged as embedded repositories** — omit the temporary clone’s `.git` metadata while preserving checkout files, validation, and consent hashing. A Git bundle’s content hash is recomputed from the metadata-free checkout when that bundle is next installed or upgraded.
