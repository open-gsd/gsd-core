# Testing Standards

This document is the authoritative reference for test correctness contracts, enforcement rules, and the test-rigor policies adopted in ADR 456 (`docs/adr/456-test-rigor-architecture.md`).

It orients you to the existing docs without duplicating them:

- **Suite naming, CI matrix, per-suite scripts** → [`docs/TESTING-SUITES.md`](docs/TESTING-SUITES.md)
- **Test runner imports, the helper tables, setup/teardown patterns, fixture formatting, QA matrix** → [`CONTRIBUTING.md` — "Testing Standards"](CONTRIBUTING.md#testing-standards)
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

### One installer run per runtime configuration per run

A real `bin/install.js` run is the most expensive thing a test can do: about a second, most of it
writing a thousand files. One bench run made 1,553 of them for 187 distinct configurations (#6335).
A test that needs an installed tree takes it from `tests/helpers/install-shared.cjs`, by what it
does with the tree:

| The test | Uses | Cost |
|---|---|---|
| only reads the installed tree | `installRuntimeFixture({ runtime, scope })` | one install per configuration for the whole run |
| writes into the tree, reinstalls over it, or uninstalls it | `copyRuntimeFixture({ runtime, scope })` | a copy, about a quarter of an install |
| puts files in place before the install, or asserts on the installer's own run (exit code, output, a failure) | `runMinimalInstall({ runtime, scope })` | an install |

```javascript
const { installRuntimeFixture, copyRuntimeFixture } = require('./helpers/install-shared.cjs');

test('settings.json registers the hooks', () => {
  const { configDir } = installRuntimeFixture({ runtime: 'augment', scope: 'global' });
  // read-only assertions against configDir
});

test('an uninstall removes the hooks', (t) => {
  const { configDir, root } = copyRuntimeFixture({ runtime: 'augment', scope: 'global' });
  t.after(() => cleanup(root));
  // this tree is the test's own
});
```

| Behavior | Detail |
|---|---|
| Key | `runtime`, `scope`, `extraArgs` (order matters) and `extraEnv` (key order does not). Each distinct key installs once. |
| Lifetime | Under `scripts/run-tests.cjs` (CI, `gsd-test`, `npm test`): the whole run. The trees live under the run's temp root, every test file reads the same ones, and the runner removes them when the run ends. A file started any other way keeps its trees for that one process. |
| Result | The object `runMinimalInstall` returns (`configDir`, `root`, `manifest`, `stdout`, `stderr`). From `installRuntimeFixture` it is deep-frozen and shared. |
| Failure | A failed install throws exactly as `runMinimalInstall` does and is not kept; the next call retries. |
| `root` | Rejected with a `TypeError`. A shared fixture owns its root, and a copy gets a new one. |

**A shared tree is read-only, and the helper checks it.** Every test file of the run reads it, so a
write would change what a file running minutes later sees. The check is a digest taken when the
tree was built: every path, its kind, permission bits and modification time, and each file's size.

- When a test process exits, the helper compares each shared tree it used with that digest. A
  difference fails the process and names the test file and the configuration. The tree was intact
  when the process first read it, so the write happened while that file ran.
- A file that starts later and asks for the changed tree fails at once with
  `SharedFixtureModifiedError`, before it can read anything from it.

The digest does not read file contents. A file rewritten with the same length and given its old
modification time back is not seen. Do not register `t.after(() => cleanup(root))` on a shared
fixture.

**What a shared tree holds does not depend on which file built it.** The installer copies hooks
from `hooks/dist`, which is build output and absent, or partial, in a lane that has not built it.
The fixture helpers call `ensureHooksDist` first, so a file that never needed hooks cannot publish
a tree without them. The builder's `PATH` still reaches the installer, as it does for any install a test
runs.

**A copy stands in for a fresh install.** `copyRuntimeFixture` copies the shared tree to a new root
and writes the new root's name wherever the old one appears, in file contents, symlink targets and
the manifest's hashes. `tests/shared-install-fixture.install.test.cjs` compares a copy with a real
install for every runtime family: the same files and the same content, apart from what each
install draws at random (the heredoc terminator and timestamps). A copy therefore carries its
source's terminator and its files' modification times. A test about either installs for real.

**Each shared configuration costs disk for the whole run:** about 20 MB under the run's temp root,
which the runner's sweep between chunks does not reclaim. Share a configuration that several files
read. A configuration only one test uses is cheaper as that test's own `runMinimalInstall`, removed
when the test ends.

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

## Test architecture policies (ADR 6315)

These come from the CI and test-architecture redesign (`docs/adr/6315-ci-redesign.md`, section 5).
Each item of that epic adds the rule it places on test authors here, in the PR that makes the
change (invariant I11).

### In-process CLI tests: the rules

Since ADR-6315 items 14 and 15, a CLI test runs the command inside the test's own process. That is what made
the suite's CLI tests cheap, and it puts rules on tests and on product code that a process per call used to
hide. Each rule below names what enforces it. Where nothing does yet, the rule says so.

**For tests**

1. **Pick the helper by what the test is about.** `runGsdTools` for a synchronous command,
   `await runGsdToolsAsync` for an asynchronous one, `runGsdToolsProcess` only when the subject is the process
   itself (exit of a real process, signals, real stdin, what a missing working directory does). The in-process
   helpers never spawn as a fallback; each throws and names the helper to use. *Enforced by the helpers.*
   A test that asserts on what a successful command wrote to stderr, or on stdout's exact bytes, calls
   `runGsdToolsCaptured`, which returns `{ exitCode, stdout, stderr }` in-process. `runGsdTools` keeps stderr
   only for a failed command and trims stdout, so it is not the helper for those. *The choice between the two
   is not enforced; found in review.*
2. **A test that needs a real process lives in a `*.process.test.cjs` file and says why in its title.**
   `tests/cli-parity.process.test.cjs` is the model: it starts the real binary on purpose, once per row, so
   that other tests do not have to. The six command suites (`state`, `phase`, `roadmap`, `config`, `init`,
   `custom-phase-readers`) are held to this by ESLint: their `*.test.cjs` files cannot import
   `tests/helpers/process-seam.cjs` or call `runGsdToolsProcess`, so a case whose subject is a process
   (an `ExitError` becoming an exit code, a reader meeting a named pipe) or git itself (the commit a STATE.md
   was written against, allocation across linked worktrees) goes in the suite's `.process.test.cjs` sibling.
   Git used only to build a repository the case needs (`createTempGitProject`, a `gitOrThrow` commit) may stay
   in the unit file: ESLint does not ban `tests/helpers/git-fixture.cjs`. *Enforced by ESLint for those six files; for every other file by review today, and
   ADR-6315 item 20 adds the lint.*
3. **Inject a failure by mocking, not by preloading.** The command runs in your process, so
   `t.mock.method(module, 'fn', …)` on the module the command uses is what the command calls. A per-call
   `NODE_OPTIONS=--require …` does nothing in-process and is refused. *Enforced by the helpers.*
4. **Mock a method once per test.** `node:test` restores mocks in creation order, so mocking the same method
   a second time leaves the first mock installed when the test ends, for every test after it. Re-point the one
   mock with `mock.mockImplementation(…)`. *Not enforced; found in review.*
5. **Do not rely on the command's process ending.** State the command leaves in memory is still there for the
   next call unless a reset is registered for it (rule 8). If a second call in the same file sees the first
   call's state, that is a product defect: fix the product, do not move the test to a spawned call.
6. **When you compare output across two runs, mask what differs by name, not by path.** Two runs get two temp
   directories. The CLI prints a directory in several spellings (backslashes, JSON-escaped backslashes, and
   forward slashes from the commands that emit POSIX paths), and on Windows `fs.realpathSync` keeps an 8.3
   short name that `fs.realpathSync.native` expands. Mask the directory's own name, and build fixture paths
   with `fs.realpathSync.native`. *Covered by a test of the mask in `tests/cli-parity.process.test.cjs`; the
   Windows lanes run only in the merge queue, so a Windows-only mistake here costs a queue ejection.*
7. **A new synchronous call to an asynchronous command fails loudly.** The commands are
   `asyncHostCommandNames()` in `gsd-tools.cjs`, the capability routers named in a module's `asyncRouters`,
   and `run-with-timeout`. *Enforced by `runGsdTools`.*

**For product code, so that it stays testable in-process**

8. **No state computed from the environment when a module loads.** `os.homedir()`, `os.tmpdir()`,
   `process.cwd()` and `process.env` are read when they are used, never into a module-level constant: the
   second command in a process has a different home, temp root or working directory than the first. A
   module-level cache or warned-once set registers a reset with `registerInvocationReset`
   (`src/invocation-scope.cts`). *Covered for the known cases by tests in `tests/in-process-cli.test.cjs`;
   ADR-6315 item 14b (#6354) adds the lint.*
9. **A command router returns the promise of its asynchronous work and is declared asynchronous.** Make it an
   `async function`, or name it in its module's `asyncRouters` (capability routers) or in
   `MAYBE_ASYNC_HOST_COMMANDS`. A router that drops its promise finishes after `main` has returned: the binary
   only works because the event loop is not empty, and an in-process call returns before the output exists.
   *Enforced: an undeclared promise is `in_process_async_started` in a synchronous call, and
   `tests/cli-parity.process.test.cjs` compares every top-level command in-process against the spawned binary.*
10. **A command reads stdin only with `fs.readFileSync(0)` or `fs.readSync(0, …)`.** Those are served from
    `options.stdin` in-process. `process.stdin` as a stream and `/dev/stdin` reach the host's real stdin.
    *Not enforced; no command does otherwise today.*
11. **A new top-level command needs no parity row.** The rows are generated from the dispatch tables, and a
    test requires those tables to match the declared CLI surface. If your command's output holds something
    that differs between two runs other than a temp directory name or a timestamp, extend the mask and the
    mask's own test.

### A parser or reader that must agree with an external tool

Some code exists to give the answer another program gives, without running it: `parseGitConfig` reads a git
config the way git does, and `readGitLayout` reports the checkout and git dirs that `git rev-parse` reports
(ADR-6315 item 25). For code like this:

- **Test it against the tool.** `tests/git-layout-parity.process.test.cjs` builds its fixtures with real git and
  compares the reader's answer with git's for each one; a fast-check property compares the parser with
  `git config --file` over generated files. These are process-contract tests, so the file is a
  `*.process.test.cjs`.
- **The oracle must not share the code's shortcuts.** An earlier version of that property rebuilt git's keys by
  dropping the subsection, exactly as the parser then did, and so could not see that the parser read
  `[core "x"] bare = false` as `core.bare`. Compare on the tool's own output, in full.
- **Answer only where the answer is certain, and hand everything else to the tool.** The reader returns `null`
  for any layout it does not recognise, and git is asked as before. Being stricter than the tool only costs
  speed. Being looser is a defect: review found a planted `.git`, a quoted `bare = "true"` and an unsupported
  repository format, each of which an early version accepted and git refuses.
- **Pin which side answered.** Each fixture row states whether the reader or the tool must answer, so a layout
  cannot move from one to the other without the test changing.
- **Never block and never throw.** A file is opened only after `lstat` says it is a regular file, and opened
  non-blocking: a FIFO planted where a config file is expected would otherwise hang every call. The tool this
  replaces ran under a timeout.

### A test does not start an external tool it is not testing

A test of code that calls `npm`, `gh`, `docker` or another external tool does not start the real
tool, unless the tool's own behavior is what the test asserts (the tarball smoke test and the
install-contract tests do). The real tool's start-up time is outside the test's control: a cold
`npm` on a Windows runner took longer than the 30 s a spawned `check-env.cjs` test allowed, and
the merge queue ejected a docs-only PR for it (#6375).

- **Logic** is tested in-process. The code takes its process runner as a required argument
  (`collectChecks({ run })` in `scripts/check-env.cjs`; only the CLI entry passes `spawnSync`),
  and the test passes a stand-in that returns a recorded result. The runner has no default, so a
  test that forgets it gets a `TypeError`, not the real tool. The stand-in throws on a call the
  test did not plan, and the test asserts the argument list the code sent, because that list is
  the code's whole contract with the tool.
- **The process boundary** (exit code, `--json` on stdout, which stream an error goes to) is
  tested in a `*.process.test.cjs` file with a stand-in executable on the child's PATH and the
  real tool removed from it: `isolatedPath({ without: ['npm', 'npm.cmd'] })`, then the stand-in's
  directory in front. The stand-in logs its arguments; each test that reaches the tool reads the
  log, which proves the stand-in answered. Ship both a POSIX script and a `.cmd`, since Windows runs `npm.cmd` through
  the shell.
- A script that runs its CLI at load cannot be tested in-process. Export the logic and run `main`
  under `require.main === module`.

Raising the spawn limit is not the fix (ADR-6315 invariant I4).

### A skip for a missing host tool is announced, and a host can make it fail

A test that runs a documented bash block needs `bash`, and sometimes `curl`, `jq` or `node`. It
gates on `skipUnless('bash', 'jq')` from `tests/helpers/bash-probe.cjs`, never on a bare
`skip: 'reason'` literal, so the decision has one owner and one test (`tests/bash-probe.test.cjs`).

- A tool present: the suite runs.
- A tool missing under `CI`, or under `GSD_REQUIRE_BASH_TOOLS`: the file fails at load. A skipped
  suite there would report green having executed nothing.
- A tool missing anywhere else: the suite skips, and the skip is announced as a named skipped test
  (`bash-block behavior tests skipped on this host: ...`), so it shows in the run summary and the
  reporter events. A skipped `describe` registers none of its children, so without that line a
  skip leaves no trace: the gsd-test tester image has no `curl` or `jq`, and those suites' bash-block
  tests skipped on it with `skipped 0` in the verdict (#6677).

A host that is not CI but must not skip sets `GSD_REQUIRE_BASH_TOOLS=1`
([docs/how-to/make-a-missing-test-tool-fail.md](docs/how-to/make-a-missing-test-tool-fail.md)).
A new gate on a host capability goes through `skipUnless`, so it inherits the announcement.

### A git fixture is a copy of a template

`createFixture({ git: true })`, and so `createTempGitProject`, no longer runs git. Each of the four
shapes a caller can ask for (with or without `.planning/phases`, with or without `PROJECT.md`) is
built once, by the six git commands the fixture always used, and a fixture is a copy of that
template (#6336). Inside a test run the templates are shared by every test file, in the same store
as the installed trees above.

What a test may rely on is unchanged: a repository on `master` with one commit, `initial commit`,
by `Test <test@test.com>`, with signing off. `tests/git-fixture-template.process.test.cjs` holds a
copy against a repository built by hand for every shape.

Three things are different, and a test must not depend on the old behavior:

- **Every fixture of a shape in one run has the same commit hash and commit time.** A test that
  needs two repositories with different histories makes a commit in one.
- **The repository's config has `core.trustctime = false` and `core.checkStat = minimal`.** A copy
  has new inode numbers and change times, and without these git's plumbing (`diff-files`,
  `diff-index`) reports a clean copy as modified until something refreshes the index.
- **The template is built with no inherited `GIT_*` variable, no system config, an empty global
  config and an empty init template**, so it does not depend on the machine or on which test file
  built it. `.git/hooks` and `.git/info` exist and are empty: there are no sample hooks and no
  `info/exclude`, whatever the machine's git ships (a developer's git can carry `.planning` in
  that exclude file, #5470). A test that needs a repository shaped by a particular git setup
  builds that repository itself.

Do not write into a template (`gitTemplateRoot`). A test process that changes one fails at exit.

---

## ESLint rule reference

| Rule | Severity | What it catches |
|---|---|---|
| `local/no-source-grep` | `error` (promoted by #3313) | `readFileSync` on source files + text assertions; `assert.match`/`doesNotMatch` on raw stdout/stderr |
| `local/no-magic-sleep-in-tests` | `error` | `setTimeout`/`sleep`/`delay` calls inside `test()`/`it()`/`describe()` bodies |
| `local/no-elapsed-assertion` | `error` (promoted by #3331, precondition delivered by #3314) | Assertions on `Date.now()` delta, `process.hrtime()`, `performance.now()` comparisons |
| `local/no-adhoc-timeout-literal` | `error` | Bare numeric `timeout`/`timeoutMs` option literal in `tests/**/*.cjs` (PR #4428) |
| `local/no-adhoc-env-isolation` | `error` (no options; allowlist retired by #6040) | A hand-written PATH split/filter or HOME/USERPROFILE env in `tests/**/*.cjs`; `tests/helpers/isolated-env.cjs` is the only route and the only exempt file |
| `no-only-tests/no-only-tests` | `error` | `test.only`/`describe.only`/`it.only` committed to non-scratch files |
| `no-restricted-syntax` (ban 1) | `error` | Top-level `setTimeout` in `ExpressionStatement` |
| `no-restricted-syntax` (ban 2) | `error` | `.only` member access on `test`/`it`/`describe` (belt-and-suspenders) |

`local/no-source-grep` and `local/no-magic-sleep-in-tests` ship at `error` (promoted by [#3313](https://github.com/open-gsd/gsd-core/issues/3313), absorbing the cleanup sweep originally tracked at #453). `local/no-elapsed-assertion` now also ships at `error` (promoted by [#3331](https://github.com/open-gsd/gsd-core/issues/3331)) — [#3314](https://github.com/open-gsd/gsd-core/issues/3314) delivered its precondition first (ADR-456 §(a) amended with a reachability-based 3-mechanism rule; `commands.cts`/`init.cts`/`io.cts` backfilled with deterministic coverage), mirroring the same handover boundary the epic draws for its other items. New violations added after the acceptance of ADR 456 are out of policy regardless of ESLint severity.

ESLint harness details: [`docs/adr/452-eslint-lint-harness.md`](docs/adr/452-eslint-lint-harness.md).

---

## Markdownlint compliance

This file uses fenced code blocks with explicit language tags (`javascript`, `text`) as required by MD040. All tables use consistent column counts (MD056).
