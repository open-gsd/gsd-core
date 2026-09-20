'use strict';

// Regression tests for #2717: cursor, windsurf, and codex stage `.js` hook
// scripts via dedicated paths that bypass installSharedHooksBundle (the only
// writer of the {"type":"commonjs"} marker). Under a config root declaring
// {"type":"module"}, Node loaded those scripts as ESM and every require() failed
// with "require is not defined", silently disabling the runtime's lifecycle
// hooks.
//
// These tests assert the invariant structurally: whenever a runtime stages one
// or more `.js` hooks into its GSD-owned hooks directory, a package.json forcing
// CommonJS mode exists in that SAME directory, and a require()-using hook
// actually loads under an ESM-typed parent.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const COMMONJS_MARKER = '{"type":"commonjs"}\n';

// Runtimes that stage `.js` hooks via the dedicated cursor/windsurf/codex paths
// (skipSharedHooksInstall or the !isCodex gate) — the three #2717 covers.
const AFFECTED_RUNTIMES = [
  { runtime: 'cursor', sampleHook: 'gsd-cursor-session-start.js' },
  { runtime: 'windsurf', sampleHook: 'gsd-windsurf-pre-write.js' },
  { runtime: 'codex', sampleHook: 'gsd-check-update.js' },
];

function readMarker(configDir) {
  const p = path.join(configDir, 'hooks', 'package.json');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

describe('#2717 CommonJS marker for staged .js hooks', () => {
  for (const { runtime, sampleHook } of AFFECTED_RUNTIMES) {
    test(`${runtime}: install writes {"type":"commonjs"} into hooks/ alongside the staged .js scripts`, (t) => {
      const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
      t.after(() => cleanup(root));

      // The sample hook must actually be staged (sanity — confirms the install
      // reached the dedicated .js-staging path for this runtime).
      const hookPath = path.join(configDir, 'hooks', sampleHook);
      assert.ok(
        fs.existsSync(hookPath),
        `${runtime} install must stage ${sampleHook} (got: ${fs.readdirSync(path.join(configDir, 'hooks')).join(',')})`,
      );

      // The marker must exist in the SAME directory, with GSD's exact content.
      const marker = readMarker(configDir);
      assert.strictEqual(
        marker,
        COMMONJS_MARKER,
        `${runtime}: hooks/package.json must be exactly {"type":"commonjs"}\\n so Node loads the staged .js hooks as CommonJS even when the config root declares {"type":"module"}`,
      );
    });
  }

  // Reproduces the exact failure mode in the issue: a config-root package.json
  // declaring {"type":"module"}. Pre-fix, Node walked up from the .js hook,
  // found this file, and loaded the hook as ESM → require() threw. Post-fix,
  // the GSD-written hooks/package.json is nearer and wins. The hook may exit
  // non-zero for benign reasons (no STATE.md, no config, etc.) — the ONLY
  // failure we gate on is the ESM/require error on stderr.
  function assertHookLoadsUnderEsmRoot(t, runtime, hookFile, stdinPayload) {
    const { configDir, root } = runMinimalInstall({ runtime, scope: 'global' });
    t.after(() => cleanup(root));

    // Plant the hostile ESM-typed package.json at the config root.
    fs.writeFileSync(path.join(configDir, 'package.json'), '{"type":"module"}\n');

    const hookPath = path.join(configDir, 'hooks', hookFile);
    assert.ok(fs.existsSync(hookPath), `${runtime} hook ${hookFile} must be staged`);

    let stderr = '';
    try {
      execFileSync(process.execPath, [hookPath], {
        cwd: root,
        input: stdinPayload,
        encoding: 'utf8',
        timeout: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // Non-zero exit is allowed (benign); capture stderr for the ESM check.
      stderr = String(e.stderr || '');
    }
    assert.ok(
      !/require is not defined/i.test(stderr),
      `${runtime} hook ${hookFile} must load as CommonJS under an ESM-typed config root; got ESM error:\n${stderr}`,
    );
  }

  test('cursor: a require()-using hook loads under an ESM-typed config root after install', (t) => {
    assertHookLoadsUnderEsmRoot(t, 'cursor', 'gsd-cursor-session-start.js', JSON.stringify({ workspace_roots: [] }));
  });

  test('codex: a require()-using hook loads under an ESM-typed config root after install', (t) => {
    // codex is the !isCodex-gated path most likely to regress (its marker write
    // lives in bin/install.js, not the surface). gsd-check-update.js uses
    // require() at module load, so it surfaces the ESM failure immediately.
    assertHookLoadsUnderEsmRoot(t, 'codex', 'gsd-check-update.js', '');
  });

  test('uninstall path: removeCommonJsMarkerIfGsdOwned removes only GSD-owned markers', (t) => {
    // The uninstall cleanup uses removeCommonJsMarkerIfGsdOwned (exported from
    // the runtime-hooks-surface). Assert its contract directly: it deletes a
    // GSD-written marker but never a user-authored package.json.
    const {
      removeCommonJsMarkerIfGsdOwned,
      ensureCommonJsMarker,
    } = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

    // Case 1: GSD-owned marker is removed.
    const dirA = createTempDir('gsd-2717-rmA-');
    t.after(() => cleanup(dirA));
    assert.ok(ensureCommonJsMarker(dirA), 'ensureCommonJsMarker writes the marker');
    const markerA = path.join(dirA, 'package.json');
    assert.strictEqual(fs.readFileSync(markerA, 'utf8'), COMMONJS_MARKER);
    assert.ok(removeCommonJsMarkerIfGsdOwned(dirA), 'removes a GSD-owned marker');
    assert.ok(!fs.existsSync(markerA), 'GSD-owned marker is gone');

    // Case 2: user-authored package.json is preserved.
    const dirB = createTempDir('gsd-2717-keepB-');
    t.after(() => cleanup(dirB));
    const userContent = '{"name":"user-owned","type":"module"}\n';
    fs.writeFileSync(path.join(dirB, 'package.json'), userContent);
    assert.ok(!removeCommonJsMarkerIfGsdOwned(dirB), 'does not remove a non-GSD package.json');
    assert.strictEqual(fs.readFileSync(path.join(dirB, 'package.json'), 'utf8'), userContent);

    // Case 3: no marker → no-op, no throw.
    const dirC = createTempDir('gsd-2717-noopC-');
    t.after(() => cleanup(dirC));
    assert.ok(!removeCommonJsMarkerIfGsdOwned(dirC), 'no-op when no marker exists');

    // Case 4: ensureCommonJsMarker is idempotent and does not clobber a user file.
    const dirD = createTempDir('gsd-2717-idemD-');
    t.after(() => cleanup(dirD));
    fs.writeFileSync(path.join(dirD, 'package.json'), userContent);
    assert.ok(!ensureCommonJsMarker(dirD), 'does not overwrite a user-authored package.json');
    assert.strictEqual(fs.readFileSync(path.join(dirD, 'package.json'), 'utf8'), userContent);
  });

  // #4759: the shared hooks path's `preserved-foreign` report used to make an
  // unconditional module-resolution claim ("GSD hooks may not resolve as
  // CommonJS") that is FALSE for the ordinary case — any foreign file that does
  // not declare {"type":"module"} leaves the staged .js hooks loading as
  // CommonJS (Node's default). The sibling plugin path
  // (src/install-engine.cts) words the same outcome conditionally; these tests
  // pin the hooks path to the same shape: name the ownership fact, and make
  // will-not-load conditional on "type": "module" — the only case where it is
  // true.
  test('#4759: preserved-foreign hooks marker warning must not claim the hooks may not load when the file declares commonjs', (t) => {
    const foreignCommonJs = '{\n  "type": "commonjs"\n}\n';
    const root = createTempDir('gsd-4759-commonjs-');
    // Register cleanup BEFORE the spawn: runMinimalInstall deliberately never
    // removes a caller-provided root, on the failure path either, so a spawn
    // failure must not leak the temp tree.
    t.after(() => cleanup(root));
    // Plant the foreign file BEFORE the install, at the config dir the global
    // install will resolve (RUNTIME_META.claude.globalSuffix = '.claude').
    const hooksDir = path.join(root, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'package.json'), foreignCommonJs);

    // The marker notice is a console.warn — stderr. Assert on the combined
    // output so a future stream change cannot silently vacate the guards
    // (precedent: tests/install.test.cjs merges stdout+stderr for installer
    // output assertions).
    const { configDir, stdout, stderr } = runMinimalInstall({ runtime: 'claude', scope: 'global', root });
    const output = stdout + stderr;
    assert.strictEqual(configDir, path.join(root, '.claude'));

    // Ownership behavior is NOT the bug — the foreign file stays byte-identical.
    assert.strictEqual(
      fs.readFileSync(path.join(configDir, 'hooks', 'package.json'), 'utf8'),
      foreignCommonJs,
      'the foreign package.json must be left untouched',
    );

    // The false claim must be gone.
    assert.ok(
      !output.includes('may not resolve as CommonJS'),
      `a foreign package.json declaring "type": "commonjs" must not be told the hooks may not load; output:\n${output}`,
    );
    // The preserved-foreign notice stays, now with the conditional wording.
    assert.ok(
      /Left existing hooks\/package\.json untouched \(not GSD's marker\)\. If it declares "type": "module", the staged hooks will not load\./.test(output),
      `expected the conditional preserved-foreign wording; output:\n${output}`,
    );
  });

  test('#4759: a module-typed foreign hooks package.json gets the conditional will-not-load warning', (t) => {
    const foreignEsm = '{\n  "type": "module"\n}\n';
    const root = createTempDir('gsd-4759-esm-');
    t.after(() => cleanup(root));
    const hooksDir = path.join(root, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'package.json'), foreignEsm);

    const { configDir, stdout, stderr } = runMinimalInstall({ runtime: 'claude', scope: 'global', root });
    const output = stdout + stderr;

    assert.strictEqual(
      fs.readFileSync(path.join(configDir, 'hooks', 'package.json'), 'utf8'),
      foreignEsm,
      'the foreign package.json must be left untouched',
    );
    // Still no UNCONDITIONAL may-claim — the will-not-load statement is carried
    // by the conditional sentence, which is true here and only here.
    assert.ok(
      !output.includes('may not resolve as CommonJS'),
      `the unconditional may-not-load claim must not come back; output:\n${output}`,
    );
    assert.ok(
      /If it declares "type": "module", the staged hooks will not load\./.test(output),
      `a "type": "module" foreign file must still get the conditional will-not-load warning; output:\n${output}`,
    );
  });

  test('#4759: a foreign hooks package.json with no type field gets the conditional wording, not the may-claim', (t) => {
    // No "type" field: Node defaults .js to CommonJS, so the hooks load — the
    // old unconditional claim was false here too, and this is arguably the most
    // common real file (any hand-authored package.json).
    const foreignNoType = '{\n  "name": "user-hooks"\n}\n';
    const root = createTempDir('gsd-4759-notype-');
    t.after(() => cleanup(root));
    const hooksDir = path.join(root, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'package.json'), foreignNoType);

    const { configDir, stdout, stderr } = runMinimalInstall({ runtime: 'claude', scope: 'global', root });
    const output = stdout + stderr;

    assert.strictEqual(
      fs.readFileSync(path.join(configDir, 'hooks', 'package.json'), 'utf8'),
      foreignNoType,
      'the foreign package.json must be left untouched',
    );
    assert.ok(
      !output.includes('may not resolve as CommonJS'),
      `a type-less foreign package.json must not be told the hooks may not load; output:\n${output}`,
    );
    assert.ok(
      /If it declares "type": "module", the staged hooks will not load\./.test(output),
      `expected the conditional preserved-foreign wording; output:\n${output}`,
    );
  });
});
