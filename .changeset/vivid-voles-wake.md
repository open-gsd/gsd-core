---
type: Fixed
pr: 6408
---
**The secret-read guard blocks a search tool run by `xargs` that names a secret file.** Since #6247, `echo '-e KEY' | xargs grep .env` was allowed and read `.env`: words `xargs` adds from stdin or an arg file can be options that turn the pattern into a file, so `grep`, `rg` and `jq` run by `xargs` no longer get the pattern or exclusion exemption.
