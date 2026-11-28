# Why failures are surfaced, not absorbed

> Explanation. This page collects the reasoning behind the ADR-3473 and ADR-3889 hardening
> work: why each defect was a defect, and why each fix has the shape it has. The behavior
> of each change lives in its [feature entry](../FEATURES.md); the rules live in
> [ADR-3473](../adr/3473-enforcement-by-construction.md) and
> [ADR-3889](../adr/3889-process-exit-contract.md).

One rule runs through all of it: a failure or a gap in the input must not be absorbed into
an output that reads as authoritative. A routine that drops data it could not read or could
not resolve, and then reports a clean result anyway, turns a diagnosable gap into a
confidently wrong answer.

## No silent swallow, no verdict from dropped data (#3885)

ADR-3473 §8.5 states the rule directly. Four instances of that collapse were found across
`gsd-tools`.

**`intel query` crashed past ~12000 levels of nesting (#3427).** `searchJsonEntries` /
`matchesInValue` recursed with no depth bound at all — an intel JSON file nested deeply
enough overflowed the call stack with an uncaught `RangeError` instead of a diagnosis. The
original SDK-era bound (`MAX_JSON_SEARCH_DEPTH = 48`, lost in the ADR-0174 consolidation)
is restored, paired with a `truncated` result field: a match at or above the ceiling is
not returned, and the result says so rather than reporting a bare "not found" that is
indistinguishable from a genuine miss. A match at depth 48 (inclusive) or shallower is
unaffected; the bound is on nesting depth, not breadth or total node count, so a shallow
object with many siblings still works unchanged.

**`phase-plan-index` blamed the author for an edge the tool itself dropped (#3427).** A
`depends_on:` token that resolves to no plan in the phase (typo, or a stale cross-phase
reference) silently dropped that edge, making the dependent plan a DAG root — its own
docstring recorded the intent as "ignore this edge, never a throw." The tool then compared
the resulting degraded wave against the plan's declared `wave:` and reported the *author's
correct* declaration as a mismatch. The unresolved token is now named in its own
`warnings[]` entry (plan and token together), and the wave-mismatch warning is suppressed
for that plan only — a plan with no dropped edges and a genuinely wrong `wave:` still warns
as before. The token is escaped (quoted, control characters and embedded newlines
backslash-escaped) before it is embedded in the warning text, so a `depends_on` value
crafted to contain a newline or a quote cannot forge a second, fabricated warning entry.

**A code-review run where every lane failed wrote `REVIEWS.md` from nothing (#3352).**
`review.md`'s aggregation step wrote `REVIEWS.md` regardless of whether any lane actually
produced results — a run where every lane failed still emitted a completed-looking review
artifact, and the per-lane outputs and `.err` files that would have explained the failure
were then destroyed by the run's own cleanup. `REVIEWS.md` is now withheld when the
aggregate has zero lines (every lane failed, not merely skipped under a lower budget), the
run reports the failure instead, and per-lane outputs and non-empty `.err` files are
preserved beside the phase's artifacts before cleanup runs.

**Unreadable directories read as absent ones (#3473 B5).** Four call sites collapsed an
`EACCES`/`EIO` on a phase directory into the same "nothing here" result as a directory that
genuinely does not exist — `countPhasePlansAndSummaries` (`hasContext:false`),
`runGapAnalysis`, and two guarded blocks in `init.cts` (`context_path` absent). Each now
distinguishes "could not read" from "does not exist" and names the discarded path and error
in a dedicated field (`context_read_error` / `phase_dir_read_error`) rather than silently
reading as absent.

**Audited, no defect found.** Every retry-set / swallowed-catch call site this phase's rule
covers that had not already been fixed by a prior PR (`withPlanningLock`,
`acquireStateLock`, `atomicRenameWithRetry`, `renameWithRetry`) was reviewed and found to
already fail loudly on a fatal errno rather than folding it into a retry.

**Why the limits stand.** A match deeper than 48 levels is reported as truncated rather
than as absent, but the value itself is not returned; raising the ceiling is a separate
decision. `phase-plan-index`'s `waves` / `wave` fields remain computed from the degraded
DAG when an edge is dropped — the fix stops the tool from manufacturing a false verdict
about it, but does not invent the missing edge, so a consumer that schedules work from
`wave` (for example `--wave N` filtering) still works from the degraded assignment.
`review.md`'s evidence preservation is bounded by what a lane actually wrote; a lane that
produced no output at all leaves nothing to preserve.

## A typed scope signal for unreadable directories (#4014)

ADR-3473 §8.4 ("failure is a value") applies to filesystem listings, not only command argv.
#3885 (B5) gave `roadmap analyze`, `gap-checker`, and `init`'s JSON bundles a
`context_read_error` / `phase_dir_read_error` string naming an unreadable phase directory —
but the underlying `has_context` / `hasContext` boolean stayed `false` either way, so a
consumer branching on that boolean alone still could not tell "genuinely no context file"
from "could not read the directory at all." The fix is a typed signal that reuses
ADR-3180's existing frozen `SCOPE` enum rather than a new vocabulary.

**`findContextMdIn` reports its own scope.** Called with a directory path, it returns
`{ file, files, scope }` instead of a bare filename-or-null, and never throws — an
unreadable directory reports `scope: 'unreadable'` (previously it threw, forcing every
caller to hand-roll its own `try`/`catch`); a genuinely absent directory (`ENOENT`) reports
`scope: 'complete'`, the same "real empty" answer as before.

**The scope field is additive at five call sites.** None was renamed or removed. This
includes `cmdInitManager`, whose own read failure previously vanished into a bare empty
`catch {}` with no signal of any kind. `getPhaseFileStats` — the shared listing owner
behind `roadmap analyze` and `init`'s `has_context` — no longer lets its own failed read
get masked by an unrelated, already-successful `scanPhasePlans` scope on the same phase
directory.

**Why the limits stand.** `context_read_error` / `phase_dir_read_error`'s message text is
now a fixed "Could not read phase directory `<path>`" rather than embedding the underlying
OS errno text, because `findContextMdIn`'s directory-string form reports only the `SCOPE`
discriminator, not the raw caught error; the field's presence and type are unchanged.
`init.cts`'s three call sites call `findContextMdIn` for the scope signal and then still run
their own, pre-existing `fs.readdirSync` on the same path for the rest of their output — an
intentional, additive-only choice to avoid altering already-complex failure control-flow at
those sites, not a performance optimization.

## Why the raw terminator is banned by construction (#3910)

The "nothing fails with success" defect class ADR-3889 exists to close cannot silently
reopen through a new call site if a bare `process.exit(...)` is a lint error everywhere it
matters.

**The rule is structural.** `local/require-registered-exit` flags any `CallExpression`
shaped exactly like `process.exit(...)`. It does not flag `process.exitCode = N` — that
assignment is the correct drain-then-exit pattern `runMain` itself uses, and the two are
structurally distinct (an assignment target is never a `CallExpression`).

**Why it registers on `src/**/*.cts` and not only the emitted mirrors.** The emitted
`gsd-core/bin/lib/*.cjs` mirrors are globally eslint-ignored (ADR-457). A rule registered
only on the emitted surface is blind to the real sources, the same way
`n/no-process-exit` went invisible (#3496). Registering on the sources is load-bearing.

**Why the `hooks/**` carve-out was deleted.** The dead `n/no-process-exit: 'off'`
carve-out protected nothing once Phase 7 (#3911) migrated every enforcement hook onto
`terminateNow`.

**Why there are exactly two allowlist entries.**

1. The body of `terminateNow` in `src/cli-exit.cts` — detected structurally (any
   `process.exit()` lexically nested inside a function named `terminateNow`, and the file's
   basename is `cli-exit.cts`), not by path+line, so it does not rot when the function
   moves.
2. `gsd-core/bin/gsd-tools.cjs`'s `ensureRuntimeBuild` bootstrap-failure path, via an inline
   `// eslint-disable-next-line local/require-registered-exit` with a stated reason — it
   runs before `./lib/cli-exit.cjs` is even required, so the registered-exit seam does not
   exist yet at that point in the process's lifetime.

**Why `io.cts`'s `error()` throws instead of calling `terminateNow`.** The last raw
terminators in `src/**/*.cts` were migrated onto the seam. `src/io.cts`'s `error()` changed
from an uncatchable `process.exit(1)` to a catchable `throw new ExitError(1)` (stderr output
is byte-identical; `runMain` projects the exit code). `terminateNow` could not serve this
site — ADR-3889 §1 makes exit codes 0 and 1 unallocatable, so `nameForExitCode(1)` throws.
That control-flow change required three interceptor fixes so an `ExitError` reaches
`runMain`: `command-routing-hub`'s `dispatch()` now rethrows it, and the profile-pipeline
router's detached `.catch()` no longer calls `error()` — it writes stderr and sets
`exitCode` in place.

**Known limits (documented and test-pinned, not endorsed).** The rule matches the literal
`process.exit(...)` shape only, with no scope/flow analysis. It does not catch
`process['exit'](0)` (computed member access), `const e = process.exit; e(1)` (aliasing to a
local binding before calling), or `process.exit.call(...)`/`.apply(...)` (indirect
invocation). Catching these needs binding/scope-aware analysis, out of scope for the issue;
pinning tests in `tests/eslint-rules.test.cjs` assert today's non-detection so a future
widening is a visible choice, not a silent one.

## Why two lint rules had to reach their whole surface (#3951)

**`local/no-adhoc-markdown-parsing` self-gated on its own filename.** The rule
short-circuited unless a file's path matched a flat `src/*.cts` pattern. Two consequences: 28
`.cts` files in `src/` subdirectories sat inside the `src/**/*.cts` glob it was registered
on and were silently skipped, and the rule could not be extended by configuration at all —
widening the glob alone left it inert. Both halves now move together, and a test pins that
the gate and the registration agree in both directions. The `src/` subdirectory hole was
latent — zero violations existed there when it was fixed. It is closed because "no
violations today" is not a property that keeps holding, not because it was hiding anything.

**Covering `tests/**` and `scripts/**` surfaced 80 hand-rolled markdown parses across 43 test
files.** Seventy are routed through the existing `markdown-sectionizer` and `markdown-table`
seams; ten are suppressed with a stated reason (six of those are a shell-pipe detector whose
regex merely resembles a table). The suppressions are suppressions, not fixes: each names why
the raw markdown text is the subject of that assertion.

**`local/no-adhoc-regex-escape` could not see property access.** Its unsafe-`new RegExp` arm
examined only bare identifiers, so `new RegExp(obj['key'])` — the shape runtime data actually
arrives in — was invisible. That is why it never fired on a known ReDoS. It now inspects
`MemberExpression`, with an exemption keyed strictly on the property being `source` (18 safe
sites), plus provenance exemptions for `_SOURCE` constants reached through a required module
(3 sites).

**A body-only quick-task append re-derived progress.** The `quick-tasks-append` route was the
only body-only STATE.md writer not passing `{ resync: false }`, so appending one row triggered
a full re-derive of the disk-derived `progress.*` frontmatter and replaced curated values.
Reproduced: a project with two real phase directories and a curated `total_phases: 25`
collapsed to `2` on append. The same change gave `quick-tasks-append` optional `--quick-id`,
`--slug` and `--directory` so a caller with a real quick task can emit the canonical row;
omitting them leaves the row byte-identical to before (as `fast.md` does, having neither an id
nor a directory).

**Found by the widening.** `tests/config-field-docs.test.cjs` asserted that
`workflow.subagent_timeout`'s documented default is not `600` — but read the **Type** column
instead of **Default**, so it compared `'number'` against `'600'` and could never fail. The
guard against regressing to the old seconds-based default had been inert. It is now
row-scoped and real.

**Known limits.** #3426 and #3239 are not closed by this. Their hand-rolled scans in
`tests/package-legitimacy-gate.test.cjs` are built from line filters and `split('|')`, not
the regex-literal fingerprints this rule detects — measured at zero violations even with the
gate bypassed. They need new detectors, which is a separate design.

## Why the runtime marker, the derived Codex sandbox, and short-form dependencies (#3897)

ADR-3473 §8.3 states the rule directly — one implementation per invariant, not a
hand-maintained copy that quietly drifts from the rule it stands in for. Three instances
across `gsd-tools`: a resolver that never read the install-time signal it was documented to
read, a Codex sandbox map that was fully redundant with the tool contract it stood in for,
and a dependency-resolution tier lost when the SDK lineage was retired.

**A non-Claude install resolved `claude` with no config.** `resolveRuntime`'s ladder was
`GSD_RUNTIME` env var → project `config.runtime` → `'claude'` — the per-install
`.gsd-runtime` marker the installer has written beside `VERSION` since #2297 was read by four
separate hand-rolled copies (`model-resolver.cts`, and two more inside
`gsd-cursor-subagent-start.js`), but never by `resolveRuntime` itself. A Codex, Cursor, or
other non-Claude install with no `GSD_RUNTIME` set and no `runtime` key in
`.planning/config.json` therefore still resolved `claude` everywhere `resolveRuntime` is
consulted (slash-command style, `query teams-status`, `validate agents`'s agent-directory
selection, and 19 other call sites). The marker is now the third rung — `GSD_RUNTIME` →
`config.runtime` → install marker → `'claude'`. The marker's contents are never trusted
verbatim: they are routed through the same name-normalization the env rung already uses, so
a marker holding an unexpected or hostile value degrades exactly like an unexpected
`GSD_RUNTIME` value would.

**Why Codex `sandbox_mode` is derived and then held.** `generateCodexAgentToml` looked up
`sandbox_mode` in an 11-entry `CODEX_AGENT_SANDBOX` map, falling back to `read-only` —
silently — for every role the map didn't name. Measured against all 35 shipped roles, the
map's 11 entries agree with deriving `sandbox_mode` from each role's declared `tools:`
frontmatter (`workspace-write` when it declares `Write` or `Edit`, `read-only` otherwise)
with zero disagreements, so the map is deleted rather than clamped. The fallback, however,
was under-granting: 16 of the 24 roles that hit it declare `Write`/`Edit` and would derive
`workspace-write`. Pending a decision on whether Codex actually enforces `sandbox_mode` (a
question the derivation can't answer on its own), those roles are held at `read-only` by an
explicit, self-invalidating hold list — a hold whose role no longer derives broader, or that
names a role that no longer exists, fails loudly instead of being silently honored. Every one
of the 35 emitted `.toml` files is byte-identical to before the change — the fix is in
provenance (an explicit, reviewable rule instead of a silent default), not in any installed
agent's actual permissions. Widening the held roles is a follow-up once Codex's actual
enforcement of `sandbox_mode` is confirmed; until then a hold is reversible and a widened
sandbox is not.

**Why `depends_on` accepts the bare plan number.** A plan's frontmatter could already
reference a dependency by its full id (`"03-01-auth-hardening"`) or its canonical phase-plan
prefix (`"03-01"`). A third form — the bare plan number alone (`"01"`) — existed in the
retired SDK lineage but was lost when that lineage was consolidated; a plan written with it
silently dropped the edge entirely, collapsing into wave 1 regardless of its declared
dependency. That form is restored, scoped to the same phase only. This is an observable
behavior change — a phase whose plans used the bare form and had silently collapsed into a
single wave now executes in its actual declared waves. Two plans in the same phase sharing a
bare form resolve first-write-wins, by sorted plan-file order — deterministic, but arbitrary
where the collision happens, matching the retired behavior exactly, and not a conflict
warning.

**Known limits.** The install marker never feeds model-tier resolution
(`model_profile_overrides`, `model_policy.runtime_tiers`) — that still reads `config.runtime`
alone, and reporting-only host detection (`agent_runtime`) is a separate, pre-existing ladder
this change does not touch.
