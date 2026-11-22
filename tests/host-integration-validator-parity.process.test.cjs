'use strict';

/**
 * Process-start cases of tests/host-integration-validator-parity.test.cjs
 * (#4561). What gsd-tools does on a lib compiled before
 * src/dispatch-isolation.cts existed is decided by what Node resolves when a
 * process loads it, so the case here starts one: a NODE_OPTIONS preload hides
 * the owner from the two hand-written consumers, and only a new process reads
 * a preload. The vocabulary cases live in the unit file and run in-process.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdToolsProcess, createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');

describe('#4561: a stale lib is what a new process loads, so this case starts processes', () => {
  test('a lib built before the owner existed: a command that loads neither the owner nor the validator still runs, and one that loads either names the build:lib remedy', (t) => {
    // ensureRuntimeBuild's fast path keys on one sentinel, so a lib compiled
    // before src/dispatch-isolation.cts existed reads as built. Reproduce that
    // tree with a preload that refuses the owner to the two HAND-WRITTEN
    // consumers only; a stale tree's compiled siblings predate the owner and
    // never ask for it.
    const tmp = createTempDir('gsd-4561-stale-lib-');
    t.after(() => cleanup(tmp));
    const preload = path.join(tmp, 'hide-owner.cjs');
    fs.writeFileSync(preload, [
      "const Module = require('module');",
      'const orig = Module._resolveFilename;',
      'Module._resolveFilename = function (request, parent, ...rest) {',
      "  if (/dispatch-isolation\\.cjs$/.test(request) && parent && /(gsd-tools|capability-validator)\\.cjs$/.test(parent.filename || '')) {",
      "    const e = new Error(`Cannot find module '${request}'`); e.code = 'MODULE_NOT_FOUND'; throw e;",
      '  }',
      '  return orig.call(this, request, parent, ...rest);',
      '};',
      '',
    ].join('\n'));
    const env = { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };

    const unrelated = runGsdToolsProcess(['current-timestamp', '--raw'], tmp, env);
    assert.equal(unrelated.success, true, `a command that loads neither the owner nor the validator must still run on that tree: ${unrelated.error}`);

    // capability-source.cjs requires the validator at load, so whatever
    // reaches it stops with the validator's remedy rather than running. It is
    // required directly: through gsd-tools, a current compiled sibling (here
    // host-integration.cjs) loads the owner first and Node's resolve cache then
    // answers the validator, which a stale sibling that predates the owner
    // never does.
    const capabilitySource = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-source.cjs');
    const validatorLoad = runNode(['-e', `require(${JSON.stringify(capabilitySource)})`], {
      cwd: tmp, env: { ...process.env, ...env },
    });
    assert.notEqual(validatorLoad.exitCode, 0, 'a module that requires the validator cannot load on that tree');
    assert.match(validatorLoad.stderr, /capability-validator: the compiled runtime lib \.\/dispatch-isolation\.cjs is missing[\s\S]*npm run build:lib/);

    // The query and inspect verbs too: their resolver turns errors into a
    // successful `none`, and dispatch-isolation-gate.md reads rc 0 + `none` as
    // "the runtime declares no isolation primitive". A stale lib is a failure
    // to resolve, so it must exit non-zero instead.
    for (const verb of [
      ['record-dispatch-isolation', '--isolation', 'none'],
      ['query', 'dispatch-isolation', '--raw'],
      ['query', 'inspect-dispatch-isolation', '--raw'],
    ]) {
      const needsOwner = runGsdToolsProcess(verb, tmp, env);
      assert.equal(needsOwner.success, false, `${verb.join(' ')} cannot answer without the owner: ${needsOwner.output}`);
      assert.match(needsOwner.error, /dispatch-isolation\.cjs is missing[\s\S]*npm run build:lib/, `${verb.join(' ')} names the remedy, not a bare Cannot find module`);
    }
  });
});
