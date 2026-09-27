'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { ExitError } = require('../scripts/lib/cli-exit.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-npm-publish.cjs');
const {
  verifyPublish,
  REASON,
  parseArgs,
  defaultFetchVersion,
  defaultFetchDistTag,
  DEFAULT_WINDOW_MS,
  DEFAULT_INTERVAL_MS,
  DIST_TAG_MAX_ATTEMPTS,
  DIST_TAG_WINDOW_MS,
  NPM_VIEW_TIMEOUT_MS,
} = require(SCRIPT);

// ---- Helpers -----------------------------------------------------------------

function makeFetchVersion(sequence) {
  let i = 0;
  return () => sequence[Math.min(i++, sequence.length - 1)];
}

function makeSleepSpy() {
  let sleeps = 0;
  const sleep = async () => { sleeps++; };
  const count = () => sleeps;
  return { sleep, count };
}

// A fake wall clock: now() returns the current virtual clock reading,
// sleep(sleepArg) advances the clock by sleepArg and records it (a real
// retry delay), and advance(sleepArg) moves the clock forward without
// recording it (simulating time spent inside a slow/hung fetch call).
// All #5021 window tests inject both now and sleep from one of these —
// never assert against real elapsed time.
function makeFakeClock() {
  let clockMs = 0;
  const recorded = [];
  const now = () => clockMs;
  const sleep = async (sleepArg) => { clockMs += sleepArg; recorded.push(sleepArg); };
  const advance = (deltaMs) => { clockMs += deltaMs; };
  const slept = () => recorded.reduce((sum, sleepArg) => sum + sleepArg, 0);
  const calls = () => recorded.slice();
  return { now, sleep, advance, slept, calls };
}

// ---- Tests -------------------------------------------------------------------

