# Testing Suites

This project's `tests/` directory uses **filename suffix markers** to group tests into named suites. The harness `scripts/run-tests.cjs` filters by suite when given `--suite <name>`. Without a flag it runs every `*.test.cjs` file (the historical default — unchanged).

> Tracked by issue [#3597](https://github.com/open-gsd/gsd-core/issues/3597).

## Suites

| Suite | Filename pattern | What goes here |
|---|---|---|
| `unit` | `*.test.cjs` (no other marker) | Default fast lane. Pure logic, no network, no external processes beyond `gsd-tools`. Most tests live here. |
| `integration` | `*.integration.test.cjs` | Cross-module flows: full installer end-to-end, multi-tool orchestration, anything that crosses two or more bin entry points. |
| `install` | `*.install.test.cjs` | Tests that perform a real install/uninstall against a sandbox project. Slower; PR CI skips these on PRs and runs them on `main` push only. |
| `security` | `*.security.test.cjs` | Adversarial input, prompt-injection guards, fixture-driven hostile-payload sweeps. |
| `slow` | `*.slow.test.cjs` | Anything that routinely takes >5s wall-clock or holds significant memory. |
| `all` | (any) | Explicit alias for "no filter". Equivalent to running with no `--suite` flag. |

## How to place a new test

1. Pick the most specific bucket above.
2. Name the file with the matching suffix: `tests/<feature>.<suite>.test.cjs`.
3. If unsure, leave the suffix off — the file lands in `unit`, the default fast lane.

Examples:
- `tests/agent-frontmatter.test.cjs` — `unit`
- `tests/prompt-injection-guards.security.test.cjs` — `security`
- `tests/installer-end-to-end.install.test.cjs` — `install`
- `tests/sdk-mutation-stress.slow.test.cjs` — `slow`

The suite-suffix convention was chosen over a directory layout (`tests/security/`) so the 545+ existing test files don't need to move. Existing files all classify as `unit` until someone explicitly retags them.

## Regression tests

**Do not create new top-level `tests/bug-NNNN-*.test.cjs` files.** Add the
regression case to the owning module's main test file instead (e.g. a
`describe('regressions')` block in `tests/<module>.test.cjs`).

`node --test` spawns one child process per FILE, so file count — not test
count — is the unit of CI overhead, and it is worst on Windows lanes where
every spawn is Defender-scanned. The 2026-06 CI audit found 244 one-off
`bug-*` files (~38% of the suite). That population is grandfathered in
`scripts/lint-regression-test-names.allowlist.json` and enforced by an
identity ratchet (`npm run lint:regression-names`, part of `npm run lint:ci`):

- A **new** `bug-*` file fails CI — fold it into the owning module's file.
- **Deleting/consolidating** a grandfathered file requires pruning its
  allowlist entry, so the baseline only ever shrinks.
- **Inherited drift** (the failure names files your PR didn't add — e.g. the
  base branch merged `bug-*` files without feeding the allowlist, or you
  rebased and carried a pre-rebase allowlist): run
  `node scripts/lint-regression-test-names.cjs --update` and commit the
  regenerated allowlist. Snapshot artifacts like this allowlist (and
  `docs/INVENTORY.md`) must be regenerated **after** rebasing, never carried
  through a rebase.

