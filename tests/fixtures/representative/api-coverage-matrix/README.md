# API-coverage matrix fixture (#2366)

`multi-table-with-summary.md` is the verbatim 15-line `repro-coverage.md`
from #2366's own reproduction, used as a `COVERAGE.md` body and driven
through `check api-coverage.verify-pre <phaseDir>` (paired with a PLAN.md
that integrates an API, so a matrix is required) — the real blocking gate,
not `parseCoverageMatrix()` called in isolation.

Contains, in one file: the canonical `| capability | decision | reason |`
matrix, a second canonical-schema table under a "Transferred to a later
phase" heading (the section-split use case #2366 names as legitimate), and
a decoy 3-column "Coverage summary" table whose header row happens to read
`| tier | INTEGRATE | OPT-OUT |`.

Result (fixed by #2366): 3 rows (`search`, `skip`, `widget`), 0 errors,
`block: false` (see `MANIFEST.json`'s `expectedCounts`/`expectedErrorCount`/
`expectedBlock`, asserted directly in `tests/representative-corpus.test.cjs`).
Before #2366, the parser invented a `tier` capability from the summary table
(silent corruption — zero errors for that path) while rejecting the bolded
`skip` decision and two other cells (3 errors, `block: true`); that
`currentBuggyOutput` was pinned here until the fix landed and has since been
removed per the tripwire's flip-on-fix contract.
