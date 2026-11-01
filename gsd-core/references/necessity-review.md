# Necessity Review

Rubric for category 4 (Necessity) of `gsd-code-reviewer`. Read at `standard` and `deep` depth only, before classifying findings. It asks a question the other three categories do not: **does the problem this code addresses actually occur in this stack?** Correct, clean, well-tested code can still guard against nothing.

Taxonomy adapted from the `functionality-complexity-tradeoff` skill in [l-gevity/l-gevity-skills](https://github.com/l-gevity/l-gevity-skills) (MIT), #4100.

## Taxonomy

| Subtype | Signal | Example |
|---|---|---|
| **Impossible-state guard** | Defends against a state ruled out by the type system, the deployment topology, or a runtime invariant | Null-check on a value whose type is non-nullable end to end; client/server version-skew check in a single-artifact deploy |
| **Already-defended-elsewhere** | A concern fully owned by another layer, duplicated here | Manual HTML escaping on top of an auto-escaping template engine; manual rollback inside an outer transaction that already rolls back |
| **Cargo-culted pattern** | A pattern whose prerequisites do not hold in this context | Connection pool in a CLI that runs for 200 ms; singleton cache in a stateless lambda |
| **Phantom requirement** | Solves a requirement that was never real or has provably lapsed | Feature flag for a launch that completed and is on for every environment; a migration shim for data the repo proves was migrated everywhere |
| **Generality without instantiation** | An abstraction with exactly one instantiation for its whole lifetime | Strategy pattern with one strategy; plugin registry with one plugin; config key holding the same value in every environment |

## Evidence rule

Verify the premise before reviewing the implementation. A necessity finding must state **why the guarded state cannot occur** (or why the requirement lapsed) and cite where that is proven: the type signature, the build/deploy configuration, the call sites, the flag's values. The pattern name alone is not a finding — drop it.

## Severity

- **Warning** (`WR-`) — the impossibility or lapse is provable from the repository.
- **Info** (`IN-`) — it rests on judgment (likely, but not shown).
- **Never Critical.** Removal is a scope decision for a human, not a defect fix.

## Negative space — NOT necessity findings

- **Trust boundary.** A guard on data crossing a trust boundary (user input, network, files, environment, deserialized data, another process) is never an impossible-state guard, even when internal types claim the value is safe — types do not hold across a trust boundary.
- **Defense in depth.** A deliberate second security layer is not "already-defended-elsewhere".
- **Test seams.** A single-implementation interface that exists as a dependency-injection or test seam is not "generality without instantiation".
- **Unreachable code** is category 3 (Code Quality, dead code). Necessity is code that runs, but defends against nothing.
- **Unproven lapse.** A flag or migration whose lapse cannot be shown from the repository is Info at most.

## REVIEW.md format

A necessity finding keeps its normal ID and section (`WR-` under `## Warnings`, `IN-` under `## Info`), names its subtype in the title, and carries the category marker line. The marker is what keeps `gsd-code-fixer` from removing the code under the default fix scope:

```markdown
### WR-04: Impossible-state guard — client version check in single-artifact SPA

**File:** `src/api/client.ts:42`
**Category:** necessity
**Issue:** The guarded state (client/server version skew) cannot occur: both are built and deployed as one artifact (`vite.config.ts:12`, `deploy/Dockerfile:8`).
**Fix:** Remove the check; record the invariant in a comment or ADR rather than a runtime branch.
```

Count every necessity finding in the frontmatter `necessity:` key. It is a subset of `warning` + `info`, never added to `total`.
