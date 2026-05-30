# Investigation: SDK Removal Cleanliness

## Summary
The SDK removal is clean at the npm package/release metadata layer and partly validated at the CJS runtime dispatch layer, but it is **not clean as a repository-wide removal**. The remaining risk is less about accidentally publishing `@opengsd/gsd-sdk` and more about stale installer code, broken/stale local hooks, generated-source metadata, active documentation, and tests that continue to encode the retired SDK model.

## Symptoms
- The repository appears to have had an SDK removed.
- Need to determine whether the removal is clean, complete, documented, and tested.
- Current worktree is clean on branch `fix/phase-complete-atomic-audit`.

## Background / Prior Research

### Git archaeology - SDK removal wave
An explore agent inspected git history and reported that the SDK was intentionally retired in a May 25-29, 2026 cleanup wave.

Key commits surfaced:
- `11918dcc` (May 25, 2026), `chore(#191): retire sdk package seam`: primary removal commit. Deleted `bin/gsd-sdk.js`, deleted nearly all `sdk/**`, moved shared manifests from `sdk/shared/*` to `get-shit-done/bin/shared/*`, removed `gsd-sdk` bin/package-file entries, and removed SDK build/pretest/prepublish hooks from root package metadata.
- `36a23757` (May 25, 2026), `chore(#192): retire sdk release pipeline seam`: removed SDK release workflow/script assumptions including `.github/workflows/release-sdk.yml` and `scripts/verify-tarball-sdk-dist.sh`.
- `a77883e1` (May 25, 2026), `fix(#192): retire sdk assumptions in lint and regression tests`: follow-up cleanup for lint/test assumptions.
- `87ef25b1` (May 25, 2026), `docs(#193): align CONTEXT module glossary with sdk retirement`.
- `e8fc5003` (May 25, 2026), `docs(#194): remove sdk programmatic docs and bridge guidance`.
- `0e690705` (May 25, 2026), `docs(#195): migrate workflow markdown off gsd-sdk query`.
- `b64ffc12` (May 25, 2026), `docs(#196): remove sdk references from localized docs`.
- `7a3822fc` (May 26, 2026), `fix: replace removed gsd-sdk prompt references (#355)`: evidence that initial removal left agent/command prompt references.
- `47bba87d` (May 26, 2026), `fix: restore sdk query families in gsd-tools (#353)`: evidence of behavioral fallout; added CJS query-family router replacements and `tests/sdk-removal-query-family-dispatch.test.cjs`.
- `1f5fea6d` (May 29, 2026), `fix(#191): remove retired sdk tsconfig reference`: removed lingering root `tsconfig.json` reference to `sdk` and added a test guard.

Current-state clues from the explore agent:
- No current `sdk/` directory exists in HEAD.
- Package metadata reportedly exposes only `get-shit-done-redux` and `gsd-tools`, excludes `sdk`, and no longer runs SDK build hooks.
- Regression guards reportedly exist in `tests/bugs-1656-1657.test.cjs` and `tests/sdk-removal-query-family-dispatch.test.cjs`.
- Stale-reference candidates remain in `AGENTS.md`, `.githooks/pre-commit`, `CONTRIBUTING.md`, and `CONTEXT.md`.

Preliminary conclusion: runtime/package removal appears mostly complete, but the cleanup wave was incremental and may still have stale documentation/process references.

## Investigator Findings
<!-- Pair investigator will append structured findings here with file:line refs and evidence. -->

### 2026-05-30 follow-up investigation: SDK retirement cleanup state

#### Method / verification performed
- Searched current HEAD for `gsd-sdk`, `@opengsd/gsd-sdk`, `sdk/`, `sdk/src`, `build:sdk`, `release-sdk`, `verify-tarball-sdk-dist`, and `bin/gsd-sdk.js` across active package, runtime, workflow, docs, hooks, scripts, tests, changesets, and historical docs.
- Fan-out probes separately checked reference classification, active package/workflow surfaces, hooks/scripts/tests, and CJS query-family behavior; load-bearing claims below were spot-checked in this session.
- Ran narrow regression checks:
  - `node --test tests/enh-191-retire-sdk-package.test.cjs` — passed 3/3.
  - `node --test tests/sdk-removal-query-family-dispatch.test.cjs` — passed 5/5.

#### Hypothesis 1: runtime/package cleanup is complete
**Partly proved for package/release surfaces, disproved for active installer/runtime cleanup.**

