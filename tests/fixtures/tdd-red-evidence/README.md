# Real reporter fixtures (#4692)

Captured unchanged with Node 24.20.0 and Vitest 5.0.1. Each run exited 1.
Timing and temporary source paths are captured data, not matching criteria.

The Vitest source was `evidence.test.js`:

```js
import { describe, it, expect } from 'vitest';
describe('email validation', () => {
  it('rejects empty email', () => { expect(1).toBe(2); });
  it('accepts valid email', () => { expect(1).toBe(1); });
});
```

- `vitest.tap`: `vitest run evidence.test.js --reporter=tap`
- `vitest-flat.tap`: `vitest run evidence.test.js --reporter=tap-flat`
- `vitest-no-tests.tap`, `vitest-load-error.tap`, `vitest-green.tap` (captured
  2026-10-02, same versions): `vitest run --reporter=tap` on a path with no test
  file (exit 1), on a file that imports a missing module (exit 1), and on the
  suite above with both tests passing (exit 0).
- `node.tap`: `node --test --test-reporter=tap evidence.node.cjs`, with the same
  suite/test names, `node:test`'s `describe`/`it`, and `node:assert/strict`'s
  `assert.equal(1, 2)` / `assert.equal(1, 1)`.

These commands were exposed through the capture project's npm scripts and run
with `npm run --silent` so the stored stdout is the original reporter stream.
Vitest is not needed to run GSD's regression suite.

## Other formats

Captured unchanged on 2026-10-02; each run exited 1. Paths, timings and JVM
properties are captured data, not matching criteria.

- `surefire-TEST-example.AppTest.xml`: Maven 3.9 (`maven:3.9-eclipse-temurin-21`
  image, Temurin 21.0.12), maven-surefire-plugin 3.5.2, JUnit Jupiter 5.11.4,
  `mvn -B -q test`, the report file Surefire wrote to `target/surefire-reports/`.
  `example.AppTest` has `rejectsEmptyEmail` (`assertEquals(2, 1)`),
  `acceptsValidEmail` (`assertEquals(1, 1)`) and `normalizesCase`
  (`@Disabled("not yet")`).
- `swift-testing.txt`: Swift 6.1.3 (`swift:6.1` image), swift-testing 6.1.3,
  stdout and stderr of `swift test --skip-build` after `swift build --build-tests`.
  `DemoTests.swift` has `@Test func addsNumbers()` (fails), `@Test("Adds zero")
  func addsZero()` (passes), `@Test(.disabled("not yet")) func subtracts()` and
  `@Test(arguments: [1, 2]) func addsToItself(n:)` (fails for both arguments);
  `add` returns 0.
- `unittest.txt`: Python 3.14.4, `NO_COLOR=1 python3 -m unittest discover -s tests -v`.
  `test_demo.AddTest` has `test_adds_two_numbers` (fails in two subTests),
  `test_adds_zero` (passes), `test_subtracts` (`@unittest.skip`) and
  `test_known_bug` (`@unittest.expectedFailure`, passes); `add` returns 0.
- `unittest-load-error.txt`: the same command with a test module whose import
  fails (`import missing_module`).
