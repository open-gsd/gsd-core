---
type: Fixed
pr: 6255
---
**The secret-read guard test no longer contradicts the grep-pattern rule** — two rows in the regex-escape suite still expected a grep pattern operand to be blocked after #5884 made it a name, not a file read, which turned the base Tests run red. (#5884)
