# ADR-4593: A macOS-specific conformance-tier classifier, separate from the Windows-oriented one

- **Status:** Accepted
- **Date:** 2026-09-10
- **Issue:** [#4593](https://github.com/open-gsd/gsd-core/issues/4593) — Phase 4 (final) of epic [#4589](https://github.com/open-gsd/gsd-core/issues/4589)
- **Twin of:** [ADR-1703](./1703-portability-enforcement-architecture.md) (Windows portability enforcement architecture) — this ADR
  applies ADR-1703's evidence-first, static-classifier discipline to a second, macOS-specific surface,
  rather than reusing ADR-1703's Windows-oriented signal set unmodified.

> **Amendment (2026-09-11, [ADR-4641](./4641-windows-selector-consolidation.md)):** the general /
> Windows-oriented tier this ADR compares against was **546 files** when this ADR was written, and
> every figure below is accurate as of that date. ADR-4641 has since removed two over-broad
> detectors from `CATEGORIES`, taking it to **254**. Nothing in this ADR's decision changes:
> `MACOS_CATEGORIES` is a separate array, `chmod-mode-bit` and `symlink-keyword` keep the
> definitions and rationale recorded here, and the macOS tier remains 196 files. The historical
> figures below are deliberately left unedited.

## Context

`test-conformance`'s `macos-latest` CI leg (#4591, epic #4589 Phase 2) runs only the
`platform-conformance-tier` file list — a content classifier over `tests/**/*.test.cjs` that flags
files needing real-OS coverage, replacing a full-suite replay. That list's signal set
(`scripts/gen-platform-conformance-tier.cjs`'s `CATEGORIES`) was built for Windows: `windows-shell-token`,
`windows-env-var`, `hardcoded-path-vs-path-call`, etc. `macos-latest` today runs the identical
546-file list, which is Windows-oriented, not evidence-backed for macOS specifically.

#4593 was originally filed against `test-full`'s macOS legs, a job Phase 5 (#4603) has since
deleted; the issue was corrected before design work started to target `test-conformance`'s
`macos-latest` leg instead — the "shrink from full replay" half of the original ask was already
done by Phase 2.

Naively narrowing the general tier to macOS by simply dropping its three Windows-specific
categories (`windows-shell-token`, `windows-env-var`, `hardcoded-path-vs-path-call`) barely
narrows anything: measured, 546 -> 424 files (78% retained), because most files match multiple
signals simultaneously and only need one surviving signal to stay in the tier. That is nowhere
near the narrow, evidence-backed surface the issue asks for.

## Decision

Build a second, macOS-specific classifier (`classifyMacosContent` / `MACOS_CATEGORIES`) in the
same generator file, matching the issue's own named surface (zsh dispatch, case-sensitivity,
darwin-specific behavior) plus two categories reused verbatim from the general tier that are
genuinely Unix-relevant rather than Windows-motivated:

| Category | Test | Rationale | Files matched (of 930 eligible) |
|---|---|---|---|
| `darwin-literal` | `/\bdarwin\b/` (darwin alone, not the general tier's `win32-darwin-literal` OR) | The general tier's combined `win32\|darwin` category can't distinguish which branch fired; a file mentioning only `win32` says nothing about macOS. | 8 |
| `zsh-dispatch` | `/\bzsh\b/i` | Directly names the issue's own "zsh shell dispatch" surface. | 14 |
| `case-sensitivity` | `/case.?insensitiv\|case.?sensitiv/i` | Directly names the issue's own "case-sensitivity" surface (macOS's default case-insensitive-but-preserving filesystem). | 74 |
| `chmod-mode-bit` | reused verbatim from the general tier's `CATEGORIES` | Unix permission-bit semantics — genuinely macOS/Linux-relevant, not a Windows category (Windows has no chmod). | 73 |
| `symlink-keyword` | reused verbatim from the general tier's `CATEGORIES` | Symlink handling differs materially on macOS (case-insensitive-but-preserving FS, different default symlink permissions) — not Windows-motivated the way `windows-shell-token` etc. are. | 86 |

Applied to the real `tests/` unit-suite tree (930 files eligible under the same `suiteOf(f) === null`
gate the general tier uses), the union is **196 files** (21% of eligible files, vs. the general
tier's 546/930, 59%) — a materially narrower, macOS-evidence-backed tier. The per-category counts
above include `tests/platform-conformance-tier.test.cjs`'s own new fixture strings for
`zsh-dispatch`/`case-sensitivity` (e.g. `"shell: 'zsh {0}'"`) — self-referential by one file each,
since this test file lives in the same tree it classifies. Caught by an isolated code-review pass
comparing this table against a fresh live count; the union total was unaffected (that file was
already in the tier via an unrelated signal).

### Rejected: a standalone CRLF/`autocrlf` signal

The issue's own surface description names "CRLF-checkout behavior" as part of macOS's risk. This
was measured and rejected as a standalone macOS signal:

- The obvious first attempt, a literal `/\r\n/` match, hit 197/952 files (21% of all test files) —
  far too broad, because it matches routine defensive newline-normalization code
  (`.replace(/\r\n/g, '\n')`) present throughout the suite for unrelated reasons, not files
  specifically at CRLF-checkout risk.
- Narrowing to the actual named terms, `/\bCRLF\b|autocrlf/i`, still hit 143 files — still too
  broad to be a precise macOS-only signal.
- Root cause: in this codebase, CRLF is primarily a **Windows** checkout concern — ADR-1703 files
  its `no-crlf-fragile-split` rule under `DEFECT.WINDOWS-TEST-PORTABILITY`, not a macOS defect
  class. A CRLF-keyword signal was therefore pulling in files already covered by the general,
  Windows-oriented tier, not narrowing macOS coverage specifically.

The issue's "CRLF-checkout" framing is treated as "this is one of the risk categories macOS needs
coverage for" — already satisfied, for files that actually need it, by the general tier — not "this
is a macOS-exclusive signal to build."

### Implementation

- `scripts/gen-platform-conformance-tier.cjs` gains `MACOS_CATEGORIES`, `classifyMacosContent`,
  `classifyMacosTree`, and `renderMacosGeneratedFile`, mirroring the general tier's
  `CATEGORIES`/`classifyContent`/`classifyTree`/`renderGeneratedFile` exactly (same `suiteOf(f)
  === null` eligibility gate — see ADR-1703's sibling doc-comment in that file for why suite-tagged
  files are excluded entirely rather than merely deprioritized). A new `--target windows`
  (default, unchanged) / `--target macos` CLI flag selects which of the two independent generated
  outputs a given `--check`/`--write`/print invocation targets, so `package.json`'s
  `lint:generated-sync`/`regen:derived` chains invoke the same script twice rather than needing a
  second script file.
- New committed output `scripts/lib/macos-conformance-tier.generated.cjs`, exporting
  `MACOS_CONFORMANCE_TIER_FILES` — same generated-file convention (one array entry per line,
  sorted, `GENERATED FILE` header banner) as `platform-conformance-tier.generated.cjs`. Gated by
  the same `lint:generated-sync --check` fail-safe as the general tier — no new fail-safe mechanism
  needed; this is a second instance of an already-proven pattern.
- `.github/workflows/test.yml`'s `test-conformance` job: the `macos-latest` leg's "prepare
  conformance-tier test list" step reads `MACOS_CONFORMANCE_TIER_FILES` instead of the shared
  `CONFORMANCE_TIER_FILES`, writing into the same conventional `.ci-conformance-tests.txt`
  filename so the downstream `run-tests.cjs --files-from` step is unchanged. The `windows-latest`
  legs, their shard count, and everything else about the job are untouched — they keep using the
  general, Windows-inclusive tier.

## Explicit requirement for future widening proposals

Per issue #4593's "Done when": **before any future proposal to widen macOS coverage beyond this
196-file tier, check whether the motivating regression class is already covered by Phase 1's
`no-rendered-text-length-assert` ESLint rule (#4590, cataloged in ADR-1703)** — an author-time,
zero-escape-hatch rule that catches exactly the shape behind #4421 (a rendered-text-length
assertion embedding an OS-derived path, e.g. `os.tmpdir()`, whose length differs between macOS's
`/private/var/folders/…` prefix and Linux's shorter one). #4421's root cause was that
static-assertion shape, not a real macOS behavioral divergence requiring dynamic real-OS
execution to catch. A future explorer proposing full macOS/Linux parity coverage should confirm
new evidence of a *behavioral* divergence this static classifier and `no-rendered-text-length-assert`
both miss, rather than re-proposing parity on the strength of #4421 alone — #4421 is already
covered.

## Consequences

**Positive:** `macos-latest` now runs a narrower, macOS-evidence-backed 196-file tier (down from
the shared 546-file Windows-oriented list) — a real reduction (~64%) in real-OS macOS CI minutes
for files with no macOS-specific signal, without dropping coverage for files that do carry one.
Same generator, same fail-safe convention, same install/build ripple discipline as the general
tier — no new mechanism class.

**Cost / risk:** a second static classifier is still subject to the same disclosed limit as the
general tier (ADR-1703 / `gen-platform-conformance-tier.cjs`'s own header doc-comment): it is
content-based, not a real per-file behavioral diff. Mitigated the same way — the most recent
full-matrix `next` run was green on every file in this classification before it was built. The
legacy full-matrix macOS job's actual safety-net window was much shorter than originally planned:
Phase 2 (#4591) added it as a non-gating safety net intended for "one release cycle," but Phase 5
(#4603) retired it roughly 4 hours later, the same day, after discovering it was purely additive to
the new conformance job (10 OS-specific CI jobs per PR instead of the intended reduction) rather
than a genuine transition period — see #4603 for the full accounting. `macos-latest`'s coverage
here has not yet had an extended real-world safety-net window of its own; that is an accepted,
disclosed risk of shipping Phase 4 promptly rather than waiting, consistent with this epic's general
preference for fast, evidence-driven iteration over a long unmonitored parallel-running period.

## Alternatives considered

1. **Apply the general tier's signals minus the three Windows-specific categories.** Rejected —
   measured at 424/546 files (78% retained), nowhere near the narrow, macOS-evidence-backed
   surface the issue asks for; see "Context" above.
2. **A standalone CRLF/`autocrlf` signal.** Rejected — see "Rejected: a standalone CRLF/`autocrlf`
   signal" above; both attempted regexes (197 and 143 files) were too broad and were really
   re-selecting Windows-relevant files already covered by the general tier.
3. **A single, unified classifier covering both Windows and macOS signals, with per-OS filtering
   at CI-invocation time.** Rejected — would still need two independent signal sets internally to
   produce two independently-narrow lists, so it does not actually simplify anything over two
   sibling classifier functions in the same file; a single combined list reproduces the 78%-retained
   problem from alternative 1.
