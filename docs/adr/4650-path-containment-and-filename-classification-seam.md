# ADR-4650: One path-containment predicate and one filename-classification helper [Proposed]

- **Status:** Proposed — design lock for Phases 1–4 of epic [#4636](https://github.com/open-gsd/gsd-core/issues/4636). Ratify to `Accepted` at Phase 4 closeout, once the phases have demonstrably shipped.
- **Date:** 2026-09-11
- **Issue:** [#4650](https://github.com/open-gsd/gsd-core/issues/4650) — Phase 0 of epic [#4636](https://github.com/open-gsd/gsd-core/issues/4636)

## Context

Three `confirmed-bug` issues were three call sites answering one question that has no shared
implementation: **"is this externally-supplied path allowed to be what it claims to be?"**

| Issue | Predicate hand-rolled at the call site | Direction |
|---|---|---|
| [#4327](https://github.com/open-gsd/gsd-core/issues/4327) | Todo filenames joined into the todos root without containment — `todo complete "../../escaped"` resolves outside it | fails **open** |
| [#4354](https://github.com/open-gsd/gsd-core/issues/4354) | `check predicate --phase-dir` accepts any directory; a **blocking** gate returns `block: false` on a file outside the project | fails **open** |
| [#4580](https://github.com/open-gsd/gsd-core/issues/4580) | `isSecretBasename` compares everything after `.env.` as one token, so `.env.local.example` is refused | fails **closed** |

Repairing these where they were reported — three fixes for three issues — leaves the missing
owner missing, and the next occurrence is already being written somewhere else in the tree.

### What the tree already shows

The missing owner is demonstrable, not theoretical. `src/audit.cts` validates the **identical**
todo filename through `requireSafePath(path.join(rootTodos, 'pending', filename), rootTodos, …)`,
while `cmdTodoComplete` in `src/commands.cts` joins the same value raw. Same question, two call
sites, one validated. When the predicate lives at the call site, its failure direction is an
accident of who wrote it.

### Seven implementations already exist — and they do not agree

| Implementation | File | Symlink-safe? |
|---|---|---|
| `validatePath` / `requireSafePath` | `src/security.cts` | **yes** — `realpathSync`, dangling-symlink discrimination |
| `isWithinRoot` / `isPathContained` | `src/planning-inspect.cts` | split: `isWithinRoot` is pure-string, the `isPathContained` wrapper realpaths |
| `ensureInsideConfig` | `src/installer-migrations.cts` | — |
| `isInsideDir` / `hasSymlinkedAncestor` | `gsd-core/bin/gsd-tools.cjs` | yes, via a separate ancestor check |
| `isWithinRoot` | `scripts/check-glossary-refs.cjs` | — |
| `isPathConfined` / `assertDescriptorConfined` | `src/external-descriptor-trust.cts` | **no — deliberately lexical only** |
| `assertDestWithinConfigHome` | `src/runtime-artifact-install-plan.cts` | the install-time twin of the row above |

The epic says two copies that agree today are the same defect as two that disagree. **These do not
agree.** `validatePath` resolves symlinks; `isPathConfined` explicitly does not, and its own
docstring says so — it is a pure lexical check that "does not detect a symlink along `target` …
that would redirect the LEXICALLY-confined path to a physically different, unconfined location,"
and it is safe today only because *callers reject symlinks upstream* in
`capability-source.cts`'s install adapters.

That is the strongest available evidence for this epic, and it is stronger than the epic itself
claims. The divergence is not hypothetical drift — it already exists, it is load-bearing, and its
safety depends on an invariant maintained in a different module by a different author. Whether
that invariant still holds is exactly the question no one can answer cheaply while the predicate
has seven implementations.

### Two further unconfined sites, not named in the epic

Mapping the seam found two more boundaries that take a path and join it to a managed root with
no containment: `resolvePath` in `src/check-command-router.cts` (accepts absolutes verbatim,
joins relatives unconfined) and the `gap-analysis.plan-post` subcommand in the same file. Their
existence is the argument for the seam rather than three point fixes.

### Why the epic's literal `assertWithinRoot()` is not built from scratch

Epic [#4636](https://github.com/open-gsd/gsd-core/issues/4636) specifies "one `assertWithinRoot()`
containment predicate." A resolver-based, symlink-safe containment predicate already exists as
`validatePath`, and building a new one from scratch would make it the **eighth**, reproducing the
defect this epic exists to close.

`validatePath` also carries behavior acquired as bug fixes, which a re-derivation would risk
losing silently:

- **A closed existence oracle.** A dangling symlink is discriminated from a genuinely absent path
  via `lstat`. Without that, a dangling symlink to a non-existent outside path falls through to
  ancestor resolution and is re-accepted as in-project, while a symlink to an *existing* outside
  path is rejected — a state difference usable as an existence oracle for arbitrary absolute paths.
- **Ancestor canonicalization.** Walking up to the nearest existing ancestor and re-appending the
  remainder, so the comparison holds on a non-canonical root (macOS `/var` vs `/private/var`).
- **A separator-aware boundary test**, so `.planning-evil/` is not accepted as inside `.planning/`.

### But the epic's other clause is correct, and lands on the current export

The epic asks for "a typed rejection rather than a boolean that a caller can forget to check."
That critique is accurate about `validatePath`'s exported shape. It returns
`{ safe, resolved, error }` and populates `resolved` with the **escaping path** on the traversal
branch — empty string for boring rejections, but a usable, caller-controlled value precisely in
the dangerous case. Every call site checks `.safe` today, so this is latent rather than live.

It is not merely a style concern: while the boolean form stays exported, the ratchet in Phase 4
can only assert that *a* helper was called, not that its answer was honored.
`validatePath(x, root).resolved` would pass the rule — the exact bug this epic exists to prevent,
laundered through the approved helper.

## Decision

**Preserve the engine; narrow the export.** The two are separable, and conflating them is what
made this look like a choice between a new predicate and an old one.

1. **`assertWithinRoot` is the one containment predicate**, and it is `validatePath` renamed and
   narrowed — not re-derived. The resolution logic is not touched: Phase 3's diff must show zero
   edits to the symlink-discrimination and ancestor-canonicalization code.
2. **`validatePath` becomes module-internal.** It is no longer exported. `assertWithinRoot`'s
   success value is a branded `ContainedPath` that downstream filesystem calls require, so an
   unvalidated path is not representable further in. This satisfies the epic's vocabulary and its
   "typed rejection" clause without an eighth implementation existing at any point.
3. **Containment is a boundary concern.** The predicate runs where external input enters — argv,
   a parsed document, a filename field — not at whichever interior call site remembered.
4. **The rejection message text is preserved verbatim.** See "Observable contract" below.
5. **One filename-classification helper** owns "final extension" versus "everything after the
   first dot," so an allowlist membership test cannot silently mean the wrong thing. It lives in
   `hooks/lib/` — hand-written and buildless — because its first consumer is a hot-path
   PreToolUse hook and the compiled `security.cjs` is build output that would drag in the
   `ensureRuntimeBuild` seam.
6. **"Delegate" is not an escape hatch.** The epic requires duplicates be *deleted* rather than
   kept in sync. Where a caller genuinely needs different degradation semantics, it may keep a thin
   wrapper — but **that wrapper must route through `assertWithinRoot` for the containment decision
   itself.** A "delegate" that retains its own independent comparison is a duplicate under another
   name and is not permitted by this ADR. Concretely: a wrapper may decide *how to degrade* when
   containment fails; it may not decide *whether the path is contained*.
7. **A ratchet, not a convention.** `local/no-unconfined-path-join` flags `path.join` /
   `path.resolve` whose first argument is a managed root and whose later arguments derive from
   argv, a parsed document, or a filename field, unless the result passes through
   `assertWithinRoot`. Because decision 2 retires the boolean form, the rule asserts the result
   was **narrowed**. Seeded with today's sites and drained to empty, per the
   [ADR-1703](1703-portability-enforcement-architecture.md) precedent.

### Which phase realizes which decision

Stated explicitly so no decision is left to be claimed by whichever phase notices it last. Every
decision above is owned by exactly one phase; this mapping is verified mechanically by
`/adr-phase-coverage` against the sub-issues' acceptance criteria.

| Decision | Realized in |
|---|---|
| 5 — one filename-classification helper, in `hooks/lib/` | Phase 1 ([#4651](https://github.com/open-gsd/gsd-core/issues/4651)) |
| 3 — containment at the boundary; evaluator stays fs-free | Phase 2 ([#4652](https://github.com/open-gsd/gsd-core/issues/4652)) |
| 1, 2, 4, 6 — engine preserved, export narrowed, message text held, delegation constrained | Phase 3 ([#4653](https://github.com/open-gsd/gsd-core/issues/4653)) |
| 7 — the ratchet, drained | Phase 4 ([#4654](https://github.com/open-gsd/gsd-core/issues/4654)) |
| The acceptance policy below, and the `configHome` ruling deferred to Phase 3 | stated here (Phase 0); the ruling itself is Phase 3's |

### The acceptance policy, stated once

The three absorbed issues appear to pull in opposite directions. They do not. The rule is:

> **Conservative about the resource. Exact about the classification.**

- **Resource** — "may I touch this path?" ([#4327](https://github.com/open-gsd/gsd-core/issues/4327),
  [#4354](https://github.com/open-gsd/gsd-core/issues/4354)). Reject on any doubt. Liberal
  acceptance here is liberal *execution*.
- **Classification** — "what kind of file is this?"
  ([#4580](https://github.com/open-gsd/gsd-core/issues/4580)). The secret-read guard was not too
  conservative; it was **wrong** — comparing a whole suffix against a set of *final extensions*
  is a category error. "Be stricter" and "be more lenient" are both the wrong lesson.

A predicate written at the call site has no stated acceptance policy, so its strictness is an
accident of implementation. Naming the policy here is the point of the seam.

Rejections are loud and USAGE-shaped. Containment never silently normalizes a path and proceeds.

### Observable contract — what may not change

The compiled `security.cjs` ships (`files` includes `gsd-core`, and there is no `exports` field),
so a deep `require` is *possible*, but it is undocumented and third-party capabilities interact
through declarative manifests rather than by importing our modules. The realistic dependent
population for the JS shape is our own call sites.

The **error message text is a different matter and is a real contract.** The rejection string
reaches CLI output by a traced path, not by inference: `parseTaskListFromFile`
(`src/quick-batch.cts`) sets `reason` from the `requireSafePath` throw;
`src/quick-batch-command-router.cts` forwards `parsed.reason` verbatim into `makeInvalidArgs(...)`,
which becomes the CLI `error()` output for `quick-batch create --file`.
`tests/quick-batch.test.cjs` asserts on it. Phase 3 must therefore preserve
`Path escapes allowed directory: <resolved> is outside <base>` verbatim; changing the wording is a
user-visible break, not an internal refactor. Six test files reference `validatePath` /
`requireSafePath` and are part of the migration surface.

### Deferred to Phase 3, decided but not yet realized

- **`opts.allowAbsolute`** is a per-call-site liberality knob, and it is pervasive — `src/audit.cts`
  alone passes `true` at 18+ call sites. That is an acceptance-policy decision replicated across
  call sites, which is the thing this ADR says must stop. Phase 3 re-expresses it as a named policy
  on the predicate rather than a bare boolean; the count is recorded here because it makes this a
  materially larger migration than the ~12 boolean-form sites, and Phase 3 must scope for both.
- **`planning-inspect`'s `isWithinRoot`** is deliberately pure-string with no I/O; its callers own
  their own `realpathSync` and it degrades differently by design. Phase 3 decides per call site
  whether it collapses onto `assertWithinRoot` or becomes a thin wrapper — bound by decision 6:
  the containment decision routes through the canonical predicate either way.
- **Non-TypeScript consumers** (`gsd-core/bin/gsd-tools.cjs`, `scripts/check-glossary-refs.cjs`)
  reach the predicate through the compiled module; where that is not viable for a given consumer,
  Phase 3 records why rather than leaving a copy in place.
- **The `configHome` family** — `isPathConfined` / `assertDescriptorConfined`
  (`src/external-descriptor-trust.cts`) and `assertDestWithinConfigHome`
  (`src/runtime-artifact-install-plan.cts`) — confines a *different* root (the user-approved
  `configHome`, not the project root) and is **deliberately lexical**, documented as safe only
  because `capability-source.cts`'s install adapters reject symlinks upstream. Phase 3 must make an
  **explicit ruling** on each: absorb it, or record why the lexical contract must survive and what
  keeps the upstream symlink rejection true. Silently leaving them uncounted is the failure this
  epic exists to close; absorbing them without checking the upstream invariant would be a
  security regression. Neither is a decision Phase 3 may skip. See
  [ADR-2363](2363-capability-instruction-surface-trust.md) for the surrounding trust model.

## Consequences

**What this buys.** One predicate with one stated acceptance policy, applied at boundaries, with
a ratchet that can fail. The failure direction of a containment check stops being an accident of
authorship.

**What it costs.** Phase 3 is a HIGH-blast-radius change: `validatePath` has 38+ transitive
dependents across 13 files and 16 processes, with roughly 12 direct call sites in 7 files plus 6
test files. That migration is mechanical but wide, and it is why Phase 3 runs after adoption
(Phase 2) and before the ratchet (Phase 4).

**What we can never remove.** A branded type at this seam is load-bearing: once downstream
filesystem calls require `ContainedPath`, widening them back is a security regression, not a
refactor.

**Risk accepted.** Narrowing an export is a Hyrum's Law event. We judge the JS shape's external
dependent population to be empty, and we hold the error-text contract fixed. If a real external
consumer of the boolean form surfaces, the answer is a documented shim — not re-widening the
predicate.

## Alternatives considered

- **Build `assertWithinRoot` from scratch, as the epic literally specifies.** Rejected: creates a
  eighth implementation, and risks silently re-deriving a weaker engine that loses the existence
  oracle or the ancestor canonicalization. Preserving the engine and narrowing the export satisfies
  the epic's vocabulary and its "typed rejection" clause together.
- **Adopt `requireSafePath` as-is and stop.** Cheapest, zero migration. Rejected: leaves the
  boolean form exported, so the Phase-4 ratchet degrades to "a helper was called" and
  `validatePath(x, root).resolved` stays greenable.
- **Add containment inside `gate-predicate-evaluator.cts`.** Rejected: it is a declared fs-free
  pure leaf. Boundary placement in the router achieves the same confinement and additionally
  covers `${PHASE_DIR}` interpolation into the `command-exit-zero` predicate kind, which the
  evaluator-local fix would not.
- **Put the filename helper in `src/`.** Rejected: the compiled output is a build artifact, and
  requiring it from a hot-path PreToolUse hook pulls in the runtime-build seam.
- **Fix the three issues at their call sites.** Rejected by the epic's own non-goals. It is the
  pattern that produced them.

## References

- Epic [#4636](https://github.com/open-gsd/gsd-core/issues/4636); absorbed
  [#4327](https://github.com/open-gsd/gsd-core/issues/4327),
  [#4354](https://github.com/open-gsd/gsd-core/issues/4354),
  [#4580](https://github.com/open-gsd/gsd-core/issues/4580)
- [ADR-1703](1703-portability-enforcement-architecture.md) — the precedent this epic follows:
  replace hand-rolled mechanisms with an AST ESLint rule, seeded and drained
