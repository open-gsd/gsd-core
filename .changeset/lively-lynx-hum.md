---
type: Fixed
pr: 4789
---
**The secret-read guard no longer blocks container --env-file** — `docker`/`docker compose`/`podman`/`nerdctl` --env-file passes a file to the runtime without its contents ever reaching the conversation, so the operational rebuild works again; direct reads of secrets still block. (#4639)
