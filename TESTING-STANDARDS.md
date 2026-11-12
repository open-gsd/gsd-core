# Testing Standards

This document is the authoritative reference for test correctness contracts, enforcement rules, and the test-rigor policies adopted in ADR 456 (`docs/adr/456-test-rigor-architecture.md`).

It orients you to the existing docs without duplicating them:

- **Suite naming, CI matrix, per-suite scripts** → [`docs/TESTING-SUITES.md`](docs/TESTING-SUITES.md)
- **Test runner imports, setup/teardown patterns, fixture formatting, QA matrix** → [`CONTRIBUTING.md` — "Testing Standards"](CONTRIBUTING.md#testing-standards)
- **Concrete demo tests for each requirement** → [`TEST-EXAMPLES.md`](TEST-EXAMPLES.md)
- **Machine-greppable predicates (`RULESET.TESTS.*`)** → [`CONTEXT.md` — "Test rules and lint"](CONTEXT.md)

---

## Six test-rigor contracts

Every test in this project must satisfy these six contracts. They apply to new tests and to revisions of existing tests.

### 1. Exercise real code, not source or output text

Tests call exported functions or run the CLI and parse structured output. They do not `readFileSync` a source file and assert on its text content. They do not assert on raw stdout/stderr strings beyond exit-code confirmation.

**Compliant:**

```javascript
const { stdout } = await runGsdTools(['plan', '--json']);
const result = JSON.parse(stdout);
assert.strictEqual(result.phases[0].id, 'plan-1.1');
```

**Non-compliant:**

```javascript
const src = readFileSync('./bin/lib/plan.cjs', 'utf8');
assert(src.includes('plan-1.1')); // never do this
```

**Enforcement:** `local/no-source-grep` (ESLint, `error`; promoted repo-wide by #3313).

### 2. No vacuous-truth assertions

Assertions must be capable of failing given a plausible defect in the SUT. An assertion whose left-hand side is always truthy regardless of SUT behavior does not add coverage.

**Non-compliant:**

```javascript
assert(true);
assert.ok(output !== undefined); // output is unconditionally set above
```

**Compliant:** Assert on a value that the SUT computed and that a mutation of the SUT could change.

**Enforcement:** Code review + `local/no-source-grep` (catches a common vacuous sub-pattern). No automated rule covers all shapes; code review is the primary gate.

### 3. No pass-always tests

A test that passes regardless of whether the feature it describes is implemented is worse than no test: it inflates the count while providing false confidence.

The test must be capable of failing if the feature is absent or broken. Write the test first (red phase of TDD), confirm it fails with a stub implementation, then implement.

**Enforcement:** `local/no-source-grep`, code review, and Stryker mutation score (surviving mutants in covered paths signal pass-always tests).

### 4. Test the claimed path

The test name describes a behavior. The test body must exercise that behavior through the implementation path, not through a mock that replaces the entire SUT.

If the test name says "acquireLock expires after TTL," the test must call `acquireLock` (not a hand-rolled stub that does nothing) and assert that a lock acquired at time T is expired at time T + TTL + 1ms.

**Enforcement:** Code review. Stryker mutation score on uncovered paths.

### 5. Complete mocks

When mocking a dependency, mock only the dependency — not the SUT behavior itself. A mock that returns a hardcoded value from inside the function under test is a pass-always test in disguise.

External I/O (filesystem, network, clock) is the appropriate scope for mocking. Business logic inside the SUT is not mocked; it is exercised.

**Enforcement:** Code review.

### 6. Counter-tests for negative space

For every behavioral contract, at least one test must exercise an input that the SUT should reject or handle differently from the happy path. Examples: missing required argument, value at boundary + 1, hostile input.

See [`CONTRIBUTING.md` — "QA Matrix Requirements"](CONTRIBUTING.md#qa-matrix-requirements) for the twelve-case matrix. Apply the cases relevant to the changed surface.

**Enforcement:** Code review, `no-only-tests/no-only-tests` ESLint rule (prevents happy-path-only merges via `test.only`).

#### Standing rule: assert the degraded verdict, not just "did not throw"

A counter-test that feeds a hostile or failing input satisfies the letter of contract 6 above and can still be worthless. If a function has an error or fallback branch — a guard that degrades permissively on bad input, a resolver that falls back to a default root, a lock that expires — the test for that branch must assert the **specific degraded verdict** the branch produces, not merely that the call completed without throwing or returned *some* value of the right type.

**Non-compliant (the pre-fix shape of the timeout counter-test, here written against `resolveProjectContext`, per [#3050](https://github.com/open-gsd/gsd-core/issues/3050) finding 2 and epic [#3051](https://github.com/open-gsd/gsd-core/issues/3051) Phase 3, generalized here as [#3053](https://github.com/open-gsd/gsd-core/issues/3053) H4):**

```javascript
// A liveness test wearing a correctness test's name — it proves the call
// survived a timeout, not that it degraded to the RIGHT shape.
test('resolveProjectContext handles a timeout', () => {
  const ctx = resolveProjectContext('/repo/wt', { deps: { execGit: makeTimeoutStub() } });
  assert.doesNotThrow(() => resolveProjectContext('/repo/wt', { deps: { execGit: makeTimeoutStub() } }));
  assert.strictEqual(typeof ctx.projectRoot, 'string'); // true of ANY string, including the wrong one
});
```

**Compliant (the fixed shape, asserting the degraded provenance `resolveProjectContext` reports):**

```javascript
test('degrades to the start directory with reason=git_timed_out on timeout, not throw', () => {
  const ctx = resolveProjectContext('/tmp', { deps: { execGit: makeTimeoutStub() } });
  assert.strictEqual(ctx.worktreeRoot, '/tmp');   // the specific degraded value, not just "a string"
  assert.strictEqual(ctx.provenance.reason, 'git_timed_out');
  assert.strictEqual(ctx.provenance.degraded, true);
});
```

This is not the same requirement as the input-rejection rule above it. A test can already satisfy "feed the SUT a hostile input" while still failing this one, if it never checks *what the SUT did in response*. Two shapes are explicitly out of scope for this rule — they are not fail-open guards and adding this counter-test to them would be noise, not signal:

- A branch that re-throws or propagates the error rather than producing a degraded verdict — contract 4 above ("test the claimed path") already covers it via `assert.throws`.
- A branch that returns a documented, structured error signal that the test already asserts on directly (a three-state policy that fails closed on malformed input, a dispatch convention, an `{isError: true}` return shape) — the structured field *is* the verdict; asserting on it already satisfies this rule.

**Why this isn't a lint rule.** A pattern scan for fail-open shapes was measured directly against this repo's `src/*.cts` during epic #3051: it scored 1 true positive against 3 false positives (a documented three-state policy, a dispatch convention, and a structured `isError` return each looked like a fail-open guard and were not). The permissive-verdict shape is module-specific, not mechanically enumerable, so a lint rule here would be both incomplete and noisy. This is a code-review expectation, not a CI gate — it will not fail a build on its own; it fails when a reviewer (human or `/code-review`) lets a "did not throw" test stand in for a correctness test.

**Enforcement:** Code review only — deliberately not lint-enforced (see above). Cross-linked from [`CONTRIBUTING.md` — "QA Matrix Requirements"](CONTRIBUTING.md#qa-matrix-requirements) so reviewers see it at the point they already apply the negative-space matrix.

---

## New policies (ADR 456)

### No timing or elapsed-time assertions

Do not assert on wall-clock elapsed time. Such assertions test the host machine, not the SUT, and fail spuriously on loaded CI runners.

**Non-compliant:**

```javascript
const start = Date.now();
await doWork();
assert(Date.now() - start < 200, 'must complete in 200ms');
```

**Enforcement:** `local/no-elapsed-assertion` (ESLint, `error` — promoted by [#3331](https://github.com/open-gsd/gsd-core/issues/3331) once #3314 delivered its precondition: ADR-456 §(a) amended with a reachability-based selection rule covering all three clock-control mechanisms this repo uses, and the direct-use modules carrying real time-gating logic (`commands.cts`, `init.cts`, `io.cts`) backfilled with deterministic coverage). Also `no-restricted-syntax` ban on `performance.now()` comparisons in assertions.

### Clock-seam pattern for concurrency

Concurrency logic must be tested deterministically, via one of three reachability-selected mechanisms (see ADR-456 §(a)): an injectable clock seam for modules that accept `{clock = Date}`, `node:test` `mock.timers` for in-process direct-`Date`-reading code, or the `GSD_TEST_MODE`+`GSD_NOW_MS` subprocess pin (routed through `realClock`) for CLI-spawned code. Real OS scheduler races are non-deterministic on loaded CI runners and are not a permitted test pattern regardless of which mechanism applies.

**Compliant pattern:**

```javascript
// Production code
function acquireLock(resource, { clock = Date } = {}) {
  const deadline = clock.now() + LOCK_TTL_MS;
  // ... implementation uses clock.now()
}

// Test
test('lock expires after TTL', (t) => {
  t.mock.timers.enable(['Date']);
  t.mock.timers.setTime(0);
  acquireLock('res');
  t.mock.timers.tick(LOCK_TTL_MS + 1);
  assert.strictEqual(isLockExpired('res'), true);
});
```

**Enforcement:** `local/no-magic-sleep-in-tests` (bans `setTimeout`/`sleep`/`delay` inside test bodies; ESLint, `error`). Code review catches the race pattern directly.

### Property-based testing tier

Modules that implement parsing, transformation, budget/limit logic, or any bijective contract must include at least one `fast-check` (`fc`) property test asserting a domain invariant. Property tests live in `*.test.cjs` files alongside unit tests; no separate suite tag is required.

Invariant categories to consider: round-trip, monotonicity, boundary containment, idempotency.

**Threshold:** No hard per-file threshold is enforced by CI tooling; the gate is Stryker mutation score (see below). Property tests are the mechanism that drives mutation score above the threshold on logic-heavy paths.

**Enforcement:** Code review verifies that property tests exist for modules in scope. Stryker mutation score below 80 % blocks merge (see next section).

### No ad hoc timeout literals

Do not write a bare numeric `timeout`/`timeoutMs` option value at a test call site. Two independently-guessed copies of the same magic number can silently drift apart, or worse, collide exactly and produce a zero-margin race: `bin/check-latest-version.cjs`'s `timeout: 15_000` and this suite's independent `timeoutMs: 15000` could SIGKILL the whole process tree at the exact same instant, and it failed specifically on Windows CI (fixed in PR #4428).

**Non-compliant:**

```javascript
const r = runHookSeam(WORKER_PATH, [], { timeoutMs: 15000 });
```

**Compliant — same class of subprocess as an existing class-norm:**

```javascript
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const r = runHookSeam(WORKER_PATH, [], { timeoutMs: GIT_TIMEOUT_MS });
```

**Compliant — a genuinely distinct class, declared locally with a margin over the thing it wraps** (the actual fix in PR #4428 — the worker's inner `npm view` call is bounded by its own named `NPM_VIEW_TIMEOUT_MS`, so the outer test imports it and adds explicit headroom instead of re-guessing a number):

```javascript
const { NPM_VIEW_TIMEOUT_MS } = require('../gsd-core/bin/check-latest-version.cjs');

const WORKER_TEARDOWN_MARGIN_MS = 10_000; // real headroom beyond the inner timeout it wraps

const r = runHookSeam(WORKER_PATH, [], { timeoutMs: NPM_VIEW_TIMEOUT_MS + WORKER_TEARDOWN_MARGIN_MS });
```

Import an existing class-norm constant from `tests/helpers/timeouts.cjs` (`PROBE_TIMEOUT_MS`, `GIT_TIMEOUT_MS`, `BUILD_TIMEOUT_MS`, `INSTALL_TIMEOUT_MS`, and the rest of its exports) when the call is the same class of subprocess. Otherwise declare a local one with a comment justifying why it is a distinct class — see CONTRIBUTING.md's "Use Centralized Test Helpers" section. A local constant must not reuse a `timeouts.cjs` export name. A file-local `GIT_TIMEOUT_MS` holding thirty seconds reads as the shared fifteen-second norm while meaning something else. Give it its own name, such as `QUICK_BRANCHING_GIT_TIMEOUT_MS`. A coincidental *value* is fine; a reused *name* is not.

#### Every new or changed timeout constant states its evidence

A timeout constant is a claim about how long a class of call takes. Its comment must state the measurement behind it, not a round guess:

1. **Observed range** — the worst observed duration for that class of call, with the p50/p99 where the data has them, and how many samples back it.
2. **Worst platform** — the platform (`win32`, `darwin`, `linux`) where the worst observation came from.
3. **Margin** — the ratio of the constant to that worst observation. It must be at least 2x.
4. **Source** — where the numbers came from and over what window. One option is the CI `seam:spawn-stall` records in the `test-timings-*` artifacts (process-seam spawns of 2000ms or more, uploaded from the ubuntu, Windows and macOS lanes). The other is a harness run, naming the platforms it ran on.

"No spawn of this class reached the 2000ms log threshold on any lane that ran it" is valid evidence. It is an upper bound: state it as `< 2000ms` and compute the margin against 2000. Evidence from a spawn the seam does not see counts for nothing, and neither does a lane that never ran the call. A `child_process` call made directly never reaches the log, so route new spawns through `tests/helpers/process-seam.cjs`.

Three kinds of constant are exempt from the margin, but must say which kind they are:

- **Fixture data** — a number placed inside a fixture document (a hook entry's `timeout` field, a manifest's `timeoutMs`). It is never passed to a spawn.
- **Test backstop** — a `node:test` per-test `{ timeout }` that only turns a runaway into a failure; the test normally finishes in milliseconds.
- **Mirror** — the same value as another module's own constant. A mirror re-exports that constant (`SEAM_DEFAULT_TIMEOUT_MS` is `process-seam.cjs`'s `DEFAULT_TIMEOUT_MS`). Restating the literal is not allowed.

In `tests/helpers/timeouts.cjs` the evidence is data, not only prose. Every exported constant has a `TIMEOUT_EVIDENCE` entry: `measured` (observed maximum, worst platform, samples per platform, source, window, the platforms with no data, and the call sites the seam cannot see), or one of the exempt kinds with its reason. The comment cites that entry. `tests/timeout-evidence.test.cjs` fails when:

- a constant has no entry;
- an entry names no constant;
- a measured constant is below 2x its worst observation;
- a mirror no longer equals its source.

The test checks only the recorded data. It never re-measures a spawn, so a class that gets slower does not fail it. It fails when the recorded evidence no longer supports the value: the value is lowered below 2x the observation, or a new measurement is recorded that breaks the 2x floor. New measurements come from re-reading the CI `seam:spawn-stall` log, then updating the entry and, if needed, the value.

The fields of a `measured` entry:

- `samples`: the number of log records seen per platform (win32, darwin, linux). The worst platform must have a count above 0.
- `lanes`: used by a censored entry instead of `samples`. It counts the CI lanes per platform that ran the class's seam sites, because a censored entry has no records to count. A censored entry carries no `samples`.
- `p50Ms`, `p99Ms`: optional percentiles of the recorded durations. Give both or neither, with `p50Ms <= p99Ms <= observedMaxMs`. A censored entry carries neither.
- `unmeasuredPlatforms`: required. It lists every platform whose `samples` (or `lanes`) count is missing or 0, and only those.
- `unseenSites`: required. The number of call sites of this constant that the process seam cannot see, so the log says nothing about them. When it is above 0, `unseenSitesTrackedBy` names the issue that moves them, written `#6058` or `#6058 #6059`.

**Enforcement:** `local/no-adhoc-timeout-literal` (ESLint, `error`) for literals; `tests/timeout-evidence.test.cjs` for the evidence in `tests/helpers/timeouts.cjs`; code review for the comment shape of file-local constants. A non-literal value (an `Identifier`, `MemberExpression`, or `CallExpression`) is trusted; only a resolvable numeric literal is flagged. There is no marker-comment escape — the fix is always to extract a named constant. There is no allowlist. `eslint-rules/no-adhoc-timeout-literal.allowlist.json` grandfathered pre-existing legacy violations; the epic that introduced it (#4445) migrated every site across seventeen batches and deleted the file in its terminal batch, so `local/no-adhoc-timeout-literal` now runs with **no exemption surface**.

### One installer run per runtime configuration per file

A real `bin/install.js` run is the most expensive thing a test can do. When several tests in one file install the **same** runtime configuration only to read different parts of the result, install it once with `installRuntimeFixture` from `tests/helpers/install-shared.cjs` (#4688):

```javascript
const { installRuntimeFixture } = require('./helpers/install-shared.cjs');

test('settings.json registers the hooks', () => {
  const { configDir } = installRuntimeFixture({ runtime: 'augment', scope: 'global' });
  // read-only assertions against configDir
});

test('settings.json registers the MCP companion', () => {
  const { configDir } = installRuntimeFixture({ runtime: 'augment', scope: 'global' }); // no second install
  // read-only assertions against configDir
});
```

| Behavior | Detail |
|---|---|
| Key | `runtime`, `scope`, `extraArgs` (order matters) and `extraEnv` (key order does not). Each distinct key installs once. |
| Lifetime | One test file. `node --test` runs each file in its own process; every cached root is deleted when that process exits. |
| Result | The same object `runMinimalInstall` returns (`configDir`, `root`, `manifest`, `stdout`, `stderr`), deep-frozen and shared by every caller with that key. |
| Failure | A failed install throws exactly as `runMinimalInstall` does and is not cached; the next call retries. |
| `root` | Rejected with a `TypeError`. A shared fixture owns its root. |

**Use it only for read-only tests.** A test that writes into the installed tree, reinstalls, uninstalls, or seeds files before installing changes what every later test sees. Keep `runMinimalInstall` (a fresh root per call) for those. Do not register `t.after(() => cleanup(root))` on a shared fixture: it would delete the tree for the tests after it.

### Mutation testing — 80 % threshold

Stryker runs in incremental mode (`--since origin/next`) on the `ubuntu-latest` / Node 24 CI leg as a PR-gating signal. The default threshold is **80 % mutation score** (killed / total mutants in the changed scope). PRs that drop below this threshold must either add tests that kill the surviving mutants or add the specific path to `stryker.config.mjs` with a documented reason.

A surviving mutant is a concrete specification of missing coverage. Treat it as a failing test, not as a metric.

**Enforcement:** `stryker run --since origin/next` in CI. Threshold configured in `stryker.config.mjs`.

### Delete-bad-tests policy

Tests in the following categories are **deleted** and replaced with compliant tests in the same PR. They are not commented out, not skipped, and not annotated with a permanent `// allow-test-rule` exemption:

| Category | Signal |
|---|---|
| Pass-always | Assertion always evaluates truthy regardless of SUT state |
| Vacuous-truth | LHS is computed from the same expression as the SUT input |
| Source-grep | `readFileSync` on a source file + text assertion |
| Elapsed-time | Assertion on `Date.now()` delta or `performance.now()` comparison |
| Real-race | Test outcome depends on OS scheduler timing |
| Permanent `allow-test-rule` | Exemption with no tracking issue and no deadline |

"Replaced" means: in the same PR, add a behavioral test that exercises the logical path the deleted test was intended to cover, using the typed-surface mandate (contract 1 above) and, where concurrency is involved, the clock-seam pattern.

Real multi-process race tests are deleted once the corresponding deterministic clock-seam test covers the same logical path. No permanent quarantine.

**Enforcement:** ESLint rules catch source-grep, magic-sleep, and elapsed-assertion shapes. Code review is the gate for pass-always and vacuous-truth. The delete-bad-tests sweep (tracked separately) addresses the backlog of pre-ADR 456 tests.

---

## ESLint rule reference

| Rule | Severity | What it catches |
|---|---|---|
| `local/no-source-grep` | `error` (promoted by #3313) | `readFileSync` on source files + text assertions; `assert.match`/`doesNotMatch` on raw stdout/stderr |
| `local/no-magic-sleep-in-tests` | `error` | `setTimeout`/`sleep`/`delay` calls inside `test()`/`it()`/`describe()` bodies |
| `local/no-elapsed-assertion` | `error` (promoted by #3331, precondition delivered by #3314) | Assertions on `Date.now()` delta, `process.hrtime()`, `performance.now()` comparisons |
| `local/no-adhoc-timeout-literal` | `error` | Bare numeric `timeout`/`timeoutMs` option literal in `tests/**/*.cjs` (PR #4428) |
| `no-only-tests/no-only-tests` | `error` | `test.only`/`describe.only`/`it.only` committed to non-scratch files |
| `no-restricted-syntax` (ban 1) | `error` | Top-level `setTimeout` in `ExpressionStatement` |
| `no-restricted-syntax` (ban 2) | `error` | `.only` member access on `test`/`it`/`describe` (belt-and-suspenders) |

`local/no-source-grep` and `local/no-magic-sleep-in-tests` ship at `error` (promoted by [#3313](https://github.com/open-gsd/gsd-core/issues/3313), absorbing the cleanup sweep originally tracked at #453). `local/no-elapsed-assertion` now also ships at `error` (promoted by [#3331](https://github.com/open-gsd/gsd-core/issues/3331)) — [#3314](https://github.com/open-gsd/gsd-core/issues/3314) delivered its precondition first (ADR-456 §(a) amended with a reachability-based 3-mechanism rule; `commands.cts`/`init.cts`/`io.cts` backfilled with deterministic coverage), mirroring the same handover boundary the epic draws for its other items. New violations added after the acceptance of ADR 456 are out of policy regardless of ESLint severity.

ESLint harness details: [`docs/adr/452-eslint-lint-harness.md`](docs/adr/452-eslint-lint-harness.md).

---

## Markdownlint compliance

This file uses fenced code blocks with explicit language tags (`javascript`, `text`) as required by MD040. All tables use consistent column counts (MD056).
