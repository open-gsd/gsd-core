'use strict';

/**
 * Bug #410: finishInstall writes ~/.gsd/defaults.json for non-Claude runtimes
 * without a GSD_TEST_MODE guard, polluting the real developer home directory
 * during test runs.
 *
 * The opencode permission-config write a few lines above already carries the
 * GSD_TEST_MODE guard (added for #130) — this test covers the un-fixed sibling
 * (the resolve_model_ids: "omit" write).
 */

const { test, describe } = require('node:test');
const { cleanup } = require('./helpers.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// Point HOME at a temp dir so the defaults.json write can't reach the real
// ~/.gsd/ even if the guard is missing.
// On Windows, os.homedir() reads USERPROFILE (not HOME). Set both so
// finishInstall's path.join(os.homedir(), '.gsd') resolves into FAKE_HOME
// on every platform. Node docs: https://nodejs.org/docs/latest-v22.x/api/os.html#oshomedir
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-410-test-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

// The path that finishInstall would write to for a non-Claude runtime.
const GSD_DIR = path.join(FAKE_HOME, '.gsd');
const DEFAULTS_PATH = path.join(GSD_DIR, 'defaults.json');

// Set GSD_TEST_MODE before requiring install.js so any module-level guards
// also see the flag.
process.env.GSD_TEST_MODE = '1';

const installModule = require(path.join(ROOT, 'bin', 'install.js'));

// A synthetic settingsPath that won't exist — finishInstall should cope.
const SETTINGS_PATH = path.join(FAKE_HOME, `gsd-test-settings-${process.pid}.json`);

function callFinishInstallForRuntime(runtime) {
  const original = console.log;
  console.log = () => {};
  try {
    installModule.finishInstall(
      SETTINGS_PATH,
      {},       // empty settings
      null,     // statuslineCommand
      false,    // shouldInstallStatusline
      runtime,
      true,     // isGlobal
      null,     // configDir
    );
  } finally {
    console.log = original;
  }
}

describe('Bug #410: finishInstall non-Claude runtime + GSD_TEST_MODE side-effect guard', () => {
  test('defaults.json is NOT written for opencode runtime under GSD_TEST_MODE', () => {
    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      'defaults.json should not exist before finishInstall call',
    );

    callFinishInstallForRuntime('opencode');

    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      `defaults.json must NOT be created under GSD_TEST_MODE; found at ${DEFAULTS_PATH}`,
    );
  });

  test('defaults.json is NOT written for gemini runtime under GSD_TEST_MODE', () => {
    // Reset in case previous test left artifacts (it shouldn't).
    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      'defaults.json should not exist before gemini test',
    );

    callFinishInstallForRuntime('gemini');

    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      `defaults.json must NOT be created under GSD_TEST_MODE for gemini; found at ${DEFAULTS_PATH}`,
    );
  });

  test('defaults.json IS written for opencode runtime when GSD_TEST_MODE is unset', () => {
    // Temporarily unset GSD_TEST_MODE to verify the user-facing path still works.
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    try {
      callFinishInstallForRuntime('opencode');
      assert.equal(
        fs.existsSync(DEFAULTS_PATH),
        true,
        `defaults.json must be written for non-Claude runtime when GSD_TEST_MODE is unset`,
      );
      // Verify the written content is correct.
      const contents = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(contents.resolve_model_ids, 'omit', 'resolve_model_ids must be "omit"');
    } finally {
      // Restore GSD_TEST_MODE and clean up the written file.
      process.env.GSD_TEST_MODE = saved;
      cleanup(DEFAULTS_PATH);
      try { fs.rmdirSync(GSD_DIR); } catch { /* not empty or already gone */ }
    }
  });
});

// Bug #1569 folded here (sibling on the SAME finishInstall resolve_model_ids block):
// the #1156 default-to-"omit" step keyed its write on `!== "omit"`, so an explicit
// `resolve_model_ids: true` opt-in (resolveModelInternal returns full materialized
// model IDs) was silently clobbered across all 14 non-Claude runtimes. The fix
// preserves `true` and only defaults absent/falsy → "omit". Reuses the #410 harness.

