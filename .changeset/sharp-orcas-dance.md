---
type: Fixed
pr: 6659
---
**`quick-batch create` refuses a non-object `--options`** — an array, string, number or boolean `--options` is now a usage error before anything is written, instead of creating a batch that every later `resume`, `update` or `complete` refused. `--options null` still stores `{}`. (#6655)
