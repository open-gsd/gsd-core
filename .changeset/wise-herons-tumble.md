---
type: Added
pr: 6653
---
**`/gsd-quick-batch` keeps the modes a batch was started with** — `quick-batch create` stores the `--validate`/`--research` set as `options.modes`, and `query init.quick-batch --resume <batch-id>` builds the section manifest and the mode variables from it, so a resume without `--validate` still verifies a batch started with it. A resume with a different set of mode flags is refused with an error naming the stored set; an invalid `options.modes`, or an `options` value that is not a JSON object, is refused at create before anything is written, and an invalid `options.modes` makes a hand-edited batch fail to load. Batches created before this change keep the flag-derived behavior.
