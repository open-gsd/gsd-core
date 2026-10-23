'use strict';

/**
 * #5594: tests/verification-status.test.cjs and
 * tests/adr857-core-without-capabilities.test.cjs read the developer's real
 * ~/.gsd (defaults.json -> the #3532 shadowed-defaults warning on stderr;
 * capabilities/ -> non-empty activeHooks), so their result depended on what was
 * installed on the machine running them.
 *
 * Each target is run as its own `node --test` child with an ambient HOME that
 * holds both leaks. It must give the same result as with an empty home.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, formatSeamResult } = require('./helpers/process-seam.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  createTempDir, cleanup, writeAmbientCapabilityGate, installSpawnEnv, TEST_HOME_SANDBOX_MARKER,
} = require('./helpers.cjs');

// The #4142 describe is the one verification-status test that parses gsd-tools
// stderr as JSON (the #5118 helper skips leading non-JSON lines, and the other
// suites read stdout); the adr857 file is run whole.
const TARGETS = [
  { file: 'verification-status.test.cjs', namePattern: '#4142' },
  { file: 'adr857-core-without-capabilities.test.cjs', namePattern: null },
];

const homes = [];
afterEach(() => {
  while (homes.length) cleanup(homes.pop());
});

function makeHome({ populated }) {
  const home = createTempDir('gsd-5594-home-');
  homes.push(home);
  if (populated) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    // model_profile is a key a project config shadows -> the #3532 warning.
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({ model_profile: 'quality' }));
    writeAmbientCapabilityGate(home, 'ambient-5594', 'plan:pre');
  }
  return home;
}

function runTargetUnderHome({ file, namePattern }, home) {
  // installSpawnEnv scrubs the config-location keys; the marker names the redirected
  // home for src/real-home-guard.cts on hosts with no readable passwd entry.
  const env = installSpawnEnv({ HOME: home, USERPROFILE: home, [TEST_HOME_SANDBOX_MARKER]: home });
  delete env.NODE_TEST_CONTEXT; // run as a root test process, not a subtest of this one
  const args = ['--test', '--test-reporter=tap'];
  if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
  args.push(path.join(__dirname, file));
  const result = runNode(args, { cwd: path.join(__dirname, '..'), env, timeoutMs: INSTALL_TIMEOUT_MS });
  const count = (label) => {
    const m = new RegExp(`^# ${label} (\\d+)\\r?$`, 'm').exec(result.stdout);
    return m ? Number(m[1]) : null;
  };
  return { result, pass: count('pass'), fail: count('fail') };
}

// The empty-home run is the control for both tests of a target; run it once.
const emptyRuns = new Map();
function emptyHomeRun(target) {
  if (!emptyRuns.has(target.file)) emptyRuns.set(target.file, runTargetUnderHome(target, makeHome({ populated: false })));
  return emptyRuns.get(target.file);
}

describe('#5594 test files are hermetic against the host HOME', () => {
  for (const target of TARGETS) {
    const { file } = target;
    test(`${file} passes with an empty home (control)`, () => {
      const run = emptyHomeRun(target);
      assert.equal(run.fail, 0, `${formatSeamResult(run.result)}\n${run.result.stdout.slice(-3000)}`);
      assert.ok(run.pass > 0, `${file}: no tests executed`);
    });

    test(`${file} gives the same result with a defaults file and a user capability in HOME`, () => {
      const empty = emptyHomeRun(target);
      const populated = runTargetUnderHome(target, makeHome({ populated: true }));
      assert.equal(populated.fail, 0, `${formatSeamResult(populated.result)}\n${populated.result.stdout.slice(-3000)}`);
      assert.equal(populated.pass, empty.pass, `${file}: pass count differs between empty and populated home`);
    });
  }
});
