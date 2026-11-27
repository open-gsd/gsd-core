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

- `node-throws-regexp.tap`, `node-rejects-regexp.tap`,
  `node-throws-regexp-nested.tap` (captured 2026-11-04, Node 24.19.0): the
  standard RED shape for a "should reject X" test — `assert.throws(fn, /re/)`
  or `await assert.rejects(promise, /re/)` where the thrown message does not
  match, so the assertion itself fails (#5819). node:test repeats `error` and
  `stack` in that test's diagnostic block, which strict YAML rejects as
  duplicate mapping keys. The nested capture wraps the same test in
  `describe('token validation', …)` so the diagnostic block arrives indented.
  Source (`throws-red.test.cjs`; the others vary only in assertion/structure;
  excerpt abridged — the captured file carries ~5 preamble lines, hence the
  `8:1`/`9:31` locations):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('rejects a malformed token', () => {
  assert.throws(() => { throw new Error('boom: token accepted'); }, /rejected token/);
});
```

  Command: `node --test --test-reporter=tap <file>.test.cjs` (exit 1 each). The
  capture machine's absolute source paths (`D:\AI\…`) were neutralized to
  `C:\work\repro\…` (Windows-style, backslashes kept) in `location:` and stack
  lines. Test names, source line numbers and TAP structure were preserved.
  The counts and SHA-256 hashes below use the Git blobs with LF line endings.

| Fixture | Lines | SHA-256 |
| --- | ---: | --- |
| `node-throws-regexp.tap` | 44 | `6e9dc19cee65317fea3eb70dce5d4a6e8b3322f7ccc9f35762764c271deeb8ed` |
| `node-rejects-regexp.tap` | 39 | `173cabd84fd6c5515cfefd85d2e7f92fb435e4b53a5dd3f4487faa3291679abb` |
| `node-throws-regexp-nested.tap` | 62 | `ccdd9de0f10cb117247acf5a558cdf3fd582db59aa4a7751d85be8cf1f889c17` |

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

- `pytest-red.xml`, `pytest-collection-error.xml`, `pytest-setup-error.xml`,
  `pytest-teardown-error.xml`, `pytest-red-teardown-error.xml`,
  `pytest-class-red.xml` (#6641): written by `regen-pytest.sh` in this
  directory, which holds the exact test sources, runs each one alone in a fresh
  temporary directory with
  `python -m pytest -q -p no:cacheprovider <file> --junitxml=<report>`
  (pytest 9.2.0 through `uv`), checks the exit status (1, except 2 for the
  collection error) and applies the only rewrites: the capture directory to
  `/tmp/capture`, the interpreter's base prefix to `/usr`, the hostname to
  `capture-host`, the suite timestamp to `2026-11-24T00:00:00.000000+00:00`,
  every `time` duration to `0.000`, and an `object at 0x…` address to `0x0`.
  A rerun with the same pytest reproduces the files byte for byte. The first
  five were captured on 2026-11-24 with CPython 3.14.9 and are unchanged by the
  regeneration with CPython 3.14.4 except for the normalised timestamp and
  durations. Sources: `test_evidence.py` (`test_target` asserts `1 == 2`,
  `test_other` passes); `test_collect.py` (`from os import NO_SUCH_NAME` at
  module top); `test_setup.py` (a fixture that raises before `yield`; the test
  passes); `test_teardown.py` (a fixture that raises after `yield`; the test
  passes); `test_red_teardown.py` (the same fixture; the test asserts `1 == 2`,
  so pytest writes two `<testcase>` entries for it); `tests/test_widget.py`
  (`TestWidget.test_x` and the parametrized `test_param[a-1]` both assert
  `1 == 2`; classnames `tests.test_widget.TestWidget` and `tests.test_widget`).
