---
type: Fixed
pr: 1457
---
**`--raw` CLI commands no longer drop stdout on the error path** — a command that emitted a JSON result/error envelope and then exited non-zero previously lost all of stdout (the output-capture wrapper discarded its buffer when the command threw to set a non-zero exit); the buffer is now flushed before the error propagates. (#1457)