Evidence that package/release/build surfaces are clean:
- `package.json:5-8` exposes only `get-shit-done-redux` and `gsd-tools`; no `gsd-sdk` bin remains.
- `package.json:9-17` publishes `bin`, `commands`, `get-shit-done`, `agents`, `hooks`, and `scripts`; no `sdk` package/files entry remains.
- `package.json:65-99` has no `build:sdk`, SDK pretest, SDK prepublish, or SDK release script; `prepublishOnly` now runs only `npm run build:hooks` at `package.json:67`.
- `package-lock.json:15-18` mirrors only `get-shit-done-redux` and `gsd-tools` bins and has no `@opengsd/gsd-sdk`/`gsd-sdk` package entry.
- `tsconfig.json:1-4` has empty `files` and empty `references`, so the former `sdk` project reference is gone.
- Path search found no current `sdk/` directory, no `bin/gsd-sdk.js`, no `.github/workflows/release-sdk.yml`, and no `scripts/verify-tarball-sdk-dist.sh` path.
- `.github/workflows/release.yml:68-69`, `release.yml:229`, and `release.yml:383` publish/verify only `@opengsd/get-shit-done-redux`; `.github/workflows/install-smoke.yml:121-153` packs and installs the root tarball and checks the main installer path.
- `tests/enh-191-retire-sdk-package.test.cjs:16-35` guards physical `sdk/`/`bin/gsd-sdk.js` removal plus package `bin`/`files` cleanup; the test currently passes.

Evidence that active installer/runtime cleanup is **not** complete:
- `bin/install.js:8259-8276` still runs a global-install check for stale standalone `@opengsd/gsd-sdk` during global installs.
- `bin/install.js:10676-10929` still contains `classifySdkInstall`, `buildSdkFailFastReport`, `renderSdkFailFastReport`, and `installSdkIfNeeded` logic for `sdk/dist/cli.js`, `bin/gsd-sdk.js`, `--sdk`, `--no-sdk`, and PATH materialization assumptions.
- `bin/install.js:10902` still resolves `path.resolve(__dirname, 'gsd-sdk.js')` even though `bin/gsd-sdk.js` is deleted.
- `bin/install.js:10985-10986` still warns that workflows calling `gsd-sdk query ...` will fail; this is stale after CJS/`gsd-tools query` restoration.
- `bin/install.js:11711-11718` still exports `installSdkIfNeeded` and SDK-shadow helper functions, making the retired seam available to tests/importers even though the main install path does not invoke it.
- `get-shit-done/bin/lib/state-command-router.cjs:33-35` still emits an active user-facing unsupported message: `state add-roadmap-evolution is SDK-only. Use: gsd-sdk query ...`.

Conclusion: package/release declarations are clean, but active runtime code still carries retired SDK compatibility machinery and stale messages. Recommended fix location: `bin/install.js` first, then `get-shit-done/bin/lib/state-command-router.cjs`.

#### Hypothesis 2: SDK query-family behavior was restored in CJS
**Mostly proved for the restored families under test; coverage is partial.**

Evidence of restored CJS query path:
- `get-shit-done/bin/gsd-tools.cjs:335-339` accepts `query` as a meta-prefix, so `gsd-tools query <command>` routes into the CJS dispatcher.
- `get-shit-done/bin/gsd-tools.cjs:344-355` normalizes dotted commands such as `check.decision-coverage-plan` into family/subcommand form.
- `get-shit-done/bin/gsd-tools.cjs:200-239` documents bridge collapse and `_dispatchNonFamily()` always returns `false`, forcing CJS fallback instead of SDK dispatch.
- `get-shit-done/bin/lib/agent-command-router.cjs:27-59` implements `agent.classify-failure`; guarded by `tests/sdk-removal-query-family-dispatch.test.cjs:22-29`.
- `get-shit-done/bin/lib/task-command-router.cjs:48-78` implements `task.is-behavior-adding`; guarded by `tests/sdk-removal-query-family-dispatch.test.cjs:31-46`.
- `get-shit-done/bin/lib/check-command-router.cjs:318-326` implements `check.auto-mode`, `check.decision-coverage-plan`, and `check.decision-coverage-verify`; guarded by `tests/sdk-removal-query-family-dispatch.test.cjs:48-100`.
- The query-family regression test passed all five cases during this investigation.

