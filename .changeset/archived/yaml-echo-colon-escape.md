---
type: Fixed
pr: 125
---
**YAML parse error in test-skip.yml from unescaped colon in echo strings** — two `run:` steps used unquoted `echo "...: ..."` syntax where the colon-space sequence caused `yaml.scanner.ScannerError: mapping values are not allowed here`. Fixed by wrapping the run value in YAML double-quotes so the colon is inside a quoted scalar. Closes #3857.
