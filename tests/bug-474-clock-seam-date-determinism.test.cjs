// allow-test-rule: source-text-is-the-product
// STATE.md is the product surface; assertions on its text content test the
// deployed contract (date field written by the subprocess SUT).

'use strict';

/**
 * Bug #474 — clock seam: subprocess date-stamping must be deterministic.
 *
 * Tests in this file verify that:
 *   1. state.cjs date-stamping is routed through realClock (not bare new Date()),
 *      so GSD_NOW_MS pins the written date deterministically in subprocess tests.
 *   2. installer-migrations.cjs lock-loop timeout fires deterministically via
 *      the clock seam (in-process, using makeFakeClock — no subprocess needed).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, cleanup } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const { makeFakeClock } = require('./helpers/clock.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// §1  Subprocess date-pin: state advance-plan writes the pinned date
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why advance-plan?
 *   cmdStateAdvancePlan captures `const today = new Date().toISOString().split('T')[0]`
 *   and writes it to "Last Activity" via stateReplaceFieldIfTemplate.
 *   The fixture below has Last Activity = 2024-01-10 (an ISO date, treated as a
 *   handler-generated template default by isStateTemplateDefault), so the field IS
 *   overwritten — making this the simplest single-subcommand probe of the bug.
 */

// A fixed historical instant far in the past — will NEVER match today's real date.
const PINNED_MS = Date.parse('2020-06-15T12:00:00.000Z');
const PINNED_DATE = '2020-06-15';

// A minimal STATE.md that satisfies advance-plan's parser:
//   - Current Plan: 1  (not on last plan → normal-advance branch)
//   - Total Plans in Phase: 3
//   - Last Activity: 2024-01-10  (ISO date → isStateTemplateDefault returns true → will be replaced)
const ADVANCE_FIXTURE = [
  '# Project State',
  '',
  '**Current Plan:** 1',
  '**Total Plans in Phase:** 3',
  '**Status:** Executing',
  '**Last Activity:** 2024-01-10',
].join('\n') + '\n';

