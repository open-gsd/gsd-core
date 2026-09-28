'use strict';

/**
 * Tests for scripts/lint-test-file-count.cjs
 *
 * Uses node --test + the exported evaluateLint() pure function.
 * Also exercises the CLI via --json mode to verify end-to-end wiring.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const LINT_SCRIPT = path.join(ROOT, 'scripts', 'lint-test-file-count.cjs');

const {
  Verdict,
  evaluateLint,
  testEffectivePrefix,
  isSplitSibling,
  _buildTestMap,
} = require(LINT_SCRIPT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFiles(prefix, names) {
  return names.map(n => `/fake/tests/${n}`);
}

function runCliJson(extraArgs = []) {
  const result = runNode(
    [LINT_SCRIPT, '--json', ...extraArgs],
    { timeoutMs: PROBE_TIMEOUT_MS }
  );
  const parsed = JSON.parse(result.stdout);
  return { status: result.exitCode, data: parsed };
}

// ---------------------------------------------------------------------------
// evaluateLint — core verdict logic
// ---------------------------------------------------------------------------

describe('evaluateLint — OK_UNDER_LIMIT', () => {
  test('1-file module passes', () => {
    const result = evaluateLint({
      prefix: 'my-module',
      testFiles: makeFiles('my-module', ['my-module.test.cjs']),
      allowlist: {},
    });
    assert.strictEqual(result.verdict, Verdict.OK_UNDER_LIMIT);
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.knownFiles, null);
  });

  test('2-file module passes (primary + integration)', () => {
    const result = evaluateLint({
      prefix: 'my-module',
      testFiles: makeFiles('my-module', [
        'my-module.test.cjs',
        'my-module.integration.test.ts',
      ]),
      allowlist: {},
    });
    assert.strictEqual(result.verdict, Verdict.OK_UNDER_LIMIT);
    assert.strictEqual(result.count, 2);
  });
});

describe('evaluateLint — FAIL_EXCEEDS_LIMIT', () => {
  test('3-file module fails when not in allowlist', () => {
    const result = evaluateLint({
      prefix: 'my-module',
      testFiles: makeFiles('my-module', [
        'my-module.test.cjs',
        'my-module-edge-case.test.cjs',
        'my-module-regression.test.cjs',
      ]),
      allowlist: {},
    });
    assert.strictEqual(result.verdict, Verdict.FAIL_EXCEEDS_LIMIT);
    assert.strictEqual(result.count, 3);
    assert.strictEqual(result.knownFiles, null);
  });
});

describe('evaluateLint — allowlist behaviour (identity-based)', () => {
  test('3-file module allowlisted with exact filenames passes (OK_IN_ALLOWLIST)', () => {
    const result = evaluateLint({
      prefix: 'phase',
      testFiles: makeFiles('phase', [
        'phase.test.cjs',
        'phase-edge.test.cjs',
        'phase-regression.test.cjs',
      ]),
      allowlist: {
        phase: {
          files: ['phase.test.cjs', 'phase-edge.test.cjs', 'phase-regression.test.cjs'],
          issue: 'TBD',
        },
      },
    });
    assert.strictEqual(result.verdict, Verdict.OK_IN_ALLOWLIST);
    assert.strictEqual(result.count, 3);
    assert.deepStrictEqual(result.novel, []);
    assert.deepStrictEqual(result.stale, []);
  });

  test('2-file module allowlisted fails (FAIL_STALE_ALLOWLIST — whole entry must be pruned)', () => {
    const result = evaluateLint({
      prefix: 'phase',
      testFiles: makeFiles('phase', [
        'phase.test.cjs',
        'phase-edge.test.cjs',
      ]),
      allowlist: {
        phase: {
          files: ['phase.test.cjs', 'phase-edge.test.cjs', 'phase-regression.test.cjs'],
          issue: 'TBD',
        },
      },
    });
    // Ratchet-DOWN: dropping to ≤ MAX_FILES while allowlisted is a FAILURE, not a hint.
    assert.strictEqual(result.verdict, Verdict.FAIL_STALE_ALLOWLIST);
    assert.strictEqual(result.count, 2);
    assert.deepStrictEqual(result.novel, []);
    // stale should list all known files (the entire entry must be removed)
    assert.deepStrictEqual(result.stale.sort(), [
      'phase-edge.test.cjs',
      'phase-regression.test.cjs',
      'phase.test.cjs',
    ]);
  });

  test('novel file added to capped module fails (FAIL_NOVEL_FILES)', () => {
    const result = evaluateLint({
      prefix: 'phase',
      testFiles: makeFiles('phase', [
        'phase.test.cjs',
        'phase-edge.test.cjs',
        'phase-regression.test.cjs',
        'phase-new-extra.test.cjs',   // <-- novel
      ]),
      allowlist: {
        phase: {
          files: ['phase.test.cjs', 'phase-edge.test.cjs', 'phase-regression.test.cjs'],
          issue: 'TBD',
        },
      },
    });
    assert.strictEqual(result.verdict, Verdict.FAIL_NOVEL_FILES);
    assert.deepStrictEqual(result.novel, ['phase-new-extra.test.cjs']);
    assert.deepStrictEqual(result.stale, []);
  });

  test('allowlisted file removed from disk while dropping to cap fails (FAIL_STALE_ALLOWLIST)', () => {
    const result = evaluateLint({
      prefix: 'phase',
      testFiles: makeFiles('phase', [
        'phase.test.cjs',
        'phase-edge.test.cjs',
        // phase-regression.test.cjs removed — count now at MAX_FILES (2)
      ]),
      allowlist: {
        phase: {
          files: ['phase.test.cjs', 'phase-edge.test.cjs', 'phase-regression.test.cjs'],
          issue: 'TBD',
        },
      },
    });
    // count is 2 (≤ MAX_FILES=2) while still allowlisted — ratchet-DOWN FAILURE.
    // All known files are stale; the entire entry must be pruned.
    assert.strictEqual(result.verdict, Verdict.FAIL_STALE_ALLOWLIST);
    assert.deepStrictEqual(result.novel, []);
    assert.deepStrictEqual(result.stale.sort(), [
      'phase-edge.test.cjs',
      'phase-regression.test.cjs',
      'phase.test.cjs',
    ]);
  });

  test('allowlisted file removed while still over cap fails (FAIL_STALE_ALLOWLIST)', () => {
    // Module has 4 files allowlisted, one removed (3 remain, still > 2)
    const result = evaluateLint({
      prefix: 'phase',
      testFiles: makeFiles('phase', [
        'phase.test.cjs',
        'phase-edge.test.cjs',
        'phase-regression.test.cjs',
        // phase-extra.test.cjs removed from disk
      ]),
      allowlist: {
        phase: {
          files: [
            'phase.test.cjs',
            'phase-edge.test.cjs',
            'phase-regression.test.cjs',
            'phase-extra.test.cjs',   // stale
          ],
          issue: 'TBD',
        },
      },
    });
    assert.strictEqual(result.verdict, Verdict.FAIL_STALE_ALLOWLIST);
    assert.deepStrictEqual(result.stale, ['phase-extra.test.cjs']);
    assert.deepStrictEqual(result.novel, []);
  });

  test('ratchet: count equal to allowlisted set passes', () => {
    const result = evaluateLint({
      prefix: 'init',
      testFiles: makeFiles('init', [
        'init.test.cjs',
        'init-manager.test.cjs',
        'init-manager-deps.test.cjs',
      ]),
      allowlist: {
        init: {
          files: ['init.test.cjs', 'init-manager.test.cjs', 'init-manager-deps.test.cjs'],
          issue: 'TBD',
        },
      },
    });
    assert.strictEqual(result.verdict, Verdict.OK_IN_ALLOWLIST);
  });

  // -------------------------------------------------------------------
  // Masking blind spot: count unchanged but SET changed → must FAIL
  // -------------------------------------------------------------------
  test('masking blind spot closed: swapped file (same count, different identity) fails', () => {
    // Old allowlist grandfathers 3 files. One is deleted, one new one added.
    // Count stays at 3 — the old count-ratchet would have passed. Identity must fail.
    const result = evaluateLint({
      prefix: 'phase',
      testFiles: makeFiles('phase', [
        'phase.test.cjs',
        'phase-edge.test.cjs',
        'phase-brand-new.test.cjs',   // <-- replaces phase-regression (novel)
      ]),
      allowlist: {
        phase: {
          files: [
            'phase.test.cjs',
            'phase-edge.test.cjs',
            'phase-regression.test.cjs',   // <-- no longer on disk (stale)
          ],
          issue: 'TBD',
        },
      },
    });
    // The identity check must catch this: novel = ['phase-brand-new.test.cjs'],
    // stale = ['phase-regression.test.cjs']. Count is the same (3), but the
    // old count-ratchet would have silently passed. The identity ratchet fails.
    assert.ok(
      result.verdict === Verdict.FAIL_NOVEL_FILES || result.verdict === Verdict.FAIL_STALE_ALLOWLIST,
      `expected FAIL_NOVEL_FILES or FAIL_STALE_ALLOWLIST, got ${result.verdict}`
    );
    assert.deepStrictEqual(result.novel, ['phase-brand-new.test.cjs']);
    assert.deepStrictEqual(result.stale, ['phase-regression.test.cjs']);
  });
});

// ---------------------------------------------------------------------------
// #5074: .platform.test.cjs split siblings are excluded from the count
// ---------------------------------------------------------------------------

describe('evaluateLint — #5074 .platform.test.cjs split siblings', () => {
  test('module at cap with x.test.cjs + x.platform.test.cjs + integration stays OK_UNDER_LIMIT', () => {
    const result = evaluateLint({
      prefix: 'my-module',
      testFiles: makeFiles('my-module', [
        'my-module.test.cjs',
        'my-module.platform.test.cjs',
        'my-module.integration.test.cjs',
      ]),
      allowlist: {},
    });
    assert.strictEqual(result.verdict, Verdict.OK_UNDER_LIMIT);
    assert.strictEqual(result.count, 2);
  });

  test('allowlisted over-cap module gaining x.platform.test.cjs for allowlisted x.test.cjs stays OK_IN_ALLOWLIST', () => {
    const result = evaluateLint({
      prefix: 'phase',
      testFiles: makeFiles('phase', [
        'phase.test.cjs',
        'phase-edge.test.cjs',
        'phase-regression.test.cjs',
        'phase.platform.test.cjs',   // split sibling of phase.test.cjs — excluded
      ]),
      allowlist: {
        phase: {
          files: ['phase.test.cjs', 'phase-edge.test.cjs', 'phase-regression.test.cjs'],
          issue: 'TBD',
        },
      },
    });
    assert.strictEqual(result.verdict, Verdict.OK_IN_ALLOWLIST);
    assert.strictEqual(result.count, 3);
    assert.deepStrictEqual(result.novel, []);
    assert.deepStrictEqual(result.stale, []);
  });

  test('orphan y.platform.test.cjs with no y.test.cjs in the same dir still counts (FAIL_EXCEEDS_LIMIT)', () => {
    // Base fixture (no 'orphan.test.cjs' at all — the platform file's own
    // base is genuinely absent) sits at the MAX_FILES=2 cap and must pass on
    // its own; that's the control that proves the orphan file itself is what
    // tips this over, not some other file in the set.
    const baseFiles = ['orphan-a.test.cjs', 'orphan-edge.test.cjs'];
    const controlResult = evaluateLint({
      prefix: 'orphan',
      testFiles: makeFiles('orphan', baseFiles),
      allowlist: {},
    });
    assert.strictEqual(controlResult.verdict, Verdict.OK_UNDER_LIMIT,
      `precondition: base fixture without the orphan must be OK_UNDER_LIMIT, got ${controlResult.verdict}`);
    assert.strictEqual(controlResult.count, 2);

    const result = evaluateLint({
      prefix: 'orphan',
      testFiles: makeFiles('orphan', [
        ...baseFiles,
        'orphan.platform.test.cjs',   // no 'orphan.test.cjs' base present — not a sibling
      ]),
      allowlist: {},
    });
    assert.strictEqual(result.verdict, Verdict.FAIL_EXCEEDS_LIMIT);
    assert.strictEqual(result.count, 3);
  });

  test('orphan y.platform.test.cjs added to an allowlisted module is a novel file (FAIL_NOVEL_FILES)', () => {
    const result = evaluateLint({
      prefix: 'phase',
      testFiles: makeFiles('phase', [
        'phase.test.cjs',
        'phase-edge.test.cjs',
        'phase-regression.test.cjs',
        'phase-orphan.platform.test.cjs',   // no phase-orphan.test.cjs base — counts
      ]),
      allowlist: {
        phase: {
          files: ['phase.test.cjs', 'phase-edge.test.cjs', 'phase-regression.test.cjs'],
          issue: 'TBD',
        },
      },
    });
    assert.strictEqual(result.verdict, Verdict.FAIL_NOVEL_FILES);
    assert.deepStrictEqual(result.novel, ['phase-orphan.platform.test.cjs']);
  });

  test('bare platform.test.cjs (empty stem) is not treated as a sibling', () => {
    assert.strictEqual(isSplitSibling('platform.test.cjs', ['platform.test.cjs']), false);

    const result = evaluateLint({
      prefix: 'my-module',
      testFiles: makeFiles('my-module', [
        'my-module.test.cjs',
        'platform.test.cjs',   // bare, empty stem — not a sibling of anything
      ]),
      allowlist: {},
    });
    assert.strictEqual(result.verdict, Verdict.OK_UNDER_LIMIT);
    assert.strictEqual(result.count, 2);
  });
});

describe('isSplitSibling — pure helper', () => {
  test('recognizes a sibling when the base .test.cjs is present', () => {
    assert.strictEqual(
      isSplitSibling('state.platform.test.cjs', ['state.test.cjs', 'state.platform.test.cjs']),
      true
    );
  });

  test('recognizes a sibling when the base .test.ts is present', () => {
    assert.strictEqual(
      isSplitSibling('state.platform.test.cjs', ['state.test.ts', 'state.platform.test.cjs']),
      true
    );
  });

  test('does not recognize an orphan with no base file', () => {
    assert.strictEqual(
      isSplitSibling('state.platform.test.cjs', ['state.platform.test.cjs']),
      false
    );
  });

  test('non-platform test file is never a sibling', () => {
    assert.strictEqual(
      isSplitSibling('state.test.cjs', ['state.test.cjs', 'state.platform.test.cjs']),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// _buildTestMap — longest-prefix bucketing (order-independence)
// ---------------------------------------------------------------------------

describe('_buildTestMap — longest-prefix bucketing', () => {
  // Regression for readdirSync-order-dependent bucketing: `verify.cjs` and
  // `verify-command-grounding.cjs` are production modules where one name is a
  // hyphen-extension of the other. fs.readdirSync order is not stable across
  // platforms (e.g. Linux ext4 hash order vs macOS HFS+/APFS), so
  // `prodPrefixes` (a Map built from readdirSync) can iterate in either
  // order. A test file matching the longer, more specific prefix must always
  // bucket there — never fall through to the shorter prefix — regardless of
  // which key the Map visits first.
  const testFile = makeFiles('verify-command-grounding', ['verify-command-grounding.test.cjs'])[0];

  test('buckets to the longer prefix when the short prefix is visited first', () => {
    const prodPrefixes = new Map([
      ['verify', '/fake/src/verify.cjs'],
      ['verify-command-grounding', '/fake/src/verify-command-grounding.cjs'],
    ]);
    const map = _buildTestMap(prodPrefixes, [testFile]);
    assert.deepStrictEqual(map.get('verify-command-grounding'), [testFile]);
    assert.deepStrictEqual(map.get('verify'), []);
  });

  test('buckets to the longer prefix when the long prefix is visited first', () => {
    const prodPrefixes = new Map([
      ['verify-command-grounding', '/fake/src/verify-command-grounding.cjs'],
      ['verify', '/fake/src/verify.cjs'],
    ]);
    const map = _buildTestMap(prodPrefixes, [testFile]);
    assert.deepStrictEqual(map.get('verify-command-grounding'), [testFile]);
    assert.deepStrictEqual(map.get('verify'), []);
  });
});

// ---------------------------------------------------------------------------
// testEffectivePrefix — issue-stamp stripping
// ---------------------------------------------------------------------------

describe('testEffectivePrefix', () => {
  test('normal test file returns bare prefix', () => {
    assert.strictEqual(testEffectivePrefix('query-dispatch.test.cjs'), 'query-dispatch');
  });

  test('integration test file returns bare prefix', () => {
    assert.strictEqual(testEffectivePrefix('init.integration.test.ts'), 'init');
  });

  test('bug-stamped file strips stamp', () => {
    assert.strictEqual(testEffectivePrefix('bug-1736-local-install-commands.test.cjs'), 'local-install-commands');
  });

  test('feat-stamped file strips stamp', () => {
    assert.strictEqual(testEffectivePrefix('feat-3347-graphify-auto-update-config.test.cjs'), 'graphify-auto-update-config');
  });

  test('enh-stamped file strips stamp', () => {
    assert.strictEqual(testEffectivePrefix('enh-100-phase-runner-edge.test.cjs'), 'phase-runner-edge');
  });

  test('fix-stamped file strips stamp', () => {
    assert.strictEqual(testEffectivePrefix('fix-200-config-merge.test.cjs'), 'config-merge');
  });

  test('double-numbered stamp is stripped correctly', () => {
    assert.strictEqual(testEffectivePrefix('bug-2550-2552-discuss-phase-context.test.cjs'), 'discuss-phase-context');
  });

  // -------------------------------------------------------------------
  // #3227: trailing suite/kind qualifier stripping
  // -------------------------------------------------------------------
  test('dotted suite-qualifier file resolves to the bare module prefix', () => {
    assert.strictEqual(testEffectivePrefix('frontmatter.property.test.cjs'), 'frontmatter');
  });

  test('unqualified file with a hyphenated module name is unaffected (no-op)', () => {
    assert.strictEqual(testEffectivePrefix('state-contract.test.cjs'), 'state-contract');
  });

  test('pre-existing .integration.test. strip still works after the qualifier strip', () => {
    assert.strictEqual(
      testEffectivePrefix('installer-migration-install.integration.test.cjs'),
      'installer-migration-install'
    );
  });
});

// ---------------------------------------------------------------------------
// #3227: dotted suite-qualifier files must not mis-bucket into a shorter,
// hyphen-related module (e.g. state-contract.unit.test.cjs -> state).
// ---------------------------------------------------------------------------

describe('_buildTestMap — dotted suite-qualifier bucketing (#3227)', () => {
  test('state-contract.unit.test.cjs buckets to state-contract, not the shorter state module', () => {
    const testFile = makeFiles('state-contract', ['state-contract.unit.test.cjs'])[0];
    const prodPrefixes = new Map([
      ['state', '/fake/src/state.cjs'],
      ['state-contract', '/fake/src/state-contract.cjs'],
    ]);
    const map = _buildTestMap(prodPrefixes, [testFile]);
    assert.deepStrictEqual(map.get('state-contract'), [testFile]);
    assert.deepStrictEqual(map.get('state'), []);
  });
});

// ---------------------------------------------------------------------------
// CLI — JSON mode end-to-end
// ---------------------------------------------------------------------------

describe('CLI --json', () => {
  test('script parses without syntax errors', () => {
    const result = runNode(['--check', LINT_SCRIPT], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.exitCode, 0, result.stderr);
  });

  test('exits 0 against real repo (allowlist covers all current violations)', () => {
    const { status, data } = runCliJson();
    assert.strictEqual(status, 0, `Expected clean run; failures: ${JSON.stringify(data.failures)}`);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.failures.length, 0);
  });

  test('--json output has required fields', () => {
    const { data } = runCliJson();
    assert.ok(Array.isArray(data.results), 'results must be array');
    assert.ok(Array.isArray(data.failures), 'failures must be array');
    assert.ok(Array.isArray(data.hints), 'hints must be array');
    assert.ok(typeof data.ok === 'boolean', 'ok must be boolean');
  });

  test('each result has verdict, prefix, count, knownFiles, files', () => {
    const { data } = runCliJson();
    for (const r of data.results) {
      assert.ok(typeof r.verdict === 'string', `verdict missing on ${r.prefix}`);
      assert.ok(typeof r.prefix === 'string', 'prefix must be string');
      assert.ok(typeof r.count === 'number', 'count must be number');
      assert.ok(Array.isArray(r.files), 'files must be array');
    }
  });

  test('all verdicts are valid enum values', () => {
    const valid = new Set(Object.values(Verdict));
    const { data } = runCliJson();
    for (const r of data.results) {
      assert.ok(valid.has(r.verdict), `Unknown verdict "${r.verdict}" on prefix "${r.prefix}"`);
    }
  });

  test('OK_IN_ALLOWLIST results have knownFiles array', () => {
    const { data } = runCliJson();
    const allowlisted = data.results.filter(r => r.verdict === Verdict.OK_IN_ALLOWLIST);
    assert.ok(allowlisted.length > 0, 'expected at least one allowlisted module in real repo');
    for (const r of allowlisted) {
      assert.ok(Array.isArray(r.knownFiles), `knownFiles must be array on ${r.prefix}`);
      assert.ok(r.knownFiles.length > 0, `knownFiles must be non-empty on ${r.prefix}`);
    }
  });
});
