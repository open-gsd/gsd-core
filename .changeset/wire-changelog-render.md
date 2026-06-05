---
type: Changed
pr: 1
---
The release pipeline now automatically runs `changeset render` during the finalize job, promoting `.changeset/` fragments into a dated `CHANGELOG.md` section before publishing — previously a manual step that was routinely skipped (leaving v1.3.0 and v1.3.1 unpromoted, #690). A new `--allow-empty` flag prevents the verify gate from hard-failing on no-change releases by emitting a dated heading with a `_No notable changes._` placeholder when there are zero fragments.
<!-- docs-exempt: release-pipeline/CI infrastructure; operator-facing render docs live in .changeset/README.md (updated in this PR), not docs/ -->
