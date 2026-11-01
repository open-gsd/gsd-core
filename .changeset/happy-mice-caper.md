---
type: Added
pr: 5117
---
**Per-key config provenance has a tested resolution foundation** — a new read-only module tracks project and runtime-setting origins for future caller migrations, reads each layer with a size bound and refuses a repository file symlinked outside its directory; existing commands and output remain unchanged.