describe('bug-474: state date-stamping is pinned by GSD_NOW_MS', () => {
  let tmpDir;

  before(() => {
    // AAA — Arrange: create a temp project with the advance fixture
    tmpDir = createFixture();
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), ADVANCE_FIXTURE);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('state advance-plan writes pinned date (not real today) when GSD_NOW_MS is set', () => {
    // AAA — Act: run advance-plan with a pinned historical timestamp
    const result = runGsdTools('state advance-plan', tmpDir, {
      GSD_TEST_MODE: '1',
      GSD_NOW_MS: String(PINNED_MS),
    });

    assert.ok(result.success, `advance-plan failed unexpectedly: ${result.error}`);

    // AAA — Assert: the written STATE.md must contain the pinned date
    const written = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    // Must contain the pinned historical date (2020-06-15)
    assert.ok(
      written.includes(PINNED_DATE),
      `Expected STATE.md to contain pinned date ${PINNED_DATE}.\nActual STATE.md:\n${written}`,
    );

    // Must NOT contain today's real date — that would mean the seam is bypassed
    const realToday = new Date().toISOString().split('T')[0];
    assert.ok(
      !written.includes(realToday),
      `Expected STATE.md NOT to contain real today (${realToday}) when time is pinned.\nActual STATE.md:\n${written}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2  realClock GSD_NOW_MS invalid-input hardening
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that malformed / out-of-range GSD_NOW_MS values fall back to the real
 * clock instead of crashing with RangeError (issue #474 hardening).
 *
 * Each invalid input must:
 *   a) not throw from realClock.nowIso(), and
 *   b) produce a valid parseable ISO string (i.e. fell back to Date.now()).
 *
 * A valid pinned value must produce the expected date string.
 */

describe('bug-474: realClock GSD_NOW_MS invalid-input hardening', () => {
  const realClock = require('../gsd-core/bin/lib/clock.cjs').realClock;

  // Save and restore env so these tests cannot bleed into neighbouring tests.
  let savedTestMode;
  let savedNowMs;

  before(() => {
    savedTestMode = process.env.GSD_TEST_MODE;
    savedNowMs = process.env.GSD_NOW_MS;
    process.env.GSD_TEST_MODE = '1';
  });

  after(() => {
    if (savedTestMode === undefined) {
      delete process.env.GSD_TEST_MODE;
    } else {
      process.env.GSD_TEST_MODE = savedTestMode;
    }
    if (savedNowMs === undefined) {
      delete process.env.GSD_NOW_MS;
    } else {
      process.env.GSD_NOW_MS = savedNowMs;
    }
  });

  // AAA matrix: each invalid value must NOT crash and must fall back to the real clock.
  const INVALID_INPUTS = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['alphabetic', 'abc'],
    ['scientific notation', '1e30'],
    ['decimal float', '12.5'],
    ['integer > 8.64e15', '99999999999999999999'],
  ];

  for (const [label, value] of INVALID_INPUTS) {
    test(`GSD_NOW_MS='${value}' (${label}) falls back to real clock — no crash, valid ISO`, () => {
      // AAA — Arrange
      process.env.GSD_NOW_MS = value;

      // AAA — Act + Assert: must not throw
      assert.doesNotThrow(
        () => realClock.nowIso(),
        `realClock.nowIso() must not throw for GSD_NOW_MS='${value}'`,
      );

      // AAA — Assert: result is a valid ISO string (fell back to real clock)
      const iso = realClock.nowIso();
      assert.ok(
        !Number.isNaN(Date.parse(iso)),
        `realClock.nowIso() must return a valid ISO date for GSD_NOW_MS='${value}', got: ${iso}`,
      );
    });
  }

  test('GSD_NOW_MS valid decimal integer pins the clock', () => {
    // AAA — Arrange: a known historical epoch
    process.env.GSD_NOW_MS = String(PINNED_MS);

    // AAA — Act
    const tod = realClock.today();

    // AAA — Assert
    assert.strictEqual(tod, PINNED_DATE, `realClock.today() must return pinned date ${PINNED_DATE}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3  In-process lock-loop: installer-migrations timeout fires deterministically
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This test exercises acquireInstallMigrationLock's EEXIST retry loop via a
 * makeFakeClock.  The approach:
 *   - Write a lock file held by PID 1 (init/launchd — always alive on any OS)
 *     so neither isSameProcess nor isDeadProcess is true; stale-lock reclamation
 *     is NOT triggered, and the loop must reach the timeout check.
 *   - Use TIMEOUT_MS = 500 (non-zero) so the loop must retry at least once before
 *     the injected clock trips the deadline.  A zero timeout would fire on the
 *     very first check without exercising clock.sleep() at all.
 *   - The fake clock's sleep(ms) ADVANCES its internal now by ms (confirmed from
 *     helpers/clock.cjs implementation), so the loop drives itself to termination
 *     purely through the injected clock without any wall-clock delay.
 *   - Post-throw assertions on clock.sleepCalls and clock.now() prove the seam:
 *     if the loop reverted to raw Date.now()/sleepSync, sleepCalls would be 0.
 */

describe('bug-474: installer-migrations lock-loop timeout is deterministic via clock seam', () => {
  test('makeFakeClock nowIso() and today() derive from pinned now()', () => {
    // AAA — Arrange
    const clock = makeFakeClock(PINNED_MS);

    // AAA — Act
    const iso = clock.nowIso();
    const tod = clock.today();

    // AAA — Assert
    assert.strictEqual(iso, '2020-06-15T12:00:00.000Z', 'nowIso() must return ISO string of pinned epoch');
    assert.strictEqual(tod, PINNED_DATE, 'today() must return YYYY-MM-DD of pinned epoch');
  });

  test('makeFakeClock advance() shifts nowIso() and today()', () => {
    // AAA — Arrange: start at PINNED_MS, advance by 24 h
    const clock = makeFakeClock(PINNED_MS);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    // AAA — Act
    clock.advance(ONE_DAY_MS);

    // AAA — Assert
    assert.strictEqual(clock.today(), '2020-06-16', 'today() must reflect advanced time');
  });

  test('acquireInstallMigrationLock timeout path fires deterministically via makeFakeClock', (t) => {
    // AAA — Arrange
    const os = require('os');
    const { acquireInstallMigrationLock } = require('../gsd-core/bin/lib/installer-migrations.cjs');
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-474-lock-'));

    t.after(() => {
      cleanup(configDir);
    });

    const LOCK_NAME = 'gsd-install-migration.lock';
    const lockPath = path.join(configDir, LOCK_NAME);

    // Write a lock file held by process.ppid (the parent process, always alive
    // and never equal to process.pid on every platform).  pid 1 was used
    // previously but isPidAlive(1) returns false on Windows (no init/launchd
    // pid-1 concept), so the lock was treated as stale, reclaimed, and
    // acquireInstallMigrationLock succeeded instead of throwing — failing the
    // timeout assertion on windows-latest,22 (#474).  process.ppid is a live,
    // non-self process on all platforms, so the lock is correctly seen as held
    // and the timeout path throws deterministically cross-platform.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.ppid, acquiredAt: new Date().toISOString() }) + '\n',
    );

    // TIMEOUT_MS is non-zero so the first EEXIST iteration does NOT immediately
    // trip the deadline.  The loop must call clock.sleep() at least once; that
    // sleep() advances the fake clock past TIMEOUT_MS, causing the next check to
    // throw.  This proves the seam: if the loop used raw Date.now()/sleepSync,
    // clock.sleepCalls would remain 0.
    const TIMEOUT_MS = 500;
    const clock = makeFakeClock(0);

    // AAA — Act + Assert: timeout error thrown with no real wall-clock delay
    assert.throws(
      () => acquireInstallMigrationLock(configDir, { timeoutMs: TIMEOUT_MS }, clock),
      /lock|held/i,
      'Expected acquireInstallMigrationLock to throw with "lock"/"held" in message on timeout',
    );

    // AAA — Assert seam was actually exercised through the injected clock:
    // If the loop used raw sleepSync instead of clock.sleep(), sleepCalls would be 0.
    assert.ok(
      clock.sleepCalls.length > 0,
      'loop must retry via injected clock.sleep() — proves seam wiring, not raw wall clock',
    );

    // The injected clock must have advanced past TIMEOUT_MS through its own sleep() calls.
    assert.ok(
      clock.now() >= TIMEOUT_MS,
      `injected clock advanced past timeout deterministically: clock.now()=${clock.now()} must be >= TIMEOUT_MS=${TIMEOUT_MS}`,
    );
  });
});
