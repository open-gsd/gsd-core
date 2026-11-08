# ADR-4909: Shipped workflow bodies are a compiled artifact — two generated manifests and one extractor

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-11-08 |
| **Issue** | [#4909](https://github.com/open-gsd/gsd-core/issues/4909) (epic); this ADR is Phase 0, [#6050](https://github.com/open-gsd/gsd-core/issues/6050) |
| **Supersedes** | — |
| **Amends** | [ADR-0002](0002-command-contract-validation-module.md) — its per-file `@`-ref rule and its reachability rule move into the extractor defined here |
| **Constrained by** | [ADR-3473](3473-enforcement-by-construction.md) (failure is a value; `NamedArgSpec`), [ADR-2719](2719-emitted-artifact-attribution.md) (emitted-artifact attribution), [ADR-456](456-test-rigor-architecture.md) (exemptions cite an issue) |

> **Status note.** This ADR stays `Proposed` until Phase 5 ([#6055](https://github.com/open-gsd/gsd-core/issues/6055)) merges, because the decision is only true once the subsumed scans are gone. Ratify it then, with a dated section that cites the merged phases.

## Context

The bodies under `gsd-core/workflows/`, `agents/`, `commands/` and `skills/` are executable shell and addressable references that a model runs at runtime. They are the largest executable surface in the product, and nothing compiles them against the surfaces they call.

Validation exists, but it is split per surface and written by hand. Each scan owns one directory or one spelling:

| Scan | Owns | Blind to |
|---|---|---|
| `scripts/lint-command-contract.cjs` (ADR-0002) | `commands/gsd/*.md` frontmatter, `<execution_context>` `@`-refs, workflow reachability | `agents/`; the shell inside workflows |
| `scripts/check-contract-drift.cjs` | `@~/.claude/gsd-core/references/…` includes | the bare `@gsd-core/references/…` spelling (#4841) |
| `scripts/lint-workflow-shellcheck.cjs` | shell correctness | contract correctness: an unassigned variable is valid shell |
| `scripts/lint-portable-grep.cjs`, `scripts/lint-portable-timeout.cjs` | `grep -P`, GNU `timeout` | every other command (`find`, #4805) |
| `scripts/lint-phase-arg-assignment.cjs` (#4831) | `${PHASE_ARG}` only | every other variable |
| `tests/check-predicate-dispatch-phase-flags-4483.test.cjs` | a hand-written table of five `check predicate` call sites | every other verb's inputs |
| `tests/runtime-command-form.test.cjs` (#5372) | colon-form strings in named `bin/lib` surfaces | any surface not named |
| `tests/plugin-manifest.test.cjs` (#5362) | the plugin manifest's two component paths | install-path collisions (#4855) |

The thirteen issues absorbed by #4909 were each fixed where they were reported. Several of those fixes added another per-surface scan (the last four rows above). The defect class is unchanged: the next unassigned variable that is not `PHASE_ARG`, the next omitted flag on a verb that is not `check predicate`, and the next dangling reference in a third spelling will all pass.

### A premise in the epic, corrected

The epic says `gsd-tools` "already knows its verbs and flags". That is half true.

- **Verbs** are declared, in `src/command-aliases.cts` (`*_COMMAND_ALIASES`, checked by `check:alias-drift`).
- **Flags** are not declared anywhere central. `src/command-arg-projection.cts` defines `NamedArgSpec` (`valueFlags`, `booleanFlags`, `optionalValueFlags`, `positionals`) and a strict `parseNamedArgs`, but each router passes its spec inline at the call site. Many handlers bypass it with a local `flag(name)` closure (for example in `gsd-core/bin/gsd-tools.cjs`, `src/worktree-safety.cts`, `src/check-auto-mode.cts`). `NamedArgSpec` has no notion of a *required* input.

So a CLI surface manifest cannot be generated from what exists. The declarations have to be created first.

## Decision

### D1. One flag-declaration seam: `NamedArgSpec`, lifted into a registry

1. `NamedArgSpec` gains `requiredFlags?: string[]`. Its members must be a subset of `valueFlags`. A missing or empty required value is an `InvalidArgs` result, never a silent `null`.
2. Specs move from inline call-site literals into an exported registry keyed by canonical verb (the same `canonical` key `command-aliases.cts` uses). A router reads its spec from the registry; it does not restate it.
3. Global flags (`--cwd`, `--ws`, `--raw`, `--json`) are declared once, as a global entry, not per verb.
4. No handler parses a flag outside this seam. Each ad-hoc `flag(name)` closure is migrated. **Hyrum's Law:** before strict validation reaches a verb, every flag that verb reads today is declared, so the declared surface equals the observed surface. Only flags nobody reads become rejections.

### D2. CLI surface manifest — generated, committed, `--check`ed

`scripts/gen-cli-surface-manifest.cjs --write|--check` emits the manifest from the D1 registry plus `command-aliases.cts`. It follows the same pattern as `gen-capability-registry` and `gen-loop-host-contract`. Per verb, the manifest records:

```json
{ "verb": "check.predicate", "aliases": ["check predicate"],
  "positionals": 0,
  "flags": { "predicate": "value", "phase-dir": "value", "phase-number": "value",
             "phase-req-ids": "value", "raw": "boolean" },
  "required": ["predicate"] }
```

`--check` runs in `lint:generated-sync`. A parity test drives real dispatch to prove that the CLI accepts and rejects exactly what the manifest declares, in both directions.

### D3. Post-install tree manifest — per runtime × profile × scope, `--check`ed

`scripts/gen-install-manifest.cjs --write|--check` produces, for each runtime, each profile (`core`, `standard`, `full`) and each scope (`global`, `local`, and `local --relative-includes`), the set of every path an installed artifact can address, including the `@`-ref target form each runtime's rewrite produces.

- The paths come from the installer's own path computation, not from a separate walk that could disagree with it. `buildInstallTree` and `tests/fixtures/install-tree/*.json` are regenerated from the same source, so there is one source of truth.
- **Conflicts are found at generation time, and generation fails on them:**
  - `path_collision`: two source artifacts install to one destination (#4855).
  - `duplicate_registration`: one component is reachable through two plugin component surfaces (#4860).

### D4. One extractor over every authored surface

`scripts/lint-shipped-contract.cjs` scans `gsd-core/workflows/`, `gsd-core/references/`, `agents/`, `commands/` and `skills/`. It tokenizes with `tests/helpers/shipped-command-scan.cjs`, the tokenizer the `--files` and `commit_docs` guards already share, promoted to `scripts/lib/`. It does not get a second tokenizer.

| Rule | Resolves | Against | Violation |
|---|---|---|---|
| R1 | `gsd_run <verb>` / `gsd-tools <verb>` | D2 manifest | `unknown_verb` |
| R2 | each `--flag` on that call | D2 manifest for the verb | `unknown_flag` |
| R3 | the verb's `required` flags | D2 manifest | `missing_required_input` |
| R4 | each `${VAR}` / `$VAR` read | an assignment earlier in the same file, a declared binding form, or the declared ambient set | `unassigned_variable` |
| R5 | each `@`-ref, in any spelling | D3 manifest, for **every** runtime × profile × scope | `dangling_ref` (names the runtime) |
| R6 | each named template or reference file (`…/templates/x.md`, `references/x.md`) | D3 manifest | `dangling_file` |
| R7 | each command name and its flags | the declared shipped-shell table | `disallowed_command`, `disallowed_flag` |

- **R4 binding forms.** The frozen `CANONICAL_FORMS` of `lint-phase-arg-assignment.cjs` (#4831) generalize to a declared table of derivation forms, keyed by form, not by variable name. The ambient set (`HOME`, `ARGUMENTS`, runtime-provided variables) is declared data. `${VAR:-default}` and `${VAR-default}` are guarded reads and are not violations.
- **R4 scope.** "Upstream" means earlier in the same file, across fenced blocks, because the model carries values between blocks. Block-local resolution is recorded as a known limit (below), not adopted.
- **R5 per runtime.** A reference that resolves on one runtime and not on another is a violation that names the failing runtime. The epic singles out this case. It cannot be expressed without D3.
- **R7 table.** The shipped-shell table declares the permitted external commands and, per command, its banned flags. It absorbs `lint-portable-grep` (`grep -P`) and `lint-portable-timeout` as two of its rows, and adds `find` (#4805). GSD cannot see a user's agent-shell allowlist, so the table is GSD's own portability contract, not a copy of anyone's settings.
- **Mentions are not calls.** Inline backticks, a single-quoted `'$(gsd_run …)'`, and `{placeholder}` notation without `$` are not resolved. These are the conventions the existing guards already use.
- **Escape.** The only escape is the existing per-line `# gsd-scan-ignore: #NNN` declaration. **Goodhart's Law:** there are no allowlist files and no baseline. A finding in the current tree is fixed in the phase that introduces the rule.
- **Positive controls.** Every rule has a fixture under `tests/fixtures/shipped-contract/` that is proven to drive the check red, and a failing-first regression for each absorbed issue it covers. The fixture for `secure-phase.md` and `validate-phase.md` is their pre-#4831 shape.

`--check` runs in `lint:ci` and in `lint:generated-sync`.

### D5. The install rewrite is a one-way generator with `--check`

After D3 generation, every emitted artifact is checked for unregistered command forms for its runtime, such as `/gsd:<cmd>` on a `slash-hyphen` runtime. Compiled `gsd-core/bin/lib` is in scope (#4859). Its user-facing command strings are read through a typed surface the runtime already exposes, not by grepping compiled source. The colon form stays the canonical authoring token. This rule asserts that the rewrite is complete; it does not change the token.

### D6. Subsumed scans are deleted, not kept beside the extractor

Each scan below is deleted once the extractor carries every rule it enforced, each with a fixture:

| Deleted | Replaced by |
|---|---|
| `scripts/lint-phase-arg-assignment.cjs` + its test | R4 |
| reference-include resolution in `scripts/check-contract-drift.cjs` (its marker/contract checks stay) | R5 |
| `<execution_context>` `@`-ref resolution and workflow reachability in `scripts/lint-command-contract.cjs` (frontmatter and `allowed-tools` stay) | R5, plus a reachability rule moved into the extractor |
| `scripts/lint-portable-grep.cjs`, `scripts/lint-portable-timeout.cjs` | R7 |
| `tests/check-predicate-dispatch-phase-flags-4483.test.cjs` call-site table | R3 |
| `tests/execute-phase-continuation-template-4783.test.cjs` | R6 |
| `tests/runtime-command-form.test.cjs` | D5 |
| the component-duplication assertions of `tests/plugin-manifest.test.cjs` | D3 `duplicate_registration` |

Keeping a scan beside the extractor is the defect this ADR closes. Two copies that agree today are the same defect as two that disagree.

### D7. Phase ownership

Each "Done when" item of #4909 is owned by exactly one phase:

| #4909 "Done when" | Phase |
|---|---|
| CLI surface manifest exists and is `--check`ed | P1 [#6051](https://github.com/open-gsd/gsd-core/issues/6051) |
| Every flag-taking verb declares its required inputs | P1 [#6051](https://github.com/open-gsd/gsd-core/issues/6051) (declaration) |
| A call site omitting a required input fails the check | P3 [#6053](https://github.com/open-gsd/gsd-core/issues/6053) |
| Post-install tree manifest per runtime and profile, `--check`ed | P2 [#6052](https://github.com/open-gsd/gsd-core/issues/6052) |
| Two artifacts cannot install to one path; duplicate registration is a generation conflict | P2 [#6052](https://github.com/open-gsd/gsd-core/issues/6052) |
| One extractor across `workflows/`, `agents/`, `commands/`, `skills/` | P3 [#6053](https://github.com/open-gsd/gsd-core/issues/6053) |
| Every rule has a positive control | P3 [#6053](https://github.com/open-gsd/gsd-core/issues/6053) (R1–R7); P2 (D3 conflicts); P4 (D5) |
| `secure-phase.md` / `validate-phase.md` fail as authored before #4831 | P3 [#6053](https://github.com/open-gsd/gsd-core/issues/6053) |
| Failing-first regression per absorbed issue | P3 [#6053](https://github.com/open-gsd/gsd-core/issues/6053) (#4777, #4772, #4483, #4841, #4783, #4805, #4780); P2 (#4855, #4860); P4 (#4859) |
| No unrewritten command form in any shipped artifact, `bin/lib` included | P4 [#6054](https://github.com/open-gsd/gsd-core/issues/6054) |
| Subsumed per-surface scans are deleted | P5 [#6055](https://github.com/open-gsd/gsd-core/issues/6055) |

The issues #4838, #4790 and #4776 are absorbed as evidence, but the epic's non-goals keep their remedies out of the seam. #4790's route decision is capability dispatch policy. #4838 is a runtime path pin that D3 records as an emitted path but does not judge. #4776 is a missing branch in a workflow, not a reference that fails to resolve.

Order: P0 → {P1, P2} → P3 (needs both manifests) and P4 (needs P2) → P5.

## Consequences

- A workflow body does not ship until it resolves. Adding a verb, a flag, an `@`-ref, or a shell command to shipped text is checked against a declared contract at lint time.
- Phase 1 makes flag validation strict for every verb. A flag a script passes that no handler reads becomes an `InvalidArgs` result. This is a user-visible `Changed` for those callers and needs its changeset and docs.
- The installer's path computation becomes the source of a committed manifest. An installer change that moves a path moves the manifest in the same diff, which `--check` enforces.
- The number of lint scripts goes down.

## Known limits

- The extractor is a token scanner, not a shell interpreter. `eval`, a verb name built at runtime, a one-line shell function body and backslash line continuations are not modeled. This is the same residual `tests/helpers/planning-add-guard.cjs` documents.
- R4 resolves across fenced blocks in one file. At runtime each fenced block can be a separate shell, so a value set in an earlier block may be empty later. R4 proves that a value is *assigned upstream*, not that it *survives* to the read.
- R7 is GSD's portability contract. It cannot reproduce a particular user's agent-shell allowlist.
- Cortex decision recall (`recall_decision`) was unavailable when this ADR was written, so no recorded decision was checked against it.

## Alternatives considered

1. **Fix each symptom where it was reported, and add a scan per symptom.** This is what happened, and it is why the defect class persists. Rejected by the epic.
2. **Infer flags from handler source (an AST walk over `flag(name)` closures).** A typo in a handler would become the contract, and a flag read through indirection would be invisible. Rejected: declare first, then generate.
3. **Run a real install per runtime × profile inside `lint:ci`.** Correct but too slow for a lint step. Rejected in favor of a committed manifest from the installer's path computation, with `--check`.
4. **Resolve `${VAR}` per fenced block.** Stricter than the epic and wrong about how the model carries values between blocks. It would flag the dominant `INIT=$(…)`-then-`jq` pattern. Recorded as a known limit instead.
5. **A baseline file of tolerated findings.** It gives a ratchet that can be gamed and a second copy of the truth. Rejected; findings are fixed in the phase that introduces the rule.
