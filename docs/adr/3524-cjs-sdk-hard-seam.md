# CJS↔SDK hard seam — one source of truth per Shared Module

- **Status:** Superseded by ADR-0174 (2026-05-23); originally Proposed (2026-05-14)
- **Date:** 2026-05-14
- **Tracking issue:** [#3524](https://github.com/open-gsd/get-shit-done-redux/issues/3524)
- **Related PRD:** [`docs/prd/3524-cjs-sdk-hard-seam.md`](../prd/3524-cjs-sdk-hard-seam.md)
- **Extends:** ADR-0005 (seam map) — adds the **Shared-Module Source Policy** to the seam family
- **Defers to:** ADR-0001 (Dispatch Policy Module), ADR-0003 (Model Catalog Module), ADR-0004 (Planning Workspace Module), ADR-0006 (Planning Path Projection Module), ADR-0009 (Shell Command Projection Module — post-Phase 3–4, also subsuming superseded ADR-0010)

We decided to harden the boundary between the CJS tooling layer (`get-shit-done/bin/lib/*.cjs`) and the SDK (`sdk/src/**/*.ts`) by making every Module that is conceptually shared between the two runtimes have exactly one hand-authored source of truth and at most one generated artifact per runtime. The trigger is the recurring drift bug class — #1535, #1542, #2047/#2052, #2638/#2655, #2653/#2670, #2687/#2706, #2798/#2816, #3055/#3116, #3523 — each of which was a fix landing on one side without the other.

The precedent shape is already in the repo. `sdk/scripts/gen-command-aliases.ts` emits `sdk/src/query/command-aliases.generated.ts` **and** `get-shit-done/bin/lib/command-aliases.generated.cjs` from one TypeScript source. `sdk/scripts/check-command-aliases-fresh.mjs` is the CI freshness gate. The two consuming sides are pure Adapters over the generated artifact. This ADR generalizes that pattern to the other Shared Modules and forbids the hand-synced-pair anti-pattern that produced #3523.

## Decision

### 1. Shared-Module Source Policy

A **Shared Module** is any Module whose Interface is consumed identically by both the CJS toolset and the SDK. The CONTEXT.md domain glossary already calls these out — e.g. `STATE.md Document Module` is explicitly typed as "Shared CJS/SDK pure transform Module."

For every Shared Module:

1. **Exactly one hand-authored source of truth.** Lives at `sdk/src/<module-name>/` as TypeScript when the Module has behavior, or `sdk/shared/<module-name>.manifest.json` when the Module is pure data.
2. **Generated artifacts only.** The CJS-side file is `get-shit-done/bin/lib/<module-name>.generated.cjs` and is emitted mechanically. It is never hand-edited.
3. **Per-Module freshness check.** A CI script `sdk/scripts/check-<module>-fresh.mjs` re-runs the generator and fails if the emitted artifact differs from the committed one. Precedent: `check-command-aliases-fresh.mjs`.
4. **Per-Module drift lint** (when the source is data, not a generator output). Precedent: `scripts/lint-shell-command-projection-drift.cjs`. The lint asserts the canonical-owner invariants that aren't captured by file-equality.
5. **Hand-synced pairs are forbidden.** A pre-merge `lint-shared-module-handsync.cjs` greps `get-shit-done/bin/lib/` for non-`.generated.*` files whose basename matches a `sdk/src/query/<same-name>.ts` source and fails the build unless the pair is explicitly allow-listed.

### 2. Module-indexed canonical-owner table

The table below indexes by Module, not by physical layer. Each row names the source of truth, the emitted artifacts, the Adapter sites, and either the new ADR section that defines the Module or the existing ADR that already owns it.

| Module | Status | Source of truth | Generated artifacts | Adapters |
|---|---|---|---|---|
| **STATE.md Document Module** | New under this ADR (Phase 1) — see CONTEXT.md "STATE.md Document Module" | `sdk/src/state-document/index.ts` (promoted from `sdk/src/query/state-document.ts`) | `sdk/src/query/state-document.generated.ts`, `get-shit-done/bin/lib/state-document.generated.cjs` | `bin/lib/state.cjs` and `sdk/src/query/state*.ts` import the generated form |
| **Configuration Module** | New under this ADR (Phase 2) — definition added to CONTEXT.md as part of Phase 2 | `sdk/src/configuration/index.ts` plus data manifests `sdk/shared/config-schema.manifest.json` and `sdk/shared/config-defaults.manifest.json` | `sdk/src/query/config-schema.generated.ts`, `get-shit-done/bin/lib/config-schema.generated.cjs`, `get-shit-done/bin/lib/configuration.generated.cjs` | `bin/lib/config.cjs`, `bin/lib/core.cjs:loadConfig`, `sdk/src/config.ts` |
| **Workstream Inventory Module** (Builder) | Amended under this ADR (Phase 3) — Builder split documented in CONTEXT.md update | `sdk/src/workstream-inventory/builder.ts` (pure projection from directory entries + STATE.md text + plan scan results → typed inventory) | `sdk/src/query/workstream-inventory-builder.generated.ts`, `get-shit-done/bin/lib/workstream-inventory-builder.generated.cjs` | Per-side fs Readers (`workstream-inventory.cjs` sync, `workstream-inventory.ts` async) call the Builder. Readers stay hand-authored because the fs idiom legitimately differs. |
| **Project-Root Resolution Module** | New under this ADR (Phase 4) — short CONTEXT.md entry, behavior already de-facto shared | `sdk/src/project-root/index.ts` | `get-shit-done/bin/lib/project-root.generated.cjs` | `bin/lib/core.cjs` (`findProjectRoot`, `findEffectiveRoot`), `sdk/src/helpers.ts` |
| **Frontmatter Module** | Conditional (Phase 3, only if drift catalogue confirms pair duplication) | `sdk/src/frontmatter/index.ts` | `get-shit-done/bin/lib/frontmatter.generated.cjs` | Existing handler call sites |
| **Plan Scan Module** | Conditional (Phase 3 or later) | `sdk/src/plan-scan/index.ts` | `get-shit-done/bin/lib/plan-scan.generated.cjs` | Phase/roadmap routers |
| **CJS Command Router Adapter Module** | Amended under this ADR (Phase 5). Existing Module (per CONTEXT.md) is extended so the per-family `handlers` map delegates to the SDK runtime bridge in-process instead of to parallel CJS handler implementations. | `sdk/src/query-runtime-bridge.ts` (already exists) + per-family delegate emitter | `get-shit-done/bin/lib/cjs-command-router-adapter.cjs` (existing, ~40 lines) plus per-family `handlers` maps that `require('../../sdk/dist/query-runtime-bridge.cjs')` and call `QueryRuntimeBridge.execute()` | `bin/gsd-tools.cjs` and the seven `bin/lib/*-command-router.cjs` files are the consumers. Per-family CJS handler files (`state.cjs`, `verify.cjs`, `init.cjs`, etc.) shrink to delegates or are deleted once the SDK handler is the only implementation. |
| Command-Alias Module | **Already sealed** by this pattern's precedent — `sdk/scripts/gen-command-aliases.ts` + `check-command-aliases-fresh.mjs` | No change | No change | No change |
| Dispatch Policy Module | **Defer — see ADR-0001** (and its 2026-05-05 SDK Runtime Bridge amendment) | n/a | n/a | n/a |
| Model Catalog Module | **Defer — see ADR-0003**; the `sdk/shared/model-catalog.json` manifest already follows the source-of-truth policy | n/a | n/a | n/a |
| Planning Workspace Module | **Defer — see ADR-0004**; `withPlanningLock`, workstream pointer policy, lock semantics stay where they are | n/a | n/a | n/a |
| Planning Path Projection Module | **Defer — see ADR-0006**; SDK is canonical, CJS path resolution converges via Phase 4 if any divergence is found | n/a | n/a | n/a |
| Shell Command Projection Module (incl. platform fs + subprocess after Phase 3–4 expansion) | **Defer — see ADR-0009**; this Module is the canonical owner for `platformWriteSync`, `platformReadSync`, `platformEnsureDir`, `execGit`, `execNpm`, `execTool`, `probeTty`, `normalizeContent` | n/a | n/a | n/a |
| Skill Surface Budget Module | **Defer — see ADR-0011** (accepted, not the 0011-superseded draft) | n/a | n/a | n/a |

### 3. Out-of-seam Modules (per-runtime, no shared source)

These remain CJS-only. Drift cannot occur because there is no SDK counterpart. If any later needs an SDK port, that port is a new enhancement, not a parallel implementation.

- `bin/lib/graphify.cjs`
- `bin/lib/gsd2-import.cjs`
- `bin/lib/schema-detect.cjs`
- `bin/lib/fallow-runner.cjs`
- `bin/lib/intel.cjs`
- `bin/lib/drift.cjs`
- `bin/lib/installer-migrations.cjs` (installer runtime is CJS-native; SDK consumes via `sdk-package-compatibility.ts` Adapter)

### 4. Per-side I/O Adapters legitimately differ

The per-side state Adapter, verify Adapter, and similar handlers are **not** in the Shared-Module table. CJS callers use synchronous fs/exec; SDK callers use async I/O and the SDK observability decorators. The pure transforms behind them (parsing, projection, normalization) are extracted into Shared Modules per the table above; the I/O remains per-side. Golden parity tests in `sdk/src/golden/` pin observable behavior across the seam.

### 5. Enforcement (per existing repo precedents, not new conventions)

Drift is blocked at three layers, each modeled on an existing in-repo script:

1. **Per-Module freshness check** — `sdk/scripts/check-<module>-fresh.mjs`, one per Shared Module in the table. Precedent: `check-command-aliases-fresh.mjs`.
2. **Per-Module drift lint** (when invariants are not pure file-equality) — `scripts/lint-<module>-drift.cjs`, one per data-manifest-backed Module. Precedent: `lint-shell-command-projection-drift.cjs`.
3. **Hand-sync pair lint** — `scripts/lint-shared-module-handsync.cjs` rejects any pair of files at `get-shit-done/bin/lib/<name>.cjs` and `sdk/src/query/<name>.ts` (or `sdk/src/<name>.ts`) that are neither generated artifacts nor on an explicit allow-list. This blocks the #3523 anti-pattern at PR time.

CODEOWNERS extends to `sdk/src/<module>/` for each Shared Module. Architecture-team review is required for changes to a source of truth.

A top-of-file banner is auto-inserted by each generator into the emitted `.generated.cjs` / `.generated.ts` files. Banner pattern follows the existing `command-aliases.generated.*` files: a header noting "GENERATED FILE — Source: …". No additional banner tooling is introduced.

### 6. New CONTEXT.md entries added by this ADR's phases

- **Configuration Module** (added during Phase 2): Module owning config load, legacy-key normalization, defaults merge, and explicit on-disk migration for `.planning/config.json`. Interface: `loadConfig(cwd) → MergedConfig` (pure read, no disk write); `normalizeLegacyKeys(parsed) → { parsed, normalizations[] }` (idempotent, returns the list of normalizations applied for migration logging); `mergeDefaults(parsed) → MergedConfig`; `migrateOnDisk(cwd) → MigrationReport` (explicit, opt-in, called only by the installer and by `gsd-tools migrate-config`). Invariants: never mutates disk inside `loadConfig`; legacy top-level keys (`branching_strategy`, `sub_repos`, `multiRepo`, `depth`) are normalized into their canonical nested locations in the returned value; defaults come from the shared `config-defaults.manifest.json`.
- **Project-Root Resolution Module** (added during Phase 4): Module owning project-root and effective-root resolution heuristics including own-`.planning` detection, parent-`sub_repos` traversal, legacy `multiRepo`, and `.git`-ancestor fallback.
- **Workstream Inventory Module — Builder split** (CONTEXT.md amendment during Phase 3): the existing Module entry gains a sub-paragraph noting that the pure projection logic is the source of truth and the per-side Reader Adapters are hand-authored over the generated Builder.
- **CJS Command Router Adapter Module — runtime-bridge delegation** (CONTEXT.md amendment during Phase 5): the existing Module entry gains a paragraph noting that the per-family `handlers` map delegates to `QueryRuntimeBridge.execute()` in-process via `require('../../sdk/dist/query-runtime-bridge.cjs')`. Per-side CJS handler files (`state.cjs`, `verify.cjs`, etc.) that previously held parallel implementations are reduced to delegates or deleted once their SDK counterpart is the only remaining implementation. CJS-only Module handlers (graphify, gsd2-import, schema-detect, fallow-runner, intel, drift) keep their in-process CJS implementations because no SDK counterpart exists.

## Consequences

- **The hand-synced-pair anti-pattern that produced #3523 becomes impossible to merge.** The `lint-shared-module-handsync.cjs` gate rejects any new pair that is not generated. The `check-<module>-fresh.mjs` gates reject any edit to a generated file that is out of sync with its source.
- **The seam vocabulary stays inside the existing CONTEXT.md / LANGUAGE.md frame.** No new layer labels ("shared core", "shared data"); the unit of seam ownership is the Module, as it already is everywhere else in this repo.
- **No new build tooling is introduced.** The generator pattern is the existing `gen-command-aliases.ts` shape. No dual CJS+ESM bundler, no `package.json` `exports` subpath change, no `tsup`/`rollup` decision.
- **Each phase ships one Shared Module.** The smallest phase (STATE.md Document Module) ships first because both files are already character-identical — the deletion test passes on contact. The trigger bug class (#3523) is closed in Phase 2 by the Configuration Module. The seam becomes a real wall in Phase 5 when the CJS routers stop holding parallel handler implementations.
- **CJS dispatch collapses onto the SDK runtime bridge.** Once Phase 5 lands, every canonical command running via `gsd-tools` executes the same SDK handler that `gsd-sdk query` executes — in-process, not subprocess. The per-side state/verify/init/phase/roadmap/validate handler implementations in CJS are replaced by thin delegates over `QueryRuntimeBridge.execute()`. The result-shape contract is preserved (`{ exitCode, stdoutChunks, stderrLines }` per the Query CLI Output Module, ADR-0001).
- **Existing ADRs are deferred to, not restated.** Planning Path Projection (ADR-0006), Model Catalog (ADR-0003), Planning Workspace (ADR-0004), Dispatch Policy (ADR-0001), Shell Command Projection (ADR-0009) remain authoritative for their domains. The new ADR adds Shared-Module Source Policy, the per-Module entries above, and the CJS Command Router Adapter Module amendment.
- **Per-side I/O Adapter divergence is preserved at the runtime-bridge boundary.** The CJS router's sync execution model is preserved: `QueryRuntimeBridge.execute()` exposes a sync entry point for CJS callers (or, when the underlying SDK handler is async, the bridge runs an in-process event loop step). No subprocess hop is added. Async SDK call sites continue to use the async bridge directly.
- **Enforcement reuses existing scripts.** Three new lint/check primitives, all modeled on scripts already in `scripts/` and `sdk/scripts/`. CI wiring follows the existing precedent.

## Out of scope

- Migrating CJS-only Modules (graphify, gsd2-import, schema-detect, fallow-runner, intel, drift) to SDK handlers — each is its own enhancement.
- Sync→async migration of CJS state/verify Adapters — leaves the per-side Adapter shape intact, which is the point.
- Defining a Verify Module before the verify surface has a shared Interface — that is precondition work for a future enhancement, not this one.

## Amendments

_(Append-only. Use a dated header when the decision evolves.)_

### 2026-05-23 — validate.ts → verify.cjs generator pattern (issue #6)

Three pure helpers from `sdk/src/query/validate.ts` Check 8 are now generated into
`get-shit-done/bin/lib/validate.generated.cjs` via `sdk/scripts/gen-validate.mjs`,
following the same I/O adapter pattern established by PR #154 (issue #4):

**Generator:** `sdk/scripts/gen-validate.mjs`
**Artifact:** `get-shit-done/bin/lib/validate.generated.cjs`
**Freshness check:** `sdk/scripts/check-validate-fresh.mjs`
**CI:** `.github/workflows/test.yml` — "SDK generated validate artifact drift check"

**Three drift items resolved (issue #6):**

1. **W007 `activeDiskPhases`** — `verify.cjs` Check 8 previously iterated `diskPhases`
   (which includes archived milestone phases via `forEachArchivedPhaseToken`) for the W007
   check. Archived phases absent from the current ROADMAP produced false W007 warnings.
   Fix: W007 now iterates `activeDiskPhases` (from `collectDiskPhases()` only, without
   `forEachArchivedPhaseToken`), matching `validate.ts` Check 8 behavior.

2. **`phaseVariants()` normalization** — `verify.cjs` Check 8 used `parseInt(p).padStart(2,'0')`
   for disk-existence and roadmap-membership checks, which drops letter suffixes (e.g. "3B" →
   "03" instead of "03B"). Phase dirs with letter-suffix padding mismatches (ROADMAP "3B",
   disk "03B-foo") produced false W006 and W007. Fix: both checks now use `phaseVariants(p)`
   from the generated module, which returns the full normalized Set including letter-suffix forms.

3. **W006 unchecked-phase variant skip** — `verify.cjs` Check 8 built `notStartedPhases` with
   raw + `parseInt`-padded forms (drops letter suffix). `phaseVariants()` is now used instead,
   so unchecked entries like "3B" correctly suppress W006 for "03B" (and vice versa).

**`phaseVariants` extraction note:** `phaseVariants` is defined as a closure inside `validateHealth`
in the compiled output (not a module-level export). It is extracted via brace-balanced source-text
parsing from `sdk/dist/query/validate.js`, the same technique used for `escapeRegex` extraction in
`gen-phase-lifecycle-policy.mjs`. The function is deterministic and pure: no closures over external
state, no side effects.

**Parity tests:** `tests/6-validate-cjs-drift-regression.test.cjs` — 5 tests (all GREEN after fix,
all RED on pre-fix `origin/main`). Covers each drift item with concrete fixtures:
- Drift 1: two milestone archives (v1.0 old, v1.1 active); v1.0 phase absent from ROADMAP.
- Drift 2: ROADMAP "01A", disk "1A-foo" — padding mismatch.
- Drift 3: ROADMAP "3B", disk "03B-foo" — zero-padded letter-suffix mismatch.

**Allowlist:** `scripts/shared-module-handsync-allowlist.json` — `verify.cjs` entry updated to
reference the generator and freshness check. Classification remains `cooperating-sibling` (verify.cjs
is still a full implementation; only Check 8 helpers are generated).

#### Extension — issue #26: W005/W006-archived/I001 generator migration

PR #3479 fixed three false-positive classes in `sdk/src/query/validate.ts`. PR #3806 hand-ported
the three fixes to `get-shit-done/bin/lib/verify.cjs` but did not route them through the generator
— meaning they could drift again. Issue #26 closes this gap by extending `gen-validate.mjs`
(introduced in this amendment above) to also extract and export the W005/W006-archived/I001 items.

**Four additional exports added to `validate.generated.cjs` (issue #26):**

1. **`phaseDirNameRe` (W005)** — The `PHASE_DIR_NAME_RE` constant `/^\d{2,}(?:\.\d+)*-[\w-]+$/`
   is now a named export from `validate.ts` and extracted by `gen-validate.mjs`. `verify.cjs`
   Check 6 consumes `phaseDirNameRe` from the generated artifact instead of an inline copy.
   Reproducer: `mkdir -p .planning/phases/999.1-foo` → zero W005 (previously fired with
   the `\d{2}` two-digits-only regex before PR #3806 / PR #3479).

2. **`PHASE_TOKEN_FROM_DIR_RE` (W006-archived)** — The regex constant previously inline in
   `verify.cjs`'s `forEachArchivedPhaseToken()` and `collectDiskPhases()`. Extracted from the
   module-level `const` in the compiled output. `verify.cjs` inline copy removed.

3. **`MILESTONE_ARCHIVE_DIR_RE` (W006-archived)** — The regex constant previously inline in
   `verify.cjs`'s `listMilestoneArchiveDirs()`. Extracted the same way. `verify.cjs` inline copy
   removed. Together `PHASE_TOKEN_FROM_DIR_RE` and `MILESTONE_ARCHIVE_DIR_RE` ensure the
   archive-walking logic uses the same patterns as `validate.ts`.

4. **`canonicalPlanStem` (I001)** — The top-level helper function previously inline in
   `verify.cjs` Check 7. Extracted via `extractTopLevelFunction()` (brace-balanced parser).
   `verify.cjs` inline copy removed. Fix: `68-01-scaffolding-PLAN.md` correctly matches
   `68-01-SUMMARY.md` — both reduce to `68-01` via `canonicalPlanStem()`.

**W006-archived coverage note:** Issue #26 describes W006-archived as "RELATED TO but DISTINCT
FROM" PR #156's W006 fix. Investigation confirmed both fixes are ALREADY in `verify.cjs` (from
PR #3806). The gap was generator coverage: the regex constants used by `forEachArchivedPhaseToken`
were inline copies with no generator protection. This amendment closes that gap by extracting them.
No new behavioral fix is required — the generator pattern extension is the deliverable.

**`validate.ts` change:** `PHASE_DIR_NAME_RE` promoted from inline anonymous regex to a named
`export const` so it appears as an extractable identifier in the compiled ESM output.

**Extraction methods used:**
- `extractConstRegExp()` (new in `gen-validate.mjs`) — handles `const` and `export const`
  single-line RegExp assignments. Used for `phaseDirNameRe`, `PHASE_TOKEN_FROM_DIR_RE`,
  `MILESTONE_ARCHIVE_DIR_RE`.
- `extractTopLevelFunction()` (new in `gen-validate.mjs`) — brace-balanced parser for top-level
  named function declarations. Used for `canonicalPlanStem`.

**Parity tests:** `tests/26-w005-w006-i001-cjs-drift-regression.test.cjs` — 7 tests.
- W005: no false positive for `999.1-foo`; W005 still fires for single-digit prefix.
- W006-archived: no false W006 for phase archived under `milestones/v1.0-phases/`; unit tests
  for `MILESTONE_ARCHIVE_DIR_RE` and `PHASE_TOKEN_FROM_DIR_RE` export and behavior.
- I001: no false I001 when long-stem PLAN matches short-stem SUMMARY via `canonicalPlanStem`;
  I001 still fires when there is genuinely no SUMMARY; unit test for `canonicalPlanStem` export.

**Cross-references:** issue #26 cures the same false-positive scenarios as issue #6 but for
the W005/W006-archived/I001 check paths. The artifact `validate.generated.cjs` now covers all
six drift surfaces originally identified across both issues. This completes the validate.ts ↔
verify.cjs migration scope for generator-pattern coverage.

### 2026-05-23: Phase * cooperating-sibling retirement — I/O adapter pattern for phase lifecycle (issue #4)

**Context:** Issue #4 revealed that `phase.cjs:cmdPhaseComplete` was non-idempotent: every call blindly incremented `Completed Phases` by 1 and computed Progress without a 100% clamp. The SDK's `phase-lifecycle.ts` already contained the correct idempotent implementation ("Root cause 1 fix" block ~line 1644), but CJS had no way to share it because the mutation handlers are async I/O-bound and Section 4's "I/O stays per-side" rule prevents direct sharing.

**Decision:** Apply the I/O adapter pattern (Section 4) to the pure-computation kernel inside `phase-lifecycle.ts`:

1. **Three new generator scripts** extract pure helpers from the phase family:
   - `sdk/scripts/gen-phase.mjs` → `get-shit-done/bin/lib/phase.generated.cjs`
     (pure helpers: `isCanonicalPlanFile`, `describeNonCanonicalPlans`)
   - `sdk/scripts/gen-phase-lifecycle.mjs` → `get-shit-done/bin/lib/phase-lifecycle.generated.cjs`
     (pure helpers: `deriveProgressFromRoadmap`, `clampPercent`)
   - `sdk/scripts/gen-phase-lifecycle-policy.mjs` → `get-shit-done/bin/lib/phase-lifecycle-policy.generated.cjs`
     (14 pure policy helpers: `generatePhaseSlug`, `computePhaseDirectory`, `buildPhaseRoadmapEntry`, etc.)

2. **`phase.cjs:cmdPhaseComplete`** is migrated to use `deriveProgressFromRoadmap` + `clampPercent` from the generated artifact. It reads the freshly-updated ROADMAP synchronously, derives the completed-phase count from Complete-row matching (idempotent), and passes it through `clampPercent` to prevent >100% Progress.

3. **Freshness checks:** `check-phase-fresh.mjs`, `check-phase-lifecycle-fresh.mjs`, `check-phase-lifecycle-policy-fresh.mjs` added. CI adds three corresponding drift-check steps alongside the existing generated-artifact drift checks.

4. **Allowlist:** `phase.cjs ↔ phase.ts` remains `cooperating-sibling` because `phase.cjs` still owns the CJS sync mutation handlers (phaseAdd, phaseInsert, phaseRemove, phaseComplete) that are legitimately I/O-bound and cannot be extracted via `.toString()`. The allowlist justification is updated to reflect the new generator consumption.

**What this is NOT:** The full async mutation handlers (`phaseAdd`, `phaseInsert`, `phaseRemove`, `phaseComplete`) are inherently async I/O-bound and are NOT generated — per Section 4. This amendment only extracts the pure-computation kernel.

**Open drift bugs remaining:** Issue #6 (phasePlanIndex drift) and issue #26 (phase.add inline ROADMAP update drift) are separate bug reports; they are referenced here for traceability but not fixed in this amendment. Future amendments should note when those are resolved.

