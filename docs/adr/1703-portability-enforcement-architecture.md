# ADR-1703: Cross-platform portability enforcement as AST ESLint rules

- **Status:** Proposed
- **Date:** 2026-06-25
- **Issue:** [#1703](https://github.com/open-gsd/gsd-core/issues/1703) — Phase 0 of epic [#1702](https://github.com/open-gsd/gsd-core/issues/1702)
- **Supersedes:** the regex-based `scripts/lint-windows-test-portability.cjs`, the
  `tests/windows-test-parity-guard.test.cjs` named-set ratchet (G1–G6), the
  `// windows-portability-ok:` comment convention, and `scripts/lib/allowlist-ratchet.cjs`
  usage for portability classes.

## Context

GSD must run correctly when installed and run on Windows (backslash paths, `C:\`,
`cmd`/PowerShell, no `/bin/sh`, DOS file modes, `\r\n`), not just macOS/Linux. `CONTEXT.md`
documents a `DEFECT.WINDOWS-*` taxonomy of failure shapes that recur and ship to the
`windows-latest` CI lane undetected because the local `gsd-test` gate is Mac/Linux only.

Enforcement accreted as **three incompatible, hand-rolled mechanisms**:

1. **`scripts/lint-windows-test-portability.cjs`** — today a narrow regex *tripwire* for the
   chmod exec-bit + `sh`/`bash -c` shape, with a `windows-portability-ok` opt-out matched against
   the whole source. This epic was seeded (#1694) by an attempt to *extend* this script to the
   path-literal-in-assert shape; adversarial review of that extension found a regex that
   *silently could not match `deepStrictEqual`*, loose normalizer recognition (false negatives),
   and hand-rolled balanced-paren-splitting fragility — so the extension was **abandoned** in
   favour of this redesign. That abortive attempt is the concrete demonstration that growing the
   regex path is the wrong direction (Kernighan's Law, Greenspun's Tenth Rule); `CONTEXT.md`
   still records the path-literal lint as "enhancement TBD".
2. **`tests/windows-test-parity-guard.test.cjs`** — a *ratchet*: a frozen `KNOWN_OFFENDERS`
   allowlist (G1–G6) that grandfathers existing violations and only blocks *new* ones. It
   institutionalizes the defects instead of removing them.
3. **`// windows-portability-ok:`** — a bespoke comment opt-out matched by a whole-source regex,
   coarse enough that a single occurrence anywhere in a file can disable that file's check.

This is three parsers, two escape conventions, and a permanent grandfather list — to do a job
that a linter does natively.

## Decision

Replace all three with a single coherent mechanism: **AST-based ESLint rules in the existing
`local/*` plugin** (`eslint-rules/`, registered in `eslint.config.mjs`; ESLint v9 flat config,
`RuleTester` available from `require('eslint')`). They use the parsers already in the stack:
**Espree** (ESLint's default, `sourceType: 'commonjs'`) for the test-file `.cjs` rules, and
**`@typescript-eslint/parser`** (already configured for `src/**/*.cts`) for the two production
`.cts` rules. Specifically:

1. **AST, not regex.** Each portability check is an ESLint rule that matches real syntax nodes
   (`CallExpression`, `MemberExpression`, `Literal`, `TemplateLiteral`), not text. Rules run
   in-editor *and* in CI via the existing `eslint .` (invoked by `lint:ci` through `npm run
   lint`) — strictly more coverage than the CI-only `node scripts/lint-windows-test-portability.cjs`
   they replace.
2. **Hard-fail, no ratchet, no grandfathering.** There is no `KNOWN_OFFENDERS` allowlist.
   Every existing and currently-grandfathered violation is **fixed**, not registered.
3. **Zero escape hatches.** No per-line `eslint-disable` is permitted for portability rules
   (enforced — see "Strictness" below). Legitimately platform-specific code must be
   *structured* so the rule recognizes it (e.g. guarded by `process.platform !== 'win32'`),
   not annotated around.
4. **Single source of truth.** Shared vocabulary (the `PATH_RETURNING_FNS` set, mode-bit
   octals, non-portable exec names) lives in one module `eslint-rules/lib/portability-vocab.cjs`,
   consumed by every rule and guarded against drift by an AST completeness check.
5. **Tested with `RuleTester`.** Each rule ships an ESLint `RuleTester` suite of `valid`/
   `invalid` cases. Because `RuleTester` feeds fixtures to the rule directly (it does not scan
   the test file), the self-flagging problem that forced the whole-file opt-out simply does not
   exist — the opt-out hack is deleted, not reimplemented.

### Rule catalog (maps 1:1 to `DEFECT.WINDOWS-*`)

| Rule (`local/…`) | DEFECT (greppable in `CONTEXT.md`) | Surface |
|---|---|---|
| `no-path-literal-in-assert` | `DEFECT.WINDOWS-PATH-LITERAL-IN-ASSERT` | tests |
| `no-posix-mode-bit-assert` | `DEFECT.WINDOWS-POSIX-MODE-BIT-ASSERT` | tests |
| `no-unguarded-nonportable-exec` | `DEFECT.WINDOWS-TEST-PORTABILITY` (chmod+`sh -c`) + `DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE` | tests |
| `no-crlf-fragile-split` | `DEFECT.WINDOWS-TEST-PORTABILITY` (G1/G2/G3) + `DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE` | tests |
| `no-hardcoded-tmp` | `DEFECT.WINDOWS-TEST-PORTABILITY` (G4) | tests |
| `no-bare-npm-exec` | `DEFECT.WINDOWS-TEST-PORTABILITY` (G5) | tests |
| `require-userprofile-with-home` | `DEFECT.WINDOWS-TEST-PORTABILITY` (G6) | tests |
| `no-oversized-test-argv` | `DEFECT.WINDOWS-ARGV-OVERFLOW` | tests |
| `normalize-path-in-content` | `DEFECT.WINDOWS-PATH-LEAK-IN-MARKDOWN-CONTENT` (`RULESET.CONTENT-PATH-NORMALIZATION`) | `src/**/*.cts` |
| `require-fs-op-fallback` | `DEFECT.WINDOWS-FS-OPS` | `src/**/*.cts`, build/install |

**Taxonomy coverage.** This catalog addresses every `DEFECT.WINDOWS-*` class plus
`DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE` in `CONTEXT.md`, to the extent each is *statically*
detectable. `DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE` has two parts: (a) the CRLF / literal-`\n`
fence-match shape — covered by `no-crlf-fragile-split`; and (b) feeding a Windows `os.tmpdir()`
path into a Git Bash glob / `bash -c` — covered jointly by `no-hardcoded-tmp` (steer tmp usage)
and `no-unguarded-nonportable-exec` (require a platform guard on `bash -c`). The residual runtime
Git-Bash path-translation behavior is not fully statically decidable; the rules catch the source
shapes that produce it, not the runtime outcome. `DEFECT.WINDOWS-ARGV-OVERFLOW` (a test assembling an argv that exceeds the
Windows command-length limit) is detected heuristically by `no-oversized-test-argv` — it flags
very large `.repeat(N)`/concatenated literals passed to a `child_process` exec call; because the
true limit is a runtime property, this rule is an over-approximation tripwire, documented as
such, landing in Phase 3.

### Architecture

- **`eslint-rules/<rule>.cjs`** — one file per rule, matching the existing `local/*` rule
  style. Each exports `{ meta, create }`.
- **`eslint-rules/lib/portability-vocab.cjs`** — the single source of truth: `PATH_RETURNING_FNS`,
  mode-bit octal predicates, non-portable command names, normalizer-call recognizers.
- **`eslint-rules/lib/platform-guard.cjs`** — shared AST helper answering "is this node
  *control-dependent* on a Windows platform condition?" (a dominator check, not a textual
  mention). It MUST recognize the guard shapes that actually occur in the suite:
  `process.platform !== 'win32'` / `=== 'win32'` (negated), `os.platform()`, a hoisted
  `const isWindows = …` consumed by a later `if (!isWindows)`, early-return guards, nested `if`
  blocks, and `node:test` skips (`t.skip()`, the `{ skip }` option / skip objects). The current
  regex lint is unsound here — it treats a bare `const isWindows = …` as "guarded" without
  requiring the dangerous call to be inside the branch; the AST helper fixes that by checking
  control dependence. This is the precision backbone that makes zero-escape-hatch viable
  (Postel's Law mitigation), and its correctness is the epic's primary risk: with no opt-out, an
  unrecognized legitimate shape is a CI-blocking false positive. Mitigation — `platform-guard`
  is `RuleTester`-tested against guard shapes harvested from the existing suite, and an
  unrecognized legitimate shape is fixed by teaching the helper, never by adding an opt-out.
- **Drift guard** — a plain unit test (**not** `RuleTester`, which only feeds code *strings* to
  a rule and cannot read files or enumerate exports) parses `src/runtime-homes.cts` (and the
  relevant `bin/install.js` exports) with `@typescript-eslint/parser`, walks the AST to collect
  exported functions that return a filesystem path, and asserts each is present in
  `portability-vocab`'s `PATH_RETURNING_FNS` (or an explicit, reason-bearing ignore set). A new
  resolver that isn't registered fails CI.
- **Wiring** — rules register in `eslint.config.mjs`'s `local` plugin and are set to `error`.
  No new `lint:ci` step; they ride the existing `eslint .` (which `lint:ci` runs via `npm run
  lint`). The **production** rules additionally require expanding the `eslint.config.mjs` file
  globs to cover `bin/install.js` and the build/install scripts — today the globs are
  `src/**/*.cts`, `gsd-core/bin/**/*.cjs`, `scripts/**/*.cjs`, and `tests/**/*.test.cjs`, so the
  top-level `bin/install.js` named by `DEFECT.WINDOWS-FS-OPS` is **not yet linted**; the glob
  expansion lands in the phase that ships `require-fs-op-fallback`.

### Strictness — enforcing zero escape hatches (Postel's Law)

Because there is no opt-out, two things must hold:

1. **Rules must be precise.** Every rule recognizes legitimate platform-gating via
   `platform-guard.cjs` and the canonical normalizer forms, so correctly-written
   platform-specific code is never flagged. A false positive is a rule bug, fixed in the rule.
2. **The disable directive is itself banned for these rules.** Note `reportUnusedDisableDirectives`
   is **not** sufficient — it only flags directives that suppress *nothing*; a developer could
   write `// eslint-disable-next-line local/no-path-literal-in-assert` on a genuinely-violating
   line and the directive would count as "used" and pass. The ban is enforced by a dedicated
   guard: a small `local/no-portability-disable` meta-rule (matching `Program` comments) that
   **errors on any `eslint-disable[-next-line|-line]` directive referencing a
   `local/<portability-rule>`**. This is precise (only the portability rules are protected;
   every other rule keeps its normal inline-disable affordance), self-contained (no new
   dependency), and is itself unit-tested. `linterOptions.noInlineConfig: true` was rejected as
   the mechanism because it would ban *all* inline disables repo-wide, not just the portability
   rules.

## Applied software laws (engineering directive, Step 2.2)

- **Kernighan's Law / Greenspun's Tenth** — motivate the whole change: stop parsing a language
  with regex; use the real parser.
- **Choose Boring Technology** — ESLint + `typescript-eslint` already present; no new tech.
- **Gall's Law** — the migration is **incremental**: each phase adds one rule, fixes its
  violations, and removes only that class's hack. The old mechanisms keep running until their
  replacement lands. Full teardown is the *last* phase, not the first.
- **Postel's Law** — zero escape hatches raises the precision bar; `platform-guard.cjs` is the
  required mitigation so the strict rules never reject legitimate code.
- **Hyrum's Law** — removing `// windows-portability-ok:` breaks existing uses; every current
  occurrence is migrated (code restructured or the underlying violation fixed) in the phase
  that retires it. The vocab + rule semantics are documented here as the new contract.

## Consequences

**Positive:** one mechanism; in-editor feedback; debuggable, unit-tested rules; no grandfather
list; no bespoke comment parser; a documented, extensible architecture.

**Cost / risk:** fixing every grandfathered violation across the suite is a large, real diff
(~15+ offender files for G1–G6 alone, plus the path-literal/mode-bit sets). Mitigated by
phasing (one rule at a time, each independently reviewed and shipped) and by the rules being
`error` from the moment they land so no new debt accrues.

**Migration is phased (Gall's Law):**

- **Phase 0** ADR (this) — the design record.
- **Phase 1–3** `no-path-literal-in-assert`, `no-posix-mode-bit-assert`, `no-unguarded-nonportable-exec`,
  each landing with `portability-vocab.cjs` / `platform-guard.cjs` / the `RuleTester` harness as
  they are first needed.
- **Phase 4** the G1–G6 rules + fix all grandfathered offenders + delete the ratchet test.
- **Phase 5–6** production `normalize-path-in-content`, `require-fs-op-fallback`.
- **Phase 7** teardown: delete the regex script + allowlist-ratchet usage + the opt-out convention;
  rewrite `CONTEXT.md` `DEFECT.WINDOWS-*` predicates to point at the rules; the forward
  architecture guide ("how to add a portability rule").

Each implementation phase runs the full engineering directive (rubber-duck → laws → architecture
→ qa-test-architect → strict TDD via `RuleTester` → codex adversarial → Diátaxis → rebase+PR)
and is its own approved child issue + PR under epic #1702.

## Alternatives considered

1. **Keep extending the regex lint.** Rejected — the adversarial review proved it is
   structurally fragile; every extension adds parser surface and bugs.
2. **Keep the ratchet, just add rules.** Rejected — grandfathering is the thing being removed;
   the maintainer's directive is rip-and-replace, not legacy preservation.
3. **Keep `// windows-portability-ok:` as an escape hatch.** Rejected — zero escape hatches
   chosen; precision via `platform-guard.cjs` replaces the need for an opt-out.
4. **A standalone custom AST tool (not ESLint).** Rejected — Greenspun/Choose-Boring: ESLint is
   the boring, in-stack, in-editor linter; building a parallel tool repeats the original mistake.