Caveats / uncovered edges:
- `tests/sdk-removal-query-family-dispatch.test.cjs` covers only `agent`, `task`, and `check`; it does not exercise manifest-backed families such as `state`, `verify`, `init`, `phase`, `phases`, `validate`, or `roadmap`.
- Stale SDK-era comments remain in family routers, e.g. `get-shit-done/bin/lib/state-command-router.cjs:9-16` says handlers dispatch via `executeForCjs` when SDK is available, which contradicts bridge collapse.
- `get-shit-done/bin/lib/phase-command-router.cjs:150-157` derives available subcommands from `PHASE_SUBCOMMANDS`; the router implements handlers at `phase-command-router.cjs:64-139`, but no handler for `uat-passed` appears in the router body. If `uat-passed` remains in `PHASE_SUBCOMMANDS`, it may be advertised/accepted by manifest validation but fail at handler lookup.
- `get-shit-done/bin/lib/phases-command-router.cjs:8-19` intentionally excludes `archive` despite manifest listing, which may be valid but deserves an explicit regression if workflows depend on the unknown-command behavior.

Conclusion: the specific SDK-removal fallout captured by the new test is fixed in CJS, but important family/router invariants are not comprehensively guarded. Recommended fix locations: add targeted behavioral tests for state/verify/init/phase/phases/validate/roadmap query dispatch, and check `phase.uat-passed` routing.

#### Hypothesis 3: docs/process cleanup is incomplete
**Proved. Active user/contributor docs, process docs, hooks, scripts, generated metadata, and runtime messages still contain stale SDK guidance.**

High-priority active docs/process stale references:
- `README.md:8-9` still lists npm SDK package `@opengsd/gsd-sdk` as an active package name.
- `README.md:244` describes CLI Tools as ``gsd-sdk query` and programmatic SDK dispatch seams`, while `docs/CLI-TOOLS.md` itself no longer contains `gsd-sdk` references.
- `AGENTS.md:11` says the repository ships a Node.js CLI and SDK and says the TypeScript SDK is isolated under `sdk/` with tests in `sdk/src/`.
- `AGENTS.md:18-23` says `npm test` builds the SDK first and instructs `npm run build:sdk`, `cd sdk && npm test`, and `cd sdk && npm run build`.
- `docs/contributing/bootstrap.md:68` lists `npm run build:sdk`; `docs/contributing/bootstrap.md:184-186` tells contributors to run `npm run build:sdk` after `npm ci`.
- `CONTRIBUTING.md:182` still documents a `CJS↔SDK seam` for `bin/lib/*.cjs` and `sdk/src/**`.
- `CONTRIBUTING.md:208` says changeset lint watches `sdk/src/`; `CONTRIBUTING.md:720-727` shows a pre-commit sample matching `sdk/src/query/...` and `sdk/scripts/...` paths.
- `docs/USER-GUIDE.md:1070-1075` still recommends `gsd-sdk query`, links to `../sdk/src/query/QUERY-HANDLERS.md`, and describes SDK-vs-CJS state behavior.
- `docs/CONFIGURATION.md:783` says authoritative model profile data comes from `sdk/shared/model-catalog.json` and `sdk/src/model-catalog.ts`.
- `SECURITY.md:136-140` says `sdk/` is a separate non-workspace package and out of scope for root `npm ls`.
- `VERSIONING.md:84-96` says hotfix finalization bumps `sdk/package.json`, builds/bundles `sdk-bundle/gsd-sdk.tgz`, and offers `release-sdk.yml` as an active stopgap.
- `CONTEXT.md:196`, `CONTEXT.md:324`, and `CONTEXT.md:647-651` retain active rule/predicate/fix guidance involving `gsd-sdk`, `sdk/src`, `sdk/dist`, and `npm run build:sdk`.
- `get-shit-done/workflows/reapply-patches.md:278` says the verifier is also exposed via `sdk/dist/cli.js verify-reapply` when present.
- `agents/gsd-executor.md:660` points to `sdk/src/query/QUERY-HANDLERS.md` while giving current `gsd-tools query` state-update guidance.

Historical/acceptable references:
- `.changeset/191-retire-sdk-package-seam.md:5`, `.changeset/192-retire-sdk-release-pipeline.md:5`, `CHANGELOG.md` release-history rows, and `docs/adr/0174-retire-gsd-sdk-package-boundary.md:104-146` are historical/ADR context and do not by themselves indicate active behavior.