The ratchet deliberately covers only `bug-*`. Files named `feat-NNNN-*` /
`enh-NNNN-*` are *feature* test files — one (or one per suite) per feature is
the sanctioned layout (see the #443 strategy below), not a one-off regression
pattern. If `issue-*`/`perf-*` one-offs start accumulating the same way
`bug-*` did, extend the ratchet's regex and regenerate the allowlist.

## Running suites locally

```bash
npm test                    # everything (backcompat — same as before)
npm run test:unit           # only unit
npm run test:integration    # only integration
npm run test:install        # only install
npm run test:security       # only security
npm run test:slow           # only slow

npm run test:coverage       # backcompat — coverage over EVERY test
npm run test:coverage:unit  # fast coverage signal — only unit suite
npm run test:coverage:all   # alias for test:coverage
```

Direct harness invocation also works:

```bash
node scripts/run-tests.cjs --suite security
node scripts/run-tests.cjs --suite=security
node scripts/run-tests.cjs --files "tests/command-contract.test.cjs tests/core.test.cjs"
node scripts/run-tests.cjs --files-from .ci-selected-tests.txt
```

`npm run test:affected` (scripts/run-affected-tests.cjs) is a **local-only**
convenience that selects tests via the `require()` dependency graph of your
working-tree diff. CI does not use it — CI selection is the rule table in
`scripts/ci-test-scope.cjs`, which is the authoritative mapping. If the two
disagree, trust (and fix) the rule table.

Unknown suites exit non-zero with the list of valid suites. Empty suites (e.g. `--suite security` before any security-tagged file exists) exit `0` with a `no tests in suite "..."` notice on stderr so CI lanes don't go red while a suite is being populated.

## CI matrix

The `Tests` workflow runs every PR through a scoped gate generated by
`scripts/ci-test-scope.cjs`.

| Lane | Node 22 | Node 24 |
|---|---|---|
| `ubuntu-latest` | scoped tests | unit + integration + security |
| `windows-latest` | — | scoped Windows/path/shell tests |
| `macos-latest` | full parity when required | full parity when required |

- **Node 22** is the `engines.node` floor (`>=22.0.0`) — must stay green.
- **Node 24** is the default development lane.
- **Scoped tests** are selected from the changed paths, plus a small CLI/package
  smoke set. They are for confidence on the affected surface, not for counting
  tests.

The default PR gate runs the broad `unit` (under the c8 coverage gate),
`integration`, and `security` suites once on Ubuntu / Node 24, scoped tests on
Ubuntu / Node 22, and scoped tests on Windows / Node 24. "Scoped" means the
diff-selected list from the rule table — not the full suite and not a fixed
smoke set (the fixed smoke list is only the empty-selection fallback). The
Windows lane's list is the Windows-sensitive subset of the selection, plus
**every changed test file, unconditionally** (the #494 invariant, narrowed): a
modified test is exercised on the divergent OS before merge at per-file cost,
without paying for the three full parity lanes.

PRs touching workflow, package, test-runner, install, release, or
Windows-sensitive surfaces also run the full parity matrix on macOS and the
older Windows runtime, plus `install` and `slow` on the primary Ubuntu lane.
Everything (including the full parity matrix) runs on every push to `next`,
which covers the residual macOS / Windows-Node-22 cross-product for scoped PRs.

Coverage runs inside the Ubuntu / Node 24 full lane (not a separate job — that
duplicated the entire unit run) and stays single-lane because multiplying
coverage across OS/runtime lanes adds cost without improving the threshold
signal. Note the gate's deliberate blind spot: it measures
`gsd-core/bin/lib/*.cjs` only — `scripts/`, `hooks/`, and `bin/` are
unenforced, and `stryker.config.mjs` additionally excludes ~48% of lib lines
from mutation testing (see the UNMUTATED list there). Widening either gate is
tracked work, not an accident to "fix" silently by raising thresholds.

To inspect the scope locally:

```bash
npm run ci:test-scope -- --files "commands/gsd/plan-phase.md"
node scripts/ci-test-scope.cjs --base origin/next --head HEAD
```

## Best practices for forward-compat (Node 24/26)

- Use `process.execPath` when spawning Node in tests so each matrix lane exercises the lane's Node version.
- Avoid stack-trace or error-message prose assertions. Assert `err.code`, structured JSON fields, or enums — Node minor releases routinely tweak error wording.
- Prefer `node:test`, `node:assert/strict`, and `node:test` mocks. No external test frameworks.
- Coverage uses `c8` and propagates `NODE_V8_COVERAGE` through the harness's child process.

---

## Test strategy: #443 effort + fast_mode engine

> Feature: unified cross-provider effort and fast_mode knobs (issue #443).
> Test files: `tests/feat-443-effort-fast-mode.test.cjs` (unit),
> `tests/feat-443-effort-fast-mode.integration.test.cjs` (integration).

### Testing pyramid

| Layer | File | What it covers |
|---|---|---|
| **Unit** | `feat-443-effort-fast-mode.test.cjs` | Pure logic: cascade rules, clamping, escalation math, malformed config handling, schema key validation. No CLI subprocess. |
| **Integration** | `feat-443-effort-fast-mode.integration.test.cjs` | Architecture-level invariants: cross-provider validity, totality across the 33-agent registry, CLI JSON contract, config round-trip, fast-mode honesty. Real subprocesses via `runGsdTools`. |
| **E2E** *(pending)* | *(not yet wired)* | Propagation layer: effort frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env actually reaching a spawned Claude Code subagent. See "Gaps" below. |

### Architectural invariants

Each invariant exists to prevent a specific class of production failure.

#### (a) Cross-provider validity

**What:** `renderEffortForRuntime(runtime, universalEffort).value` must always
be a member of the runtime's real provider enum. Ground-truth enums are defined
as local constants in the test — not sourced from the implementation.

```
PROVIDER_EFFORT_ENUMS = {
  claude: Set { 'low', 'medium', 'high', 'xhigh', 'max' }   // Anthropic output_config.effort
  codex:  Set { 'minimal', 'low', 'medium', 'high', 'xhigh' } // OpenAI model_reasoning_effort
}
```

**Why:** Passing a value outside these sets results in a 400 from the real API.
The clamping logic (`max -> xhigh` for codex; `minimal -> low` for claude) must
hold for every cell of the VALID_EFFORTS × runtimes matrix.

#### (b) Param/channel contract

**What:** Each runtime exposes a stable `param` string (the native API field
name) and `channel` (how the value is propagated). Unknown runtimes return
`param: null, channel: null` and pass the effort value through unchanged.

**Why:** Callers read `.param` to construct the dispatch payload. A regression
here would silently drop effort from subagent invocations.

#### (c) Resolve-execution JSON contract

**What:** The `gsd-tools resolve-execution <agent>` command emits a JSON object
with all eight keys present and typed correctly: `model` (string), `profile`
(string), `effort` (VALID_EFFORTS member), `effort_rendered` (string),
`effort_param` (string|null), `effort_propagation` (string|null), `fast_mode`
(boolean), `fast_mode_supported` (boolean).

**Why:** Orchestrators and workflow dispatchers parse this JSON. A missing or
mistyped field silently breaks downstream consumers.

#### (d) Totality across the real registry

**What:** For every agent in the 33-agent registry, `resolveEffortInternal`
returns a VALID_EFFORTS member (never undefined/null), `resolveFastModeInternal`
returns a strict boolean, and `renderEffortForRuntime('claude', effort)` stays
within the claude provider enum.

**Why:** A catalog addition that introduces a missing `routingTier` mapping
would otherwise produce `undefined` and propagate silently.

#### (e) Fast-mode honesty invariant

**What:** When the runtime is `claude`, `fast_mode_supported` in
resolve-execution output is always `false`, regardless of the fast_mode config.
`RUNTIMES_WITH_FAST_MODE` contains only `'api'`.

**Why:** Claude Code's `/fast` toggle is session-level only. Emitting
`fast_mode: true` as frontmatter on a Claude subagent is a silent no-op.
Advertising `fast_mode_supported: true` for claude would cause orchestrators to
believe the knob was wired when it is not.

#### (f) Precedence first-valid-wins

**What:** Both effort and fast_mode use a layered cascade. The test table covers
all four effort layers (invocation override → agent_overrides →
routing_tier_defaults → default) and all five fast_mode layers, including the
case where an invalid value at a higher layer correctly falls through.

**Why:** Silent precedence bugs (e.g., a numeric value in agent_overrides not
being rejected) would override intentional user config.

#### (g) Dynamic-routing composition

**What:** `resolveEffortForTier` escalates effort by attempt number
independently of the model tier mapping. The test verifies the effort ladder
(`low -> medium -> high -> xhigh -> max`), the `max` clamp, the
`max_escalations` cap, and that `escalate_on_failure: false` suppresses
escalation entirely.

**Why:** Effort escalation and model escalation share configuration
(`dynamic_routing`) but must operate independently; coupling them would cause
over-escalation or under-escalation.

#### (h) Config-tooling round-trip

**What:** `gsd-tools config-set` accepts all new key namespaces
(`effort.default`, `effort.routing_tier_defaults.<tier>`,
`effort.agent_overrides.<agent>`, `fast_mode.enabled`,
`fast_mode.routing_tier_defaults.<tier>`, `fast_mode.agent_overrides.<agent>`)
without an "Unknown config key" error, and values set via `config-set` are
reflected in `resolve-execution` output.

**Why:** The schema validation gate (`VALID_CONFIG_KEYS` + `DYNAMIC_KEY_PATTERNS`)
is separate from the resolver logic. A key missing from the schema would produce
a silent write failure and appear as a bug only at runtime.

### Coverage targets

| Suite | Target |
|---|---|
| Unit | Every cascade rule, every fallthrough, every clamp. All function branches in `resolveEffortInternal`, `resolveFastModeInternal`, `resolveEffortForTier`, `renderEffortForRuntime`. |
| Integration | All 8 architectural invariants. All 33 registered agents. All 6 provider × effort combinations for the valid-enum check. Full config-set key namespace. |

### Gaps / not yet covered

**E2E orchestrator-spawn-propagation layer (pending follow-up wiring):**
The integration tests verify that GSD resolves and renders effort values
correctly. They do NOT verify that the rendered values actually reach a spawned
Claude Code or Codex subagent at runtime. Specifically uncovered:

- `CLAUDE_CODE_EFFORT_LEVEL` env var being set and read by a spawned claude subprocess
- `output_config.effort` frontmatter key surviving the AGENTS.md template substitution
- `model_reasoning_effort` field surviving serialization into a Codex API request body
- Fast-mode `speed: "fast"` field reaching an `api`-runtime request when `fast_mode_supported: true`

These require spawning real subagents (or stubs thereof) and asserting on the
process environment / request payload — a scope that belongs in a future E2E
suite under `*.slow.test.cjs` or dedicated fixture-driven integration work.