describe('verifyPublish', () => {
  test('returns OK on first attempt when version is already live', async () => {
    const { sleep, count } = makeSleepSpy();
    const fetchVersion = makeFetchVersion(['1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion([null]);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, REASON.OK_VERSION_LIVE);
    assert.equal(result.attempts, 1);
    assert.equal(count(), 0);
  });

  test('retries through propagation lag and succeeds once the version appears', async () => {
    const { sleep, count } = makeSleepSpy();
    const fetchVersion = makeFetchVersion([null, null, '1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion([null]);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(count(), 2);
  });

  test('fails after exhausting maxAttempts when version never appears', async () => {
    const { sleep, count } = makeSleepSpy();
    const fetchVersion = makeFetchVersion([null]);
    const fetchDistTag = makeFetchVersion([null]);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      maxAttempts: 4,
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.FAIL_VERSION_NOT_FOUND);
    assert.equal(result.attempts, 4);
    assert.equal(count(), 3);
  });

  test('reports dist-tag pointer informationally without affecting ok', async () => {
    const { sleep, count } = makeSleepSpy();
    const fetchVersion = makeFetchVersion(['1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion(['1.3.0-rc.1']);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      distTag: 'next',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.distTag, {
      name: 'next',
      points_to: '1.3.0-rc.1',
      matches: true,
    });
    void count;
  });

  test('dist-tag mismatch is a warning, not a failure', async () => {
    const { sleep } = makeSleepSpy();
    const fetchVersion = makeFetchVersion(['1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion(['1.2.0']);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      distTag: 'latest',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.distTag.matches, false);
    assert.equal(result.distTag.points_to, '1.2.0');
  });

  test('no dist-tag requested yields null distTag', async () => {
    const { sleep } = makeSleepSpy();
    const fetchVersion = makeFetchVersion(['1.3.0-rc.1']);
    const fetchDistTag = makeFetchVersion([null]);

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.3.0-rc.1',
      fetchVersion,
      fetchDistTag,
      sleep,
      intervalMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.distTag, null);
  });
});

describe('#5021: verify window covers npm processing delay (wall-clock, not attempt-counted)', () => {
  test('observed lag (~6.5 min) passes with defaults', async () => {
    const clock = makeFakeClock();
    // Mirrors the incident: npm view keeps returning "not found" until
    // enough time has elapsed (6.5 min observed), then the version resolves.
    const fetchVersion = () => (clock.now() >= 390_000 ? '1.15.0' : null);
    const fetchDistTag = () => '1.15.0';

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.15.0',
      fetchVersion,
      fetchDistTag,
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, REASON.OK_VERSION_LIVE);
  });

  test('window floor: total wait before giving up is at least the default window', async () => {
    const clock = makeFakeClock();
    const fetchVersion = () => null;

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.15.0',
      fetchVersion,
      fetchDistTag: () => null,
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.equal(result.ok, false);
    // Fast fetches: attempts at t=0,10s,...,600s => one more than the number
    // of full intervals that fit in the window.
    assert.equal(result.attempts, DEFAULT_WINDOW_MS / DEFAULT_INTERVAL_MS + 1);
    assert.ok(
      clock.slept() >= DEFAULT_WINDOW_MS,
      `expected total sleep >= ${DEFAULT_WINDOW_MS}ms, got ${clock.slept()}`
    );
  });

  test('boundary on the deadline (limit-1 / limit / limit+1)', async () => {
    for (const appearAtMs of [
      DEFAULT_WINDOW_MS - DEFAULT_INTERVAL_MS,
      DEFAULT_WINDOW_MS,
      DEFAULT_WINDOW_MS + DEFAULT_INTERVAL_MS,
    ]) {
      const clock = makeFakeClock();
      const fetchVersion = () => (clock.now() >= appearAtMs ? '1.15.0' : null);

      const result = await verifyPublish({
        pkg: '@opengsd/gsd-core',
        version: '1.15.0',
        fetchVersion,
        fetchDistTag: () => null,
        sleep: clock.sleep,
        now: clock.now,
      });

      if (appearAtMs <= DEFAULT_WINDOW_MS) {
        assert.equal(result.ok, true, `expected ok at appearAtMs=${appearAtMs}`);
      } else {
        assert.equal(result.ok, false, `expected fail at appearAtMs=${appearAtMs}`);
      }
    }
  });

  test('hung registry is bounded: every fetchVersion call timing out cannot blow the window', async () => {
    const clock = makeFakeClock();
    const fetchVersion = () => { clock.advance(NPM_VIEW_TIMEOUT_MS); return null; };

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.15.0',
      fetchVersion,
      fetchDistTag: () => null,
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.equal(result.ok, false);
    assert.ok(
      clock.now() <= DEFAULT_WINDOW_MS + NPM_VIEW_TIMEOUT_MS + DEFAULT_INTERVAL_MS,
      `expected clock <= ${DEFAULT_WINDOW_MS + NPM_VIEW_TIMEOUT_MS + DEFAULT_INTERVAL_MS}, got ${clock.now()}`
    );
  });

  test('dist-tag phase bounded by attempts', async () => {
    const clock = makeFakeClock();
    const fetchVersion = makeFetchVersion(['1.15.0']);
    const fetchDistTag = () => null;

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.15.0',
      distTag: 'latest',
      fetchVersion,
      fetchDistTag,
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.equal(result.ok, true);
    assert.equal(result.distTag.points_to, null);
    assert.equal(clock.calls().length, DIST_TAG_MAX_ATTEMPTS - 1);
  });

  test('dist-tag phase bounded by time', async () => {
    const clock = makeFakeClock();
    const fetchVersion = makeFetchVersion(['1.15.0']);
    const fetchDistTag = () => { clock.advance(NPM_VIEW_TIMEOUT_MS); return null; };

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.15.0',
      distTag: 'latest',
      fetchVersion,
      fetchDistTag,
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.equal(result.ok, true);
    assert.ok(
      clock.now() <= DIST_TAG_WINDOW_MS + NPM_VIEW_TIMEOUT_MS + DEFAULT_INTERVAL_MS,
      `expected clock <= ${DIST_TAG_WINDOW_MS + NPM_VIEW_TIMEOUT_MS + DEFAULT_INTERVAL_MS}, got ${clock.now()}`
    );
  });

  test('explicit maxAttempts still caps within the window', async () => {
    const clock = makeFakeClock();
    const fetchVersion = () => null;

    const result = await verifyPublish({
      pkg: '@opengsd/gsd-core',
      version: '1.15.0',
      fetchVersion,
      fetchDistTag: () => null,
      sleep: clock.sleep,
      now: clock.now,
      maxAttempts: 3,
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 3);
  });

  test('CLI defaults match DEFAULT_WINDOW_MS / DEFAULT_INTERVAL_MS / unlimited maxAttempts', () => {
    const opts = parseArgs(['--package', '@opengsd/gsd-core', '--version', '1.15.0']);
    assert.equal(opts.windowMs, DEFAULT_WINDOW_MS);
    assert.equal(opts.intervalMs, DEFAULT_INTERVAL_MS);
    assert.equal(opts.maxAttempts, Infinity);
  });

  test('--window-ms parses a positive integer', () => {
    const opts = parseArgs(['--package', '@opengsd/gsd-core', '--version', '1.15.0', '--window-ms', '5000']);
    assert.equal(opts.windowMs, 5000);
  });

  test('--window-ms rejects zero, negative, and non-numeric values', () => {
    for (const bad of ['0', '-1', 'abc']) {
      assert.throws(
        () => parseArgs(['--package', '@opengsd/gsd-core', '--version', '1.15.0', '--window-ms', bad]),
        (err) => err instanceof ExitError && err.code === 2
      );
    }
  });

  test('--help text reflects the window and interval defaults', () => {
    const originalWrite = process.stdout.write;
    let helpText = '';
    process.stdout.write = (chunk) => { helpText += chunk; return true; };

    let thrown;
    try {
      parseArgs(['--help']);
    } catch (err) {
      thrown = err;
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.ok(thrown instanceof ExitError);
    assert.equal(thrown.code, 0);
    assert.ok(helpText.includes(`(default: ${DEFAULT_WINDOW_MS})`));
    assert.ok(helpText.includes(`(default: ${DEFAULT_INTERVAL_MS})`));
  });

  test('defaultFetchVersion bounds its npm subprocess and degrades on timeout', () => {
    const calls = [];
    const spy = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return '1.15.0\n'; };

    const version = defaultFetchVersion('@opengsd/gsd-core', '1.15.0', { execFileSync: spy });

    assert.equal(version, '1.15.0');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['view', '@opengsd/gsd-core@1.15.0', 'version']);
    assert.equal(calls[0].opts.timeout, NPM_VIEW_TIMEOUT_MS);

    const timingOutSpy = () => {
      const err = new Error('timed out');
      err.code = 'ETIMEDOUT';
      throw err;
    };
    assert.equal(defaultFetchVersion('@opengsd/gsd-core', '1.15.0', { execFileSync: timingOutSpy }), null);
  });

  test('defaultFetchDistTag bounds its npm subprocess and degrades on timeout', () => {
    const calls = [];
    const spy = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return '{"latest":"1.15.0"}'; };

    const distTag = defaultFetchDistTag('@opengsd/gsd-core', 'latest', { execFileSync: spy });

    assert.equal(distTag, '1.15.0');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['view', '@opengsd/gsd-core', 'dist-tags', '--json']);
    assert.equal(calls[0].opts.timeout, NPM_VIEW_TIMEOUT_MS);

    const timingOutSpy = () => {
      const err = new Error('timed out');
      err.code = 'ETIMEDOUT';
      throw err;
    };
    assert.equal(defaultFetchDistTag('@opengsd/gsd-core', 'latest', { execFileSync: timingOutSpy }), null);
  });

  test('fc: ok is a pure function of appearAtMs vs the window, and the clock never passes it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }).map((n) => n * 1000),
        fc.integer({ min: 1, max: 20 }).map((n) => n * 1000),
        fc.integer({ min: 0, max: 120 }).map((n) => n * 1000),
        async (windowMs, intervalMs, appearAtMs) => {
          const clock = makeFakeClock();
          const fetchVersion = () => (appearAtMs <= clock.now() ? '1.15.0' : null);

          const result = await verifyPublish({
            pkg: '@opengsd/gsd-core',
            version: '1.15.0',
            fetchVersion,
            fetchDistTag: () => null,
            sleep: clock.sleep,
            now: clock.now,
            windowMs,
            intervalMs,
          });

          const lastAttemptTime = Math.floor(windowMs / intervalMs) * intervalMs;

          assert.equal(result.ok, appearAtMs <= lastAttemptTime);
          assert.ok(clock.now() <= windowMs, 'the injected clock must never be driven past the window');
        },
      ),
      { numRuns: 200 },
    );
  });
});
