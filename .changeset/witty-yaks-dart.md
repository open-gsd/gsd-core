---
type: Fixed
pr: 6359
---
**`--pick` works on `extract-messages` and `profile-sample`, and a large `profile-sample` result is printed as JSON** — `gsd-tools extract-messages <project> --pick messages_extracted` and `gsd-tools profile-sample --pick messages_sampled` failed with "command output was not JSON" and exit code 1, and a `profile-sample` result over 50 KB was printed as a bare `@file:<path>` line instead of the JSON it names. Both commands now go through the same output handling as every other command. (#6332)