Conclusion: docs/process cleanup is the largest remaining gap. Recommended fix locations: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/contributing/bootstrap.md`, `docs/USER-GUIDE.md`, `docs/CONFIGURATION.md`, `SECURITY.md`, `VERSIONING.md`, `CONTEXT.md`, `get-shit-done/workflows/reapply-patches.md`, and `agents/gsd-executor.md`.

#### Hypothesis 4: regression tests guard important invariants but miss docs/process stale references or preserve stale behavior
**Proved. Tests guard some key invariants, but gaps remain and some tests/process checks preserve stale SDK concepts.**

Positive guards:
- `tests/enh-191-retire-sdk-package.test.cjs:16-35` guards deleted `sdk/`, deleted `bin/gsd-sdk.js`, and package `bin`/`files` cleanup; it passed in this investigation.
- `tests/bugs-1656-1657.test.cjs:57-109` independently guards no legacy SDK prompt, no `--sdk`/`--no-sdk` arg parsing by exact string, no `installSdkIfNeeded({` invocation, no `sdk` package files, and no stale tsconfig project reference.
- `tests/sdk-removal-query-family-dispatch.test.cjs:22-100` guards the restored CJS query behavior for `agent`, `task`, and `check`; it passed in this investigation.

Gaps / stale-preserving tests:
- `tests/enh-191-retire-sdk-package.test.cjs:38-46` passed even though `bin/install.js:10676-10929` still contains extensive `--sdk`, `--no-sdk`, `sdk/dist`, and `gsd-sdk` comments/helpers. The test checks no active `installSdkIfNeeded({` invocation, but its flag regex is not an effective stale-text guard for hyphen-prefixed options in comments.
- `tests/bug-2399-commit-docs-plan-phase.test.cjs:69-75` still names `gsd-sdk query commit` as the desired behavior and accepts broad `gsd-tools`/`gsd-sdk` substrings rather than a precise current command contract.
- `tests/bug-2492-context-coverage-gate.test.cjs:38-39` and `tests/bug-2492-context-coverage-gate.test.cjs:130-132` failure messages still require `gsd-sdk query` wording.
- `tests/graphify-auto-update.test.cjs:572-578` explicitly preserves `gsd-sdk query commit` and `npx gsd-sdk query commit` as hook-matching cases.
- `tests/docs-parity-live-registry.test.cjs:129-134` still allowlists `@opengsd/gsd-sdk` / `gsd-sdk query` as expected docs tokens.

Hook/script regression gaps:
- `.githooks/pre-commit:13-46` invokes `npm run check:state-document-fresh`, `check:configuration-fresh`, `check:workstream-inventory-builder-fresh`, `check:project-root-fresh`, `check:plan-scan-fresh`, `check:secrets-fresh`, `check:schema-detect-fresh`, `check:decisions-fresh`, and `check:workstream-name-policy-fresh`; none of these scripts exist in `package.json:64-99`. A staged change matching those generated-CJS patterns would trigger a broken missing-script path.
- `.githooks/pre-commit:9-45` still watches deleted `sdk/src/**`, `sdk/shared/**`, and `sdk/scripts/**` paths.
- `scripts/changeset/lint.cjs:26-34` still treats `sdk/src/` and `sdk/prompts/` as user-facing prefixes.
- `scripts/diff-touches-shipped-paths.cjs:3`, `diff-touches-shipped-paths.cjs:15-18`, and `diff-touches-shipped-paths.cjs:67-72` still describe/use `release-sdk` and `sdk/src/**` tests as hotfix-shipping relevance.
- `scripts/lint-shared-module-handsync.cjs` is partially retirement-aware, but its header/guidance still points contributors toward `sdk/src` and `sdk/scripts` patterns; `scripts/shared-module-handsync-allowlist.json` is almost entirely retired `sdk/src` pair metadata.

Conclusion: keep the existing package/query regression tests, but add process-doc stale-reference tests or lint rules if the project wants this cleanup to stay complete. Recommended test/script fix locations: `.githooks/pre-commit`, `tests/precommit-alias-drift-hook.test.cjs`, `tests/enh-191-retire-sdk-package.test.cjs`, `tests/bug-2399-commit-docs-plan-phase.test.cjs`, `tests/bug-2492-context-coverage-gate.test.cjs`, `tests/docs-parity-live-registry.test.cjs`, `scripts/changeset/lint.cjs`, `scripts/diff-touches-shipped-paths.cjs`, `scripts/lint-test-file-count.cjs`, `scripts/lint-shared-module-handsync.cjs`, and `scripts/shared-module-handsync-allowlist.json`.

#### Overall conclusion / recommended cleanup sequence
1. **Runtime cleanup:** remove dead SDK readiness/shim/PATH functions and stale global `@opengsd/gsd-sdk` detector from `bin/install.js`; update `state add-roadmap-evolution` messaging in `get-shit-done/bin/lib/state-command-router.cjs`.
2. **Broken process cleanup:** fix `.githooks/pre-commit` before it triggers nonexistent npm scripts; then update scripts that still classify retired `sdk/src` paths as active.
3. **User/contributor docs cleanup:** update the active docs listed above to describe the current CJS/`gsd-tools query` world and remove `sdk/` build/test instructions.
4. **Regression hardening:** broaden SDK-retirement guards from package layout to active docs/process/runtime messages, and add CJS behavioral tests for currently uncovered query families and the `phase.uat-passed` edge.
5. **Historical preservation:** leave ADRs, changelog entries, release notes, and changeset fragments intact unless a separate documentation-history cleanup is desired.


## Investigation Log

### Phase 1 - Initial Assessment
**Hypothesis:** The SDK was removed in committed branch history, and cleanup quality must be assessed against remaining references, docs, tests, package metadata, release notes, and generated/build artifacts.
**Findings:** Initial git status showed a clean worktree on `fix/phase-complete-atomic-audit`; `docs/investigations/` did not previously exist.
**Evidence:** `git status` via RepoPrompt reported no changes. Repo file tree showed no existing `docs/investigations/` directory.
**Conclusion:** Proceeding with git archaeology, workspace context discovery, and delegated pair investigation.

### Phase 2 - Context Builder Initial Assessment
**Hypothesis:** Broad workspace discovery can identify whether cleanup gaps are runtime-critical, docs/process-only, or test/guard-related.
**Findings:** Context Builder selected package metadata, workflows, installer slices, runtime dispatch files, tests, docs, hooks, scripts, and ADR context. Its initial assessment was that npm package and primary runtime cleanup are mostly complete, but installer compatibility code, `.githooks/pre-commit`, generated-source provenance, stale docs, and tests/scripts preserving SDK assumptions remain risk areas.
**Evidence:** Selected context included `package.json`, `package-lock.json`, `tsconfig.json`, `.github/workflows/*`, `bin/install.js` slices, `get-shit-done/bin/gsd-tools.cjs`, command routers, SDK-removal regression tests, `.githooks/pre-commit`, `AGENTS.md`, `CONTRIBUTING.md`, `CONTEXT.md`, and active docs/reference slices.
**Conclusion:** Confirm with pair investigation, then refocus file selection and ask Oracle to synthesize final confidence and recommended fixes.

### Phase 4 - Oracle Synthesis and Evidence Spot Check
**Hypothesis:** The final answer should distinguish package/runtime shipping risk from docs/process/test hygiene risk.
**Findings:** Oracle synthesis matched the pair investigation: publishing/release metadata is clean; tested CJS query dispatch is viable; repository-wide cleanup is incomplete because active installer/runtime messages, hooks, process scripts, generated metadata, tests, and docs still carry SDK-era assumptions. Load-bearing claims were spot-checked in `package.json`, `.githooks/pre-commit`, `bin/install.js`, `get-shit-done/bin/lib/state-command-router.cjs`, and `AGENTS.md`.
**Evidence:** `package.json:5-17` exposes no `gsd-sdk` bin/files; `package.json:65-99` has no `build:sdk`; `.githooks/pre-commit:9-46` still watches `sdk/src`, `sdk/shared`, and `sdk/scripts` paths and invokes missing `check:*` scripts; `bin/install.js:10676-10717` still documents SDK dist/shim install assumptions; `get-shit-done/bin/lib/state-command-router.cjs:33-35` still emits `SDK-only` / `gsd-sdk query` guidance; `AGENTS.md:11-23` still describes the repo as CLI+SDK and instructs SDK build/test commands.
**Conclusion:** Final report can confidently say the removal was partially successful but not finished to the standard implied by ADR-0174.

## Root Cause
The root cause is a scope mismatch during the SDK retirement wave.

The removal successfully handled the obvious package boundary first: it deleted `sdk/`, removed `gsd-sdk` package/bin exposure, removed SDK build/publish hooks, removed the root `tsconfig` SDK reference, and restored representative query-family behavior in CJS. However, the cleanup did not fully chase every active consumer of the SDK concept.

That left three different states coexisting:

1. **New intended state:** root package and release metadata now center on `@opengsd/get-shit-done-redux` and `gsd-tools`.
2. **Patched runtime state:** selected SDK-era query behavior has CJS replacements and regression coverage.
3. **Stale mental-model state:** installer helpers, runtime messages, hooks, process scripts, generated metadata, docs, and some tests still assume `gsd-sdk`, `sdk/src`, `sdk/dist`, or CJS↔SDK parity are active architecture.

Eliminated or weakened hypotheses:
- The SDK is still obviously being published as a separate npm package: **eliminated** by `package.json`, `package-lock.json`, release workflow evidence, and passing package-removal tests.
- The root package still exposes a `gsd-sdk` binary: **eliminated** by `package.json:5-8` and `package-lock.json` root bin metadata.
- The root TypeScript config still references `sdk`: **eliminated** by `tsconfig.json:1-4`.
- SDK query-family behavior was simply lost: **too broad**; tested CJS replacements for `agent`, `task`, and `check` pass.
- There is no regression coverage: **false**; coverage exists, but it is incomplete and some tests preserve stale SDK behavior.

The opposite overclaim is also eliminated: SDK removal is **not** clean and complete repository-wide.

## Recommendations
1. **P0 — Resolve live runtime/install inconsistencies.**
   - In `bin/install.js`, decide whether retained SDK helpers are truly compatibility-only diagnostics or dead code. Remove dead SDK readiness/shim/PATH logic, or clearly quarantine it as stale-standalone detection.
   - Update installer wording that still references `sdk/dist`, `bin/gsd-sdk.js`, `--sdk`, `--no-sdk`, or `gsd-sdk query` as active expectations.
   - Fix `get-shit-done/bin/lib/state-command-router.cjs` so `state add-roadmap-evolution` no longer tells users to use `gsd-sdk query`. Either implement the CJS path, remove it from active aliases, or emit current single-runtime guidance.

2. **P0/P1 — Repair local process hooks before they break contributors.**
   - Update `.githooks/pre-commit` to remove deleted `sdk/src`, `sdk/shared`, and `sdk/scripts` triggers.
   - Remove or replace hook invocations of `check:*` npm scripts that do not exist in `package.json`.
   - Update `tests/precommit-alias-drift-hook.test.cjs` so it no longer locks in deleted SDK-path behavior.

3. **P1 — Clean stale process/generation scripts.**
   - Review and update `scripts/changeset/lint.cjs`, `scripts/diff-touches-shipped-paths.cjs`, `scripts/lint-test-file-count.cjs`, `scripts/lint-shared-module-handsync.cjs`, and `scripts/shared-module-handsync-allowlist.json`.
   - Update `get-shit-done/bin/lib/command-aliases.cjs` provenance/banner if it no longer has an SDK manifest source of truth.

4. **P1/P2 — Update active docs and prompts.**
   - Replace active `gsd-sdk query` / `sdk/` guidance with `gsd-tools query` or current runtime-launcher guidance.
   - Prioritize `README.md`, root `AGENTS.md`, `CONTRIBUTING.md`, `docs/contributing/bootstrap.md`, `docs/USER-GUIDE.md`, `docs/COMMANDS.md`, `docs/CONFIGURATION.md`, `docs/AGENTS.md`, `SECURITY.md`, `VERSIONING.md`, `CONTEXT.md`, `get-shit-done/references/*.md`, `get-shit-done/workflows/reapply-patches.md`, and `agents/gsd-executor.md`.
   - Leave ADRs, changelog entries, release notes, and changesets intact unless separately doing history cleanup.

5. **P2 — Harden regression coverage.**
   - Keep package-removal tests and CJS query-family tests.
   - Add targeted behavioral tests for uncovered query families: `state`, `verify`, `init`, `phase`, `phases`, `validate`, and `roadmap`.
   - Check the flagged `phase.uat-passed` route explicitly.
   - Update tests that currently accept or require `gsd-sdk query` wording so they assert the current command contract.
   - Prefer structured doc/process lint rules over broad source-grep tests, except where exact shipped text is the product contract.

## Preventive Measures
- Treat package-boundary removals as multi-surface migrations: package metadata, install path, runtime messages, generated artifacts, hooks, scripts, docs, prompts, tests, and localized/reference docs.
- Add a structured retired-surface checklist to future ADR implementation plans.
- Add a docs/process lint rule that classifies SDK references as historical vs active; fail only active guidance that reintroduces retired commands or paths.
- Keep regression tests aligned with the new contract rather than allowing either old or new command names.
- Require removal PRs to include a search-classification appendix: historical references kept, compatibility references kept, active references updated, and active references intentionally removed.