describe('Bug #1569: non-Claude finishInstall preserves explicit resolve_model_ids:true', () => {
  function seedDefaults(obj) {
    fs.mkdirSync(GSD_DIR, { recursive: true });
    fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  function withUserPath(fn) {
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    try {
      return fn();
    } finally {
      process.env.GSD_TEST_MODE = saved;
    }
  }

  test('explicit resolve_model_ids:true survives a codex global install (the reported case)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', model_profile: 'balanced', resolve_model_ids: true });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        true,
        'explicit resolve_model_ids:true must be preserved across a codex install, not clobbered to "omit"',
      );
    });
  });

  // The clobber guard is runtime-agnostic (`runtime !== 'claude'`); parameterize
  // across a representative slice of non-Claude runtimes.
  for (const runtime of ['codex', 'opencode', 'gemini']) {
    test(`explicit resolve_model_ids:true survives a ${runtime} global install`, () => {
      withUserPath(() => {
        seedDefaults({ runtime, resolve_model_ids: true });
        callFinishInstallForRuntime(runtime);
        const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
        assert.equal(
          after.resolve_model_ids,
          true,
          `explicit resolve_model_ids:true must be preserved for ${runtime}`,
        );
      });
    });
  }

  test('absent resolve_model_ids still defaults to "omit" (preserves #1156 intent)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex' });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        'omit',
        'absent resolve_model_ids must still default to "omit" for non-Claude runtimes',
      );
    });
  });

  test('explicit resolve_model_ids:false still defaults to "omit"', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', resolve_model_ids: false });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(after.resolve_model_ids, 'omit', 'false must still be normalized to "omit"');
    });
  });

  test('non-canonical resolve_model_ids values (0, "", "yes", {}) default to "omit" — no Claude alias leak (#1569 codex review)', () => {
    // The domain is true/false/"omit"/absent. Any OTHER value is malformed; the safe
    // non-Claude default is "omit" (don't leak Claude aliases the runtime can't resolve).
    withUserPath(() => {
      for (const bad of [0, '', 'yes', {}]) {
        seedDefaults({ runtime: 'codex', resolve_model_ids: bad });
        callFinishInstallForRuntime('codex');
        const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
        assert.equal(
          after.resolve_model_ids,
          'omit',
          `non-canonical resolve_model_ids:${JSON.stringify(bad)} must default to "omit", not pass through`,
        );
      }
    });
  });

  test('already-"omit" is left unchanged (idempotent, no rewrite churn)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', resolve_model_ids: 'omit' });
      const beforeMtime = fs.statSync(DEFAULTS_PATH).mtimeMs;
      // fs mtime resolution can be coarse; wait briefly so an accidental rewrite is detectable.
      const start = Date.now();
      while (Date.now() - start < 20) { /* spin briefly */ }
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      const afterMtime = fs.statSync(DEFAULTS_PATH).mtimeMs;
      assert.equal(after.resolve_model_ids, 'omit');
      assert.equal(
        afterMtime,
        beforeMtime,
        'defaults.json must not be rewritten when resolve_model_ids is already "omit" (idempotent)',
      );
    });
  });

  test('claude runtime never touches resolve_model_ids (cross-runtime parity)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'claude', resolve_model_ids: true });
      callFinishInstallForRuntime('claude');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        true,
        'claude install must never rewrite resolve_model_ids',
      );
    });
  });

  test('malformed defaults.json does not crash — still defaults to "omit"', () => {
    withUserPath(() => {
      fs.mkdirSync(GSD_DIR, { recursive: true });
      fs.writeFileSync(DEFAULTS_PATH, '{ not valid json }', 'utf8');
      // Must not throw.
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        'omit',
        'malformed defaults.json must be recovered to a valid state with resolve_model_ids:omit',
      );
    });
  });
});

// Bug #1657 — finishInstall reads ~/.gsd/defaults.json with JSON.parse but did not
// validate the result is a plain object. A valid-JSON-but-non-object value (null, [],
// 42, "str") bypassed the catch and flowed through, leaving the malformed file on disk
// unrecovered (and, for null, throwing a TypeError swallowed by the outer try/catch).
// Folded into the owning install-defaults test (no new top-level bug-NNNN file).
describe('Bug #1657: finishInstall recovers a malformed (non-object) defaults.json', () => {
  function seedDefaultsRaw(raw) {
    fs.mkdirSync(GSD_DIR, { recursive: true });
    fs.writeFileSync(DEFAULTS_PATH, raw, 'utf8');
  }
  function runAndRead(runtime) {
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    const log = console.log; console.log = () => {};
    let threw = null;
    try {
      installModule.finishInstall(SETTINGS_PATH, {}, null, false, runtime, true, null);
    } catch (e) { threw = e.message; } finally { console.log = log; process.env.GSD_TEST_MODE = saved; }
    let after = null;
    try { after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')); } catch (e) { after = 'UNPARSEABLE: ' + e.message; }
    return { threw, after };
  }

  for (const [label, raw] of [['null', 'null'], ['array', '[]'], ['number', '42'], ['string', '"oops"']]) {
    test(`seed ${label} (${raw}) recovers to a valid object with resolve_model_ids:omit`, () => {
      seedDefaultsRaw(raw);
      const { threw, after } = runAndRead('codex');
      assert.equal(threw, null, `must not throw for seed ${label} (got: ${threw})`);
      assert.equal(
        after !== null && typeof after === 'object' && !Array.isArray(after) && after.resolve_model_ids === 'omit',
        true,
        `seed ${label} must recover to { resolve_model_ids: 'omit' }, got: ${JSON.stringify(after)}`,
      );
    });
  }
});
