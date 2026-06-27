/**
 * Tests for the assumption-delta detector (#1561).
 *
 * The detector is a pure function over phase-scope text that returns a typed
 * IR ({ detected, signals, terms }). Tests assert on the IR — never on
 * rendered prose — per RULESET.TESTS (no raw text matching on outputs).
 *
 * The detector mirrors ui-safety-gate.cts: a pure function plus a STDIN-reading
 * CLI (exit 0 = signal detected, 1 = none, 2 = usage error).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'assumption-delta.cjs');

describe('detectAssumptionDelta — pure detector (#1561)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    // Surface a clear failure if build:lib has not run yet.
    throw new Error(
      `Could not require ${MODULE_PATH}. Run "npm run build:lib" first. Underlying: ${err.message}`
    );
  }

  const { detectAssumptionDelta, DEFAULT_ASSUMPTION_DELTA_TERMS } = mod;

  test('result shape — always carries detected, signals[], terms', () => {
    const r = detectAssumptionDelta('refactor the login function');
    assert.strictEqual(r.detected, false);
    assert(Array.isArray(r.signals));
    assert.strictEqual(r.signals.length, 0);
    assert.ok(r.terms && Array.isArray(r.terms.pluralization));
    assert.ok(Array.isArray(r.terms.optional));
    assert.ok(Array.isArray(r.terms.chosen));
  });

  test('terms echo is the effective term set actually used', () => {
    const r = detectAssumptionDelta('nothing here');
    assert.deepStrictEqual(r.terms.pluralization, [...DEFAULT_ASSUMPTION_DELTA_TERMS.pluralization]);
    assert.deepStrictEqual(r.terms.optional, [...DEFAULT_ASSUMPTION_DELTA_TERMS.optional]);
    assert.deepStrictEqual(r.terms.chosen, [...DEFAULT_ASSUMPTION_DELTA_TERMS.chosen]);
  });

  // ── Primary trigger: pluralization ───────────────────────────────────────
  for (const cue of ['second auth method', 'alternative platform', 'fallback provider', 'also support a second region', 'an additional source of truth']) {
    test(`pluralization fires on: "${cue}"`, () => {
      const r = detectAssumptionDelta(cue);
      assert.strictEqual(r.detected, true, `expected detection for: ${cue}`);
      assert.ok(r.signals.some((s) => s.kind === 'pluralization'), `expected a pluralization signal for: ${cue}`);
    });
  }

  // ── Secondary trigger: required → optional ───────────────────────────────
  for (const cue of ['the field becomes optional', 'optionally omitted', 'may be optional now']) {
    test(`optional fires on: "${cue}"`, () => {
      const r = detectAssumptionDelta(cue);
      assert.strictEqual(r.detected, true, `expected detection for: ${cue}`);
      assert.ok(r.signals.some((s) => s.kind === 'optional'), `expected an optional signal for: ${cue}`);
    });
  }

  // ── Secondary trigger: derived → chosen / constant → parameter ───────────
  for (const cue of ['value is chosen by the caller', 'now configurable per tenant', 'parameterized at runtime', 'selectable in settings']) {
    test(`chosen fires on: "${cue}"`, () => {
      const r = detectAssumptionDelta(cue);
      assert.strictEqual(r.detected, true, `expected detection for: ${cue}`);
      assert.ok(r.signals.some((s) => s.kind === 'chosen'), `expected a chosen signal for: ${cue}`);
    });
  }

  // ── No-signal phases do NOT fire (acceptance criterion #2 — low FP) ───────
  for (const clean of ['refactor the login function', 'add a unit test for the parser', 'fix the off-by-one in the loop', 'update the README install steps']) {
    test(`no-signal phase does NOT fire: "${clean}"`, () => {
      const r = detectAssumptionDelta(clean);
      assert.strictEqual(r.detected, false, `false positive on: ${clean}`);
      assert.strictEqual(r.signals.length, 0);
    });
  }

  // ── FALSE-POSITIVE GUARD: bare "or" in prose must NOT fire ────────────────
  // The issue lists "or" as a tell, but bare "or" is extremely common in
  // English prose and would make the gate fire constantly. The default term
  // set intentionally excludes bare "or"; pluralization requires a stronger
  // second-case cue (second/alternative/fallback/also/additional/...).
  test('FALSE-POSITIVE GUARD: bare "or" in normal prose does NOT fire', () => {
    const r = detectAssumptionDelta('refactor or rewrite the module to be cleaner');
    assert.strictEqual(r.detected, false, 'bare "or" must not fire — it would make every English sentence trip the gate');
  });

  // ── FALSE-POSITIVE GUARD: trigger term inside a fenced code block ─────────
  // A code snippet mentioning "fallback" is not a pluralization of an
  // architectural concept. Fenced blocks are stripped before scanning.
  test('FALSE-POSITIVE GUARD: trigger term inside a fenced code block does NOT fire', () => {
    const scope = [
      'Add a retry helper to the client.',
      '',
      '```js',
      'const fallback = () => retry(); // internal var name',
      '```',
      '',
      'No architectural change here.',
    ].join('\n');
    const r = detectAssumptionDelta(scope);
    assert.strictEqual(r.detected, false, 'a trigger term appearing only inside a fenced code block must not fire');
  });

  // ── A real signal in prose still fires even when a code block is present ──
  test('signal in prose fires even when an unrelated fenced block is present', () => {
    const scope = [
      'This phase adds a second platform alongside the existing one.',
      '',
      '```js',
      'const x = 1;',
      '```',
    ].join('\n');
    const r = detectAssumptionDelta(scope);
    assert.strictEqual(r.detected, true);
    assert.ok(r.signals.some((s) => s.kind === 'pluralization'));
  });

  // ── signal carries a usable context snippet ──────────────────────────────
  test('each signal carries a non-empty snippet with context', () => {
    const r = detectAssumptionDelta('This phase introduces a second authentication method.');
    assert.strictEqual(r.detected, true);
    const sig = r.signals[0];
    assert.ok(typeof sig.snippet === 'string' && sig.snippet.length > 0);
    assert.ok(sig.snippet.toLowerCase().includes(sig.term), 'snippet should contain the matched term');
  });

  // ── CRLF resilience ───────────────────────────────────────────────────────
  test('CRLF line endings are handled identically to LF', () => {
    const lf = detectAssumptionDelta('adds a second region\r\nalso configurable');
    const crlf = detectAssumptionDelta('adds a second region\nalso configurable');
    assert.strictEqual(lf.detected, true);
    assert.strictEqual(crlf.detected, true);
    assert.strictEqual(lf.signals.length, crlf.signals.length);
  });

  // ── empty / whitespace / non-string inputs degrade to detected:false ──────
  test('empty string → detected:false', () => {
    assert.strictEqual(detectAssumptionDelta('').detected, false);
  });
  test('whitespace-only → detected:false', () => {
    assert.strictEqual(detectAssumptionDelta('   \n\t  ').detected, false);
  });
  test('non-string (null/undefined/number) → detected:false, no throw', () => {
    assert.strictEqual(detectAssumptionDelta(null).detected, false);
    assert.strictEqual(detectAssumptionDelta(undefined).detected, false);
    assert.strictEqual(detectAssumptionDelta(42).detected, false);
  });

  // ── custom term set overrides defaults (config-tunable vocabulary) ────────
  test('custom term set overrides defaults', () => {
    const custom = { pluralization: ['xyzzy'], optional: [], chosen: [] };
    const r = detectAssumptionDelta('this phase adds a second platform', custom);
    assert.strictEqual(r.detected, false, 'default cue "second" must not fire when defaults are overridden');
    assert.deepStrictEqual(r.terms.pluralization, ['xyzzy']);
    const r2 = detectAssumptionDelta('introduces an xyzzy adapter', custom);
    assert.strictEqual(r2.detected, true);
    assert.ok(r2.signals.some((s) => s.term === 'xyzzy'));
  });

  test('partial custom term set merges over defaults per-kind (absent kinds keep defaults)', () => {
    const partial = { pluralization: ['second'] };
    const r = detectAssumptionDelta('now optional', partial);
    assert.strictEqual(r.detected, true, 'optional defaults still apply when only pluralization was overridden');
    assert.ok(r.signals.some((s) => s.kind === 'optional'));
  });
});

describe('assumption-delta CLI — STDIN exit codes (mirrors ui-safety-gate)', () => {
  // Exit code contract: 0 = signal detected, 1 = none, 2 = usage/startup error.
  function runCli(stdin) {
    const res = spawnSync(process.execPath, [MODULE_PATH], {
      input: stdin,
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  test('exit 0 when a pluralization signal is present', () => {
    const r = runCli('This phase adds a second platform alongside the existing one.');
    assert.strictEqual(r.status, 0);
  });

  test('exit 1 when no signal is present', () => {
    const r = runCli('Refactor the login function to be smaller.');
    assert.strictEqual(r.status, 1);
  });

  test('exit 1 on empty stdin (no signal)', () => {
    const r = runCli('');
    assert.strictEqual(r.status, 1);
  });

  test('--json emits typed IR with detected field on stdout (exit 0)', () => {
    const res = spawnSync(process.execPath, [MODULE_PATH, '--json'], {
      input: 'introduces a configurable retry policy',
      encoding: 'utf-8',
      timeout: 15000,
    });
    assert.strictEqual(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.detected, true);
    assert.ok(Array.isArray(parsed.signals));
    assert.ok(parsed.signals.some((s) => s.kind === 'chosen'));
  });

  test('--json emits detected:false on stdout (exit 1) for no-signal input', () => {
    const res = spawnSync(process.execPath, [MODULE_PATH, '--json'], {
      input: 'just a routine refactor',
      encoding: 'utf-8',
      timeout: 15000,
    });
    assert.strictEqual(res.status, 1);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.detected, false);
    assert.deepStrictEqual(parsed.signals, []);
  });

  // ── --terms config override (config-tunable vocabulary) ───────────────────
  test('--terms overrides the pluralization cues (custom term fires, default cue does not)', () => {
    // default cue "second" present, but overridden to "xyzzy" → must NOT fire
    const noFire = spawnSync(process.execPath, [MODULE_PATH, '--terms', 'xyzzy', '--json'], {
      input: 'adds a second platform',
      encoding: 'utf-8',
      timeout: 15000,
    });
    assert.strictEqual(noFire.status, 1);
    assert.strictEqual(JSON.parse(noFire.stdout).detected, false);

    const fire = spawnSync(process.execPath, [MODULE_PATH, '--terms', 'xyzzy', '--json'], {
      input: 'introduces an xyzzy adapter',
      encoding: 'utf-8',
      timeout: 15000,
    });
    assert.strictEqual(fire.status, 0);
    const parsed = JSON.parse(fire.stdout);
    assert.strictEqual(parsed.detected, true);
    assert.ok(parsed.signals.some((s) => s.term === 'xyzzy' && s.kind === 'pluralization'));
    // optional/chosen defaults are retained by the partial override
    assert.ok(parsed.terms.optional.length > 0, 'optional defaults retained under --terms override');
  });
});

// ─── Hardening (Codex Step-4 review fixes) ────────────────────────────────────
describe('assumption-delta hardening (Codex review)', () => {
  const { detectAssumptionDelta } = require(MODULE_PATH);

  test('normalizeTerms: punctuation-only / empty / dupe terms filtered; lowercased', () => {
    const r = detectAssumptionDelta('adds a second platform', {
      pluralization: ['second', 'second', '-', '', 'XYZZY'],
      optional: [],
      chosen: [],
    });
    // '-' (punct-only) and '' dropped; dupe 'second' collapsed; 'XYZZY'→'xyzzy'
    assert.deepStrictEqual(r.terms.pluralization, ['second', 'xyzzy']);
    // 'second' survived → detected
    assert.strictEqual(r.detected, true);
  });

  test('normalizeTerms: cap guards a huge/hostile term list (no giant regex / echo)', () => {
    const huge = Array.from({ length: 250 }, (_, i) => `cue${i}`);
    const r = detectAssumptionDelta('routine refactor', { pluralization: huge, optional: [], chosen: [] });
    assert.ok(r.terms.pluralization.length <= 200, `capped to <=200, got ${r.terms.pluralization.length}`);
    assert.strictEqual(r.detected, false);
  });

  test('punctuation-only term does NOT match prose punctuation as a signal', () => {
    // '-' as a term must not fire on "a - b" prose
    const r = detectAssumptionDelta('refactor the parser - keep behavior', {
      pluralization: ['-'],
      optional: [],
      chosen: [],
    });
    assert.strictEqual(r.detected, false, 'punctuation-only term must not produce a signal');
    assert.deepStrictEqual(r.terms.pluralization, []);
  });

  test('CLI --terms "" (empty) restores curated defaults (does NOT disable pluralization)', () => {
    const res = spawnSync(process.execPath, [MODULE_PATH, '--terms', '', '--json'], {
      input: 'adds a second platform',
      encoding: 'utf-8',
      timeout: 15000,
    });
    assert.strictEqual(res.status, 0, 'empty --terms must fall back to defaults → detected');
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.detected, true);
    assert.ok(parsed.terms.pluralization.includes('second'), 'default pluralization cues restored');
  });
});
