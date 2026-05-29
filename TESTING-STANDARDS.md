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

**Enforcement:** `local/no-source-grep` (ESLint, currently `warn`; becomes `error` after issue #453 merges).

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

**Enforcement:** `local/no-elapsed-assertion` (ESLint, currently `warn`; becomes `error` after issue #453 merges). Also `no-restricted-syntax` ban on `performance.now()` comparisons in assertions.

### Clock-seam pattern for concurrency

Concurrency logic must be tested via an injectable clock seam backed by `node:test` `mock.timers`. Real OS scheduler races are non-deterministic on loaded CI runners and are not a permitted test pattern.

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

**Enforcement:** `local/no-magic-sleep-in-tests` (bans `setTimeout`/`sleep`/`delay` inside test bodies; ESLint, currently `warn`; becomes `error` after issue #453 merges). Code review catches the race pattern directly.

### Property-based testing tier

Modules that implement parsing, transformation, budget/limit logic, or any bijective contract must include at least one `fast-check` (`fc`) property test asserting a domain invariant. Property tests live in `*.test.cjs` files alongside unit tests; no separate suite tag is required.

Invariant categories to consider: round-trip, monotonicity, boundary containment, idempotency.

**Threshold:** No hard per-file threshold is enforced by CI tooling; the gate is Stryker mutation score (see below). Property tests are the mechanism that drives mutation score above the threshold on logic-heavy paths.

**Enforcement:** Code review verifies that property tests exist for modules in scope. Stryker mutation score below 80 % blocks merge (see next section).

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
| `local/no-source-grep` | `warn` → `error` (#453) | `readFileSync` on source files + text assertions; `assert.match`/`doesNotMatch` on raw stdout/stderr |
| `local/no-magic-sleep-in-tests` | `warn` → `error` (#453) | `setTimeout`/`sleep`/`delay` calls inside `test()`/`it()`/`describe()` bodies |
| `local/no-elapsed-assertion` | `warn` → `error` (#453) | Assertions on `Date.now()` delta, `process.hrtime()`, `performance.now()` comparisons |
| `no-only-tests/no-only-tests` | `error` | `test.only`/`describe.only`/`it.only` committed to non-scratch files |
| `no-restricted-syntax` (ban 1) | `error` | Top-level `setTimeout` in `ExpressionStatement` |
| `no-restricted-syntax` (ban 2) | `error` | `.only` member access on `test`/`it`/`describe` (belt-and-suspenders) |

All three `local/*` rules currently ship at `warn`. They become `error` after the cleanup sweep tracked at [#453](https://github.com/open-gsd/get-shit-done-redux/issues/453) merges. New violations added after the acceptance of ADR 456 are out of policy regardless of the current ESLint severity.

ESLint harness details: [`docs/adr/452-eslint-lint-harness.md`](docs/adr/452-eslint-lint-harness.md).

---

## Markdownlint compliance

This file uses fenced code blocks with explicit language tags (`javascript`, `text`) as required by MD040. All tables use consistent column counts (MD056).
