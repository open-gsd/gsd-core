---
type: Fixed
pr: 879
---
**profile-pipeline temp output now lands under the reaped GSD temp root.** `cmdExtractMessages` and `cmdProfileSample` previously created their output directories directly in `os.tmpdir()` root (`gsd-pipeline-*` / `gsd-profile-*`), which `reapStaleTempFiles` never scans (it only scans `GSD_TEMP_DIR = os.tmpdir()/gsd`). The directories accumulated forever. Both sites now call `ensureGsdTempDir()` and create under `GSD_TEMP_DIR`. Also adds missing `after`/`afterEach` teardown to four test fixtures that leaked `gsd-*` temp dirs on every `npm test` run. (#866)
